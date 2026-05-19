import type {
  Env,
  ConversationMetadata,
  ConversationRecord,
  ConversationSummaryRecord,
  SearchResult,
} from './types'

/**
 * Cloudflare Vectorize client — wraps the VECTORIZE binding.
 *
 * Vectorize has a 10KB metadata limit per vector. Conversation text
 * can be much larger, so we split storage:
 *   - Vectorize: vector + metadata (id, title, text_preview, timestamps)
 *   - KV: full conversation record under conv:{id}
 *
 * This keeps vector queries fast while preserving full text for display.
 */

const TEXT_PREVIEW_LENGTH = 500

export class VectorStore {
  private vectorize: VectorizeIndex
  private kv: KVNamespace

  constructor(env: Env) {
    this.vectorize = env.VECTORIZE
    this.kv = env.KV
  }

  /**
   * Upsert conversations: store vectors in Vectorize, full text in KV.
   */
  async upsert(
    items: Array<{
      id: string
      vector: number[]
      record: ConversationRecord
    }>
  ): Promise<void> {
    if (items.length === 0) return

    // Store full records in KV
    await Promise.all(
      items.map((item) =>
        this.kv.put(`conv:${item.id}`, JSON.stringify(item.record))
      )
    )
    await Promise.all(
      items.map((item) =>
        this.kv.put(
          `convmeta:${item.id}`,
          JSON.stringify({
            id: item.record.id,
            title: item.record.title,
            text_preview: item.record.text.slice(0, TEXT_PREVIEW_LENGTH),
            create_time: item.record.create_time,
            source: item.record.source,
          } satisfies ConversationSummaryRecord)
        )
      )
    )

    // Upsert vectors with metadata to Vectorize
    const vectors: VectorizeVector[] = items.map((item) => ({
      id: item.id,
      values: item.vector,
      metadata: {
        id: item.record.id,
        title: item.record.title,
        text_preview: item.record.text.slice(0, TEXT_PREVIEW_LENGTH),
        create_time: item.record.create_time,
        update_time: item.record.update_time,
        source: item.record.source,
        upload_id: item.record.upload_id,
        ...(item.record.notebook_id
          ? { notebook_id: item.record.notebook_id }
          : {}),
        ...(item.record.source_id ? { source_id: item.record.source_id } : {}),
        ...(item.record.chunk_id ? { chunk_id: item.record.chunk_id } : {}),
        ...(item.record.content_hash
          ? { content_hash: item.record.content_hash }
          : {}),
      } satisfies ConversationMetadata,
    }))

    await this.vectorize.upsert(vectors)
  }

  /**
   * Semantic search — query Vectorize, hydrate full text from KV.
   */
  async search(
    queryVector: number[],
    limit: number = 10,
    scoreThreshold: number = 0.3,
    options: { hydrateFullText?: boolean; notebookId?: string } = {}
  ): Promise<SearchResult[]> {
    const { hydrateFullText = true, notebookId } = options
    const results = await this.vectorize.query(queryVector, {
      topK: notebookId ? Math.max(limit * 5, 50) : limit,
      returnMetadata: 'all',
    })

    if (!results.matches || results.matches.length === 0) return []

    // Filter by notebook scope (if present) and score threshold.
    const filtered = results.matches
      .filter((m) => {
        if (!notebookId) return true
        const meta = m.metadata as unknown as ConversationMetadata
        return meta?.notebook_id === notebookId
      })
      .filter((m) => (m.score ?? 0) >= scoreThreshold)
      .slice(0, limit)

    if (!hydrateFullText) {
      return filtered.map((match) => {
        const meta = match.metadata as unknown as ConversationMetadata
        const convId = meta?.id ?? match.id
        return {
          id: convId,
          title: meta?.title ?? 'Untitled',
          text: meta?.text_preview ?? '',
          create_time: meta?.create_time ?? 0,
          score: match.score ?? 0,
        }
      })
    }

    return Promise.all(
      filtered.map(async (match) => {
        const meta = match.metadata as unknown as ConversationMetadata
        const convId = meta?.id ?? match.id
        const fullRaw = await this.kv.get(`conv:${convId}`)
        const full: ConversationRecord | null = fullRaw
          ? JSON.parse(fullRaw)
          : null

        return {
          id: convId,
          title: full?.title ?? meta?.title ?? 'Untitled',
          text: full?.text ?? meta?.text_preview ?? '',
          create_time: full?.create_time ?? meta?.create_time ?? 0,
          score: match.score ?? 0,
        }
      })
    )
  }

