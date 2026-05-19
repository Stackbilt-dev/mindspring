import type { Env, ConversationRecord } from './types'
import { generateEmbeddings } from './embeddings'
import { VectorStore } from './vectorize'
import { extractConversationText, validateConversation } from './extract'

export interface V2IngestionPayload {
  job_id: string
  workspace_id: string
  notebook_id: string
  source_id: string
  r2_key: string
  parser_type: 'markdown' | 'txt' | 'pdf' | 'url' | 'chat_export'
  content_hash: string
}

interface SourceRow {
  id: string
  title: string
  content_hash: string
  status: string
}

interface NormalizedChunkRecord {
  chunk_id: string
  workspace_id: string
  notebook_id: string
  source_id: string
  content: string
  chunk_hash: string
  char_start: number
  char_end: number
}

const CHUNK_SIZE = 1800
const CHUNK_OVERLAP = 250

export async function processV2Ingestion(
  env: Env,
  payload: V2IngestionPayload
): Promise<{ chunkCount: number }> {
  const db = requireDb(env)

  await setJobStatus(db, payload.job_id, 'parsing')
  await setSourceStatus(db, payload.source_id, 'processing')

  const source = await getSource(db, payload.source_id)
  if (!source) throw new Error(`Source not found: ${payload.source_id}`)

  const object = await env.UPLOADS_BUCKET.get(payload.r2_key)
  if (!object?.body) {
    throw new Error(`R2 object not found or empty: ${payload.r2_key}`)
  }

  const rawText = await streamToText(object.body)
  const parsedText = normalizeSourceText(rawText, payload.parser_type)
  const sourceHash =
    payload.content_hash && !payload.content_hash.startsWith('pending:')
      ? payload.content_hash
      : await sha256Hex(parsedText)

  await db
    .prepare('UPDATE sources SET content_hash = ? WHERE id = ?')
    .bind(sourceHash, payload.source_id)
    .run()

  const chunks = await chunkText(parsedText, payload)

  if (chunks.length === 0) {
    await setSourceStatus(db, payload.source_id, 'failed')
    await setJobStatus(db, payload.job_id, 'failed', 'No indexable text after parsing')
    return { chunkCount: 0 }
  }

  await setJobStatus(db, payload.job_id, 'embedding')

  const embeddings = await generateEmbeddings(
    chunks.map((chunk) => chunk.content),
    env
  )

  const store = new VectorStore(env)
  const upsertItems = chunks.map((chunk, idx) => {
    const record: ConversationRecord = {
      id: chunk.chunk_id,
      title: `${source.title} · chunk ${idx + 1}`,
      text: chunk.content,
      create_time: Math.floor(Date.now() / 1000),
      update_time: Math.floor(Date.now() / 1000),
      source: 'doc',
      upload_id: payload.job_id,
      notebook_id: payload.notebook_id,
      source_id: payload.source_id,
      chunk_id: chunk.chunk_id,
      content_hash: chunk.chunk_hash,
    }

    return {
      id: chunk.chunk_id,
      vector: embeddings[idx],
      record,
    }
  })

  await store.upsert(upsertItems)
  await writeChunks(db, chunks)

  await setSourceStatus(db, payload.source_id, 'indexed')
  await setJobStatus(db, payload.job_id, 'completed')

  return { chunkCount: chunks.length }
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 DB binding is required for v2 ingestion')
  return env.DB
}

async function getSource(db: D1Database, sourceId: string): Promise<SourceRow | null> {
  const row = await db
    .prepare('SELECT id, title, content_hash, status FROM sources WHERE id = ?')
    .bind(sourceId)
    .first<SourceRow>()
  return row ?? null
}

async function setSourceStatus(
  db: D1Database,
  sourceId: string,
  status: 'processing' | 'indexed' | 'failed'
): Promise<void> {
  await db.prepare('UPDATE sources SET status = ? WHERE id = ?').bind(status, sourceId).run()
}

async function setJobStatus(
  db: D1Database,
  jobId: string,
  status: 'queued' | 'parsing' | 'embedding' | 'completed' | 'failed',
  errorMessage?: string
): Promise<void> {
  await db
    .prepare('UPDATE ingestion_jobs SET status = ?, error_message = ?, updated_at = ? WHERE job_id = ?')
    .bind(status, errorMessage ?? null, new Date().toISOString(), jobId)
    .run()
}

async function writeChunks(db: D1Database, chunks: NormalizedChunkRecord[]): Promise<void> {
  for (const chunk of chunks) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO chunks (id, workspace_id, notebook_id, source_id, content, chunk_hash, char_start, char_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        chunk.chunk_id,
        chunk.workspace_id,
        chunk.notebook_id,
        chunk.source_id,
        chunk.content,
        chunk.chunk_hash,
        chunk.char_start,
        chunk.char_end,
        new Date().toISOString()
      )
      .run()
  }
}

function normalizeSourceText(
  raw: string,
  parserType: V2IngestionPayload['parser_type']
): string {
  const cleaned = raw.replace(/\r\n/g, '\n').trim()

  if (parserType === 'markdown' || parserType === 'txt') {
    return cleaned
  }

  if (parserType === 'chat_export') {
    const parsed = JSON.parse(cleaned) as unknown
    const records: Array<Record<string, unknown>> = []

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === 'object' && item !== null) {
          records.push(item as Record<string, unknown>)
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const item of Object.values(parsed as Record<string, unknown>)) {
        if (typeof item === 'object' && item !== null) {
          records.push(item as Record<string, unknown>)
        }
      }
    } else {
      throw new Error('chat_export payload must be JSON array or object')
    }

    const extracted = records
      .filter((record) => validateConversation(record))
      .map((record) => extractConversationText(record))
      .filter((text) => text.trim().length > 0)

    if (extracted.length === 0) {
      throw new Error('chat_export payload contained no valid conversations')
    }

    return extracted.join('\n\n---\n\n')
  }

  throw new Error(`Parser type '${parserType}' not yet implemented in v2 ingestion`)
}

async function chunkText(
  text: string,
  payload: V2IngestionPayload
): Promise<NormalizedChunkRecord[]> {
  if (!text.trim()) return []

  const chunks: NormalizedChunkRecord[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(text.length, start + CHUNK_SIZE)
    const content = text.slice(start, end).trim()

    if (content.length > 0) {
      const chunk_hash = await sha256Hex(content)
      chunks.push({
        chunk_id: crypto.randomUUID(),
        workspace_id: payload.workspace_id,
        notebook_id: payload.notebook_id,
        source_id: payload.source_id,
        content,
        chunk_hash,
        char_start: start,
        char_end: end,
      })
    }

    if (end >= text.length) break
    start = Math.max(0, end - CHUNK_OVERLAP)
  }

  return chunks
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }

  out += decoder.decode()
  reader.releaseLock()
  return out
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
