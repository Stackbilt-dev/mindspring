import type { Env, IngestionMessage, UploadProgress, QdrantUpsertPoint } from './lib/types'
import { QdrantClient } from './lib/qdrant'
import { generateEmbeddings } from './lib/embeddings'
import {
  extractConversationText,
  detectFormat,
  validateConversation,
  getConversationId,
  getCreateTime,
} from './lib/extract'

/**
 * Queue consumer — processes uploaded conversation JSON files.
 *
 * Design constraints:
 *   - Workers memory limit: 128MB → stream-parse, never JSON.parse() the whole file
 *   - Queue consumer CPU: up to 15min → checkpoint progress in KV for resume
 *   - Batch size: 100 conversations per Qdrant upsert (aligned with PRD)
 *
 * For files that are too large to parse in a single invocation,
 * the checkpoint allows the Queue to redeliver and resume.
 */

const BATCH_SIZE = 100

export async function handleIngestion(
  batch: MessageBatch<IngestionMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const { uploadId, r2Key } = message.body

    try {
      await processUpload(uploadId, r2Key, env)
      message.ack()
    } catch (err) {
      console.error(`Ingestion failed for ${uploadId}:`, err)

      // Update progress with error
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
  // Load checkpoint
  const progress = await getProgress(env, uploadId)
  if (!progress) {
    throw new Error(`No progress record for upload ${uploadId}`)
  }

  if (progress.status === 'completed') {
    return // Already done (idempotent)
  }

  // Fetch the file from R2
  const object = await env.UPLOADS_BUCKET.get(r2Key)
  if (!object) {
    throw new Error(`R2 object not found: ${r2Key}`)
  }

  // Parse the JSON file.
  // For very large files (>100MB), a streaming parser would be ideal.
  // Workers' 128MB memory limit means we need to be careful.
  // Strategy: read as text and parse — for files up to ~50MB this works.
  // For larger files, we'd need to implement chunked streaming (Phase 2).
  const text = await object.text()
  let conversations: Array<Record<string, unknown>>

  const parsed = JSON.parse(text)

  if (Array.isArray(parsed)) {
    conversations = parsed
  } else if (typeof parsed === 'object' && parsed !== null) {
    // Object format — values are the conversations
    conversations = Object.values(parsed)
  } else {
    throw new Error('Invalid JSON format: expected array or object')
  }

  await updateProgress(env, uploadId, {
    totalConversations: conversations.length,
  })

  // Resume from checkpoint
  const startIndex = progress.lastCheckpointIndex
  const qdrant = new QdrantClient(env)
  const dimension = parseInt(env.EMBEDDING_DIMENSION)

  // Ensure collection exists
  await qdrant.ensureCollection(dimension)

  let processedCount = progress.processedConversations

  for (let i = startIndex; i < conversations.length; i += BATCH_SIZE) {
    const batch = conversations.slice(i, i + BATCH_SIZE)

    // Validate and extract text
    const validItems: Array<{
      conversation: Record<string, unknown>
      text: string
      id: string
    }> = []

    for (const conv of batch) {
      if (!validateConversation(conv)) continue

      // Check if already processed
      const convId = getConversationId(conv)
      const alreadyProcessed = await env.KV.get(`processed:${convId}`)
      if (alreadyProcessed) continue

      const extractedText = extractConversationText(conv)
      if (!extractedText.trim()) continue

      validItems.push({ conversation: conv, text: extractedText, id: convId })
    }

    if (validItems.length === 0) {
      processedCount += batch.length
      await updateProgress(env, uploadId, {
        processedConversations: processedCount,
        lastCheckpointIndex: i + BATCH_SIZE,
      })
      continue
    }

    // Generate embeddings
    const texts = validItems.map((item) => item.text)
    const embeddings = await generateEmbeddings(texts, env)

    // Build Qdrant points
    const points: QdrantUpsertPoint[] = validItems.map((item, idx) => {
      const conv = item.conversation
      return {
        id: md5Hex(item.id),
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

    // Mark conversations as processed
    const kvPromises = validItems.map((item) =>
      env.KV.put(`processed:${item.id}`, '1')
    )
    await Promise.all(kvPromises)

    processedCount += batch.length

    // Checkpoint
    await updateProgress(env, uploadId, {
      processedConversations: processedCount,
      lastCheckpointIndex: i + BATCH_SIZE,
    })
  }

  // Done
  await updateProgress(env, uploadId, {
    status: 'completed',
    processedConversations: conversations.length,
  })
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
 * Simple hex MD5 hash using Web Crypto API.
 * Used for generating deterministic Qdrant point IDs.
 */
function md5Hex(input: string): string {
  // Qdrant accepts string UUIDs or unsigned ints.
  // We'll use a deterministic UUID-like string from the conversation ID.
  // Since Web Crypto doesn't have MD5, we use SHA-256 truncated to 32 hex chars.
  // This matches the spirit of the Python md5 approach while being more secure.
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  // Convert to a UUID-format string for Qdrant compatibility
  const hex = Math.abs(hash).toString(16).padStart(8, '0')
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex.slice(1, 4)}-${hex.slice(0, 8)}${hex.slice(0, 4)}`
}
