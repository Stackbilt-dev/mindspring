import type {
  Env,
  IngestionMessage,
  UploadProgress,
  ConversationRecord,
} from './lib/types'
import { VectorStore } from './lib/vectorize'
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
import { processV2Ingestion, type V2IngestionPayload } from './lib/v2-ingestion'

/**
 * Queue consumer — processes uploaded conversation JSON files.
 *
 * Design constraints:
 *   - Workers memory limit: 128MB → stream-parse, never JSON.parse() the whole file
 *   - Queue consumer CPU: up to 15min → checkpoint progress in KV for resume
 *   - Batch size: 100 conversations per Vectorize upsert (aligned with PRD)
 *   - Peak memory: ~2x largest single conversation, not the entire file
 *
 * The streaming parser reads from R2 as a ReadableStream, extracting
 * top-level JSON items one at a time. Items are collected in batches
 * of 100, validated, embedded, and upserted to Vectorize. Progress is
 * checkpointed to KV after each batch so the Queue can redeliver
 * on failure and the consumer resumes from the last checkpoint.
 */

const BATCH_SIZE = 100

export async function handleIngestion(
  batch: MessageBatch<IngestionMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const maybeUploadId = message.body.uploadId ?? message.body.job_id
    const maybeR2Key = message.body.r2Key ?? message.body.r2_key
    const startTime = Date.now()

    try {
      if (!maybeUploadId || !maybeR2Key) {
        throw new Error('Invalid ingestion message: missing upload/job id or r2 key')
      }
      const uploadId = maybeUploadId
      const r2Key = maybeR2Key
      await logIngestionEvent(env, { uploadId, action: 'started' })
      if (
        message.body.job_id &&
        message.body.workspace_id &&
        message.body.notebook_id &&
        message.body.source_id &&
        message.body.r2_key &&
        message.body.parser_type
      ) {
        await processV2Ingestion(env, {
          job_id: message.body.job_id,
          workspace_id: message.body.workspace_id,
          notebook_id: message.body.notebook_id,
          source_id: message.body.source_id,
          r2_key: message.body.r2_key,
          parser_type: message.body.parser_type,
          content_hash: message.body.content_hash ?? '',
        } satisfies V2IngestionPayload)
      } else {
        await processUpload(uploadId, r2Key, env, {
          notebookId: message.body.notebook_id,
          sourceId: message.body.source_id,
          contentHash: message.body.content_hash,
        })
      }
      await logIngestionEvent(env, {
        uploadId,
        action: 'completed',
        durationMs: Date.now() - startTime,
      })
      message.ack()
    } catch (err) {
      console.error(`Ingestion failed for ${maybeUploadId ?? 'unknown'}:`, err)

      if (maybeUploadId) {
        await logIngestionEvent(env, {
          uploadId: maybeUploadId,
          action: 'failed',
          durationMs: Date.now() - startTime,
          errorMessage: String(err),
        })

        await updateProgress(env, maybeUploadId, {
          status: 'failed',
          errorMessage: String(err),
        })
      }

      message.retry()
    }
  }
}

async function processUpload(
  uploadId: string,
  r2Key: string,
  env: Env,
  context?: {
    notebookId?: string
    sourceId?: string
    contentHash?: string
  }
): Promise<void> {
  const progress = await getProgress(env, uploadId)
  if (!progress && !context?.sourceId) {
    throw new Error(`No progress record for upload ${uploadId}`)
  }

  if (progress?.status === 'completed') {
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

  const store = new VectorStore(env)
  const resumeFromBatch = Math.floor(
    (progress?.lastCheckpointIndex ?? 0) / BATCH_SIZE
  )
  let processedCount = progress?.processedConversations ?? 0
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
        if (progress) {
          await updateProgress(env, uploadId, {
            processedConversations: processedCount,
            lastCheckpointIndex: startItemIndex + items.length,
          })
        }
        return
      }

      // Generate embeddings via Workers AI
      const texts = validItems.map((item) => item.text)
      const embeddings = await generateEmbeddings(texts, env)

      // Build records and upsert to Vectorize + KV
      const upsertItems = validItems.map((item, idx) => {
        const conv = item.conversation
        const record: ConversationRecord = {
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
          notebook_id: context?.notebookId,
          source_id: context?.sourceId,
          chunk_id: item.id,
          content_hash: context?.contentHash,
        }

        return {
          id: item.id,
          vector: embeddings[idx],
          record,
        }
      })

      await store.upsert(upsertItems)

      // Mark conversations as processed in KV
      await Promise.all(
        validItems.map((item) => env.KV.put(`processed:${item.id}`, '1'))
      )

      processedCount += items.length

      // Checkpoint after each batch — the resume point if we crash
      if (progress) {
        await updateProgress(env, uploadId, {
          totalConversations: null,
          processedConversations: processedCount,
          lastCheckpointIndex: startItemIndex + items.length,
        })
      }
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
  if (progress) {
    await updateProgress(env, uploadId, {
      status: 'completed',
      totalConversations: totalItems,
      processedConversations: totalItems,
      errorMessage:
        parseErrors > 0
          ? `Completed with ${parseErrors} parse error(s)`
          : undefined,
    })
  }

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
