import type {
  Env,
  IngestionMessage,
  UploadProgress,
  QdrantUpsertPoint,
} from './lib/types'
import { QdrantClient } from './lib/qdrant'
import { generateEmbeddings } from './lib/embeddings'
import {
  extractConversationText,
  detectFormat,
  validateConversation,
  getConversationId,
  getCreateTime,
} from './lib/extract'
import { streamParseBatched } from './lib/stream-parser'
import { logIngestionEvent } from './lib/telemetry'

/**
 * Queue consumer — processes uploaded conversation JSON files.
 *
 * Design constraints:
 *   - Workers memory limit: 128MB → stream-parse, never JSON.parse() the whole file
 *   - Queue consumer CPU: up to 15min → checkpoint progress in KV for resume
 *   - Batch size: 100 conversations per Qdrant upsert (aligned with PRD)
 *   - Peak memory: ~2x largest single conversation, not the entire file
 *
 * The streaming parser reads from R2 as a ReadableStream, extracting
 * top-level JSON items one at a time. Items are collected in batches
 * of 100, validated, embedded, and upserted to Qdrant. Progress is
 * checkpointed to KV after each batch so the Queue can redeliver
 * on failure and the consumer resumes from the last checkpoint.
 */

const BATCH_SIZE = 100

export async function handleIngestion(
  batch: MessageBatch<IngestionMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { uploadId, r2Key } = message.body

    const startTime = Date.now()

    try {
      await logIngestionEvent(env, { uploadId, action: 'started' })
      await processUpload(uploadId, r2Key, env)
      await logIngestionEvent(env, {
        uploadId,
        action: 'completed',
        durationMs: Date.now() - startTime,
      })
      message.ack()
    } catch (err) {
      console.error(`Ingestion failed for ${uploadId}:`, err)

      await logIngestionEvent(env, {
        uploadId,
        action: 'failed',
        durationMs: Date.now() - startTime,
        errorMessage: String(err),
      })

      await updateProgress(env, uploadId, {
        status: 'failed',
        errorMessage: String(err),
      })

      message.retry()
    }
  }
}

async function processUpload(
  uploadId: string,
  r2Key: string,
  env: Env
): Promise<void> {
  const progress = await getProgress(env, uploadId)
  if (!progress) {
    throw new Error(`No progress record for upload ${uploadId}`)
  }

  if (progress.status === 'completed') {
    return // Idempotent — already done
  }

  // Fetch the R2 object as a stream — never buffer the full file
  const object = await env.UPLOADS_BUCKET.get(r2Key)
  if (!object) {
    throw new Error(`R2 object not found: ${r2Key}`)
  }

  const stream = object.body
  if (!stream) {
    throw new Error(`R2 object has no body: ${r2Key}`)
  }

  const qdrant = new QdrantClient(env)
  const dimension = parseInt(env.EMBEDDING_DIMENSION)
  await qdrant.ensureCollection(dimension)

  const resumeFromBatch = Math.floor(
    progress.lastCheckpointIndex / BATCH_SIZE
  )
  let processedCount = progress.processedConversations
  let parseErrors = 0

  // Stream-parse the JSON, processing items in batches of 100
  const { totalItems, batchCount } = await streamParseBatched(
    stream,
    BATCH_SIZE,
    async (items, batchIndex, startItemIndex) => {
      // Skip batches we've already processed (resume support)
      if (batchIndex < resumeFromBatch) {
        return
      }

      // Validate and extract text from each conversation
      const validItems: Array<{
        conversation: Record<string, unknown>
        text: string
        id: string
      }> = []

      for (const conv of items) {
        if (!validateConversation(conv)) continue

        const convId = getConversationId(conv)

        // Check if already processed (dedup via KV)
        const alreadyProcessed = await env.KV.get(`processed:${convId}`)
        if (alreadyProcessed) continue

        const extractedText = extractConversationText(conv)
        if (!extractedText.trim()) continue

        validItems.push({
          conversation: conv,
          text: extractedText,
          id: convId,
        })
      }

      if (validItems.length === 0) {
        processedCount += items.length
        await updateProgress(env, uploadId, {
          processedConversations: processedCount,
          lastCheckpointIndex: startItemIndex + items.length,
        })
        return
      }

      // Generate embeddings via Workers AI
      const texts = validItems.map((item) => item.text)
      const embeddings = await generateEmbeddings(texts, env)

      // Build Qdrant points
      const points: QdrantUpsertPoint[] = validItems.map((item, idx) => {
        const conv = item.conversation
        return {
          id: deterministicUUID(item.id),
          vector: embeddings[idx],
          payload: {
            id: item.id,
            title:
              (conv.title as string) ??
              (conv.name as string) ??
              'Untitled',
            text: item.text,
            create_time: getCreateTime(conv),
            update_time:
              typeof conv.update_time === 'number'
                ? conv.update_time
                : Date.now() / 1000,
            source: detectFormat(conv),
            upload_id: uploadId,
          },
        }
      })

      // Upsert to Qdrant
      await qdrant.upsert(points)

      // Mark conversations as processed in KV
      await Promise.all(
        validItems.map((item) => env.KV.put(`processed:${item.id}`, '1'))
      )

      processedCount += items.length

      // Checkpoint after each batch — the resume point if we crash
      await updateProgress(env, uploadId, {
        totalConversations: null, // updated at end when stream count is known
        processedConversations: processedCount,
        lastCheckpointIndex: startItemIndex + items.length,
      })
    },
    // Parse error callback — log and continue
    (error, rawChunk, index) => {
      parseErrors++
      console.warn(
        `Parse error at item ${index}: ${error.message} | fragment: ${rawChunk.slice(0, 100)}`
      )
    }
  )

  // Final status
  await updateProgress(env, uploadId, {
    status: 'completed',
    totalConversations: totalItems,
    processedConversations: totalItems,
    errorMessage:
      parseErrors > 0
        ? `Completed with ${parseErrors} parse error(s)`
        : undefined,
  })

  console.log(
    `Ingestion complete: ${uploadId} — ${totalItems} items in ${batchCount} batches` +
      (parseErrors > 0 ? ` (${parseErrors} errors)` : '')
  )
}

// -- Helpers --

async function getProgress(
  env: Env,
  uploadId: string
): Promise<UploadProgress | null> {
  const raw = await env.KV.get(`upload:${uploadId}`)
  return raw ? JSON.parse(raw) : null
}

async function updateProgress(
  env: Env,
  uploadId: string,
  updates: Partial<UploadProgress>
): Promise<void> {
  const current = await getProgress(env, uploadId)
  if (!current) return

  const updated: UploadProgress = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  }
  await env.KV.put(`upload:${uploadId}`, JSON.stringify(updated))
}

/**
 * Generate a deterministic UUID-format string from a conversation ID.
 *
 * Qdrant requires point IDs as UUIDs or unsigned integers. We hash the
 * conversation ID into a stable UUID v4-shaped string. Uses a fast
 * non-cryptographic hash — collision resistance isn't critical since
 * upsert is idempotent.
 */
function deterministicUUID(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  const hex = (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  )

  // Format as UUID v4 shape: xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-4' +
    hex.slice(13, 16) +
    '-8' +
    hex.slice(16, 19) +
    '-' +
    hex.slice(19, 31).padEnd(12, '0')
  )
}