  /**
   * Workspace-style semantic search across multiple notebook IDs.
   * Filters results in application layer using Vectorize metadata pointers.
   */
  async searchByNotebookIds(
    queryVector: number[],
    notebookIds: string[],
    limit: number = 10,
    scoreThreshold: number = 0.3,
    options: { hydrateFullText?: boolean } = {}
  ): Promise<Array<SearchResult & { notebook_id?: string }>> {
    const { hydrateFullText = true } = options
    if (notebookIds.length === 0) return []

    const notebookIdSet = new Set(notebookIds)
    const results = await this.vectorize.query(queryVector, {
      topK: Math.max(limit * 10, 100),
      returnMetadata: 'all',
    })

    if (!results.matches || results.matches.length === 0) return []

    const filtered = results.matches
      .filter((m) => {
        const meta = m.metadata as unknown as ConversationMetadata
        return !!meta?.notebook_id && notebookIdSet.has(meta.notebook_id)
      })
      .filter((m) => (m.score ?? 0) >= scoreThreshold)
      .slice(0, limit)

    if (!hydrateFullText) {
      return filtered.map((match) => {
        const meta = match.metadata as unknown as ConversationMetadata
        const convId = meta?.id ?? match.id
        return {
          id: convId,
          title: meta?.title ?? 'Untitled',
          text: meta?.text_preview ?? '',
          create_time: meta?.create_time ?? 0,
          score: match.score ?? 0,
          notebook_id: meta?.notebook_id,
        }
      })
    }

    return Promise.all(
      filtered.map(async (match) => {
        const meta = match.metadata as unknown as ConversationMetadata
        const convId = meta?.id ?? match.id
        const fullRaw = await this.kv.get(`conv:${convId}`)
        const full: ConversationRecord | null = fullRaw
          ? JSON.parse(fullRaw)
          : null

        return {
          id: convId,
          title: full?.title ?? meta?.title ?? 'Untitled',
          text: full?.text ?? meta?.text_preview ?? '',
          create_time: full?.create_time ?? meta?.create_time ?? 0,
          score: match.score ?? 0,
          notebook_id: full?.notebook_id ?? meta?.notebook_id,
        }
      })
    )
  }

  /**
   * Get a single conversation by ID from KV.
   */
  async getById(id: string): Promise<ConversationRecord | null> {
    const raw = await this.kv.get(`conv:${id}`)
    return raw ? JSON.parse(raw) : null
  }

  /**
   * List conversations from KV (paginated via cursor).
   */
  async list(
    limit: number = 20,
    cursor?: string
  ): Promise<{
    conversations: ConversationSummaryRecord[]
    cursor: string | null
  }> {
    let list = await this.kv.list({
      prefix: 'convmeta:',
      limit,
      cursor,
    })

    // Backward compatibility: older deployments only have conv:* keys.
    if (!cursor && list.keys.length === 0) {
      list = await this.kv.list({
        prefix: 'conv:',
        limit,
      })
    }

    const conversations = await Promise.all(
      list.keys.map(async (key) => {
        const raw = await this.kv.get(key.name)
        if (!raw) return null

        if (key.name.startsWith('convmeta:')) {
          return JSON.parse(raw) as ConversationSummaryRecord
        }

        const record = JSON.parse(raw) as ConversationRecord
        return {
          id: record.id,
          title: record.title,
          text_preview: record.text.slice(0, TEXT_PREVIEW_LENGTH),
          create_time: record.create_time,
          source: record.source,
        } satisfies ConversationSummaryRecord
      })
    )

    return {
      conversations: conversations.filter(
        (value): value is ConversationSummaryRecord => Boolean(value)
      ),
      cursor: list.list_complete ? null : list.cursor,
    }
  }

  /**
   * Get index info (Vectorize doesn't expose detailed stats,
   * so we return what's available).
   */
  async getStats(): Promise<{
    description: VectorizeIndexDetails
  }> {
    const info = await this.vectorize.describe()
    return { description: info }
  }
}
