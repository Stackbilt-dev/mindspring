/**
 * Streaming JSON parser for large conversation files.
 *
 * Extracts top-level items from JSON arrays or objects without
 * loading the entire file into memory. Designed for Cloudflare
 * Workers' 128MB memory ceiling.
 *
 * Supports two formats:
 *   - Array:  [{conv1}, {conv2}, ...]
 *   - Object: {"key1": {conv1}, "key2": {conv2}, ...}
 *
 * Strategy: read chunks from a ReadableStream, track bracket depth
 * to isolate complete top-level JSON objects, parse each individually.
 * Peak memory is ~2x the largest single conversation object, not the
 * full file.
 */

export interface StreamParserCallbacks {
  /** Called for each complete top-level item parsed from the stream. */
  onItem: (item: Record<string, unknown>, index: number) => Promise<void>
  /** Called when parsing is complete. */
  onEnd: (totalItems: number) => Promise<void>
  /** Called on recoverable parse errors (skipped items). */
  onError?: (error: Error, rawChunk: string, index: number) => void
}

type RootType = 'array' | 'object' | null

/**
 * Stream-parse a ReadableStream of JSON bytes, yielding top-level items.
 *
 * This is the edge-native equivalent of Python's ijson. No dependencies.
 */
export async function streamParseJSON(
  stream: ReadableStream<Uint8Array>,
  callbacks: StreamParserCallbacks
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  let rootType: RootType = null
  let depth = 0
  let inString = false
  let escaped = false
  let itemBuffer = ''
  let itemIndex = 0
  let rootObjectKeyPhase = false // true when scanning for a key in root object

  // Characters we need to skip between items at the root level of an object:
  // the "key": portion before each value
  let skipUntilValue = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })

      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i]

        // Detect root container type from the first structural char
        if (rootType === null) {
          if (char === '[') {
            rootType = 'array'
            continue
          } else if (char === '{') {
            rootType = 'object'
            skipUntilValue = true
            continue
          } else if (isWhitespace(char)) {
            continue
          } else {
            throw new Error(
              `Invalid JSON: expected [ or { at root, got '${char}'`
            )
          }
        }

        // Root-level object: skip "key": to get to the value
        if (rootType === 'object' && skipUntilValue && depth === 0) {
          if (char === ':') {
            skipUntilValue = false
            continue
          }
          // Skip key string, whitespace, commas at root level
          continue
        }

        // Handle string state (track whether we're inside a JSON string)
        if (inString) {
          itemBuffer += char
          if (escaped) {
            escaped = false
          } else if (char === '\\') {
            escaped = true
          } else if (char === '"') {
            inString = false
          }
          continue
        }

        // Outside of strings: structural characters
        if (char === '"') {
          inString = true
          itemBuffer += char
          continue
        }

        if (char === '{' || char === '[') {
          depth++
          itemBuffer += char
          continue
        }

        if (char === '}' || char === ']') {
          // Closing the root container
          if (depth === 0) {
            // We're done — this is the final ] or }
            break
          }

          depth--
          itemBuffer += char

          // A complete top-level item
          if (depth === 0) {
            const trimmed = itemBuffer.trim()
            if (trimmed) {
              try {
                const parsed = JSON.parse(trimmed)
                await callbacks.onItem(parsed, itemIndex)
              } catch (err) {
                callbacks.onError?.(
                  err instanceof Error ? err : new Error(String(err)),
                  trimmed.slice(0, 200),
                  itemIndex
                )
              }
              itemIndex++
            }
            itemBuffer = ''

            // In object mode, next comes another "key": value pair
            if (rootType === 'object') {
              skipUntilValue = true
            }
            continue
          }

          continue
        }

        // Comma between items at depth 0 — separator, skip it
        if (char === ',' && depth === 0) {
          // Flush any buffered primitive value (shouldn't happen for
          // conversation objects, but handle gracefully)
          if (itemBuffer.trim()) {
            try {
              const parsed = JSON.parse(itemBuffer.trim())
              await callbacks.onItem(parsed, itemIndex)
            } catch (err) {
              callbacks.onError?.(
                err instanceof Error ? err : new Error(String(err)),
                itemBuffer.trim().slice(0, 200),
                itemIndex
              )
            }
            itemIndex++
            itemBuffer = ''
          }

          if (rootType === 'object') {
            skipUntilValue = true
          }
          continue
        }

        // Whitespace at depth 0: skip (between items)
        if (depth === 0 && isWhitespace(char)) {
          continue
        }

        // Accumulate into item buffer.
        // At depth > 0 we're inside a structured item.
        // At depth 0, bare tokens (numbers, booleans, or invalid literals)
        // also accumulate so they can be flushed at the next comma or end.
        itemBuffer += char
      }
    }

    // Handle any trailing buffered content
    const trailing = itemBuffer.trim()
    if (trailing) {
      try {
        const parsed = JSON.parse(trailing)
        await callbacks.onItem(parsed, itemIndex)
        itemIndex++
      } catch {
        // Incomplete trailing data — ignore
      }
    }

    await callbacks.onEnd(itemIndex)
  } finally {
    reader.releaseLock()
  }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}

/**
 * Convenience: collect items in batches, calling a handler for each batch.
 * This is the primary interface used by the ingestion queue consumer.
 */
export async function streamParseBatched(
  stream: ReadableStream<Uint8Array>,
  batchSize: number,
  onBatch: (
    items: Array<Record<string, unknown>>,
    batchIndex: number,
    startItemIndex: number
  ) => Promise<void>,
  onError?: (error: Error, rawChunk: string, index: number) => void
): Promise<{ totalItems: number; batchCount: number }> {
  let batch: Array<Record<string, unknown>> = []
  let batchIndex = 0
  let batchStartIndex = 0
  let totalItems = 0

  await streamParseJSON(stream, {
    async onItem(item, index) {
      batch.push(item)
      totalItems = index + 1

      if (batch.length >= batchSize) {
        await onBatch(batch, batchIndex, batchStartIndex)
        batchIndex++
        batchStartIndex = index + 1
        batch = []
      }
    },
    async onEnd() {
      // Flush remaining items
      if (batch.length > 0) {
        await onBatch(batch, batchIndex, batchStartIndex)
        batchIndex++
      }
    },
    onError,
  })

  return { totalItems, batchCount: batchIndex }
}
