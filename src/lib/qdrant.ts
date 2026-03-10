import type {
  Env,
  QdrantSearchResponse,
  QdrantUpsertPoint,
  QdrantCollectionInfo,
  SearchResult,
} from './types'

/**
 * Qdrant Cloud client — thin wrapper over the REST API.
 * No SDK dependency; Workers fetch is sufficient.
 */
export class QdrantClient {
  private baseUrl: string
  private apiKey: string
  private collection: string

  constructor(env: Env) {
    this.baseUrl = env.QDRANT_CLOUD_URL.replace(/\/$/, '')
    this.apiKey = env.QDRANT_API_KEY
    this.collection = env.QDRANT_COLLECTION
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
        ...options.headers,
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Qdrant API error ${response.status}: ${body}`)
    }

    return response.json() as Promise<T>
  }

  /**
   * Ensure collection exists with the correct vector config.
   */
  async ensureCollection(dimension: number): Promise<void> {
    try {
      await this.request(`/collections/${this.collection}`)
    } catch {
      await this.request(`/collections/${this.collection}`, {
        method: 'PUT',
        body: JSON.stringify({
          vectors: {
            size: dimension,
            distance: 'Cosine',
          },
        }),
      })
    }
  }

  /**
   * Upsert points (vectors + payloads) into the collection.
   */
  async upsert(points: QdrantUpsertPoint[]): Promise<void> {
    await this.request(`/collections/${this.collection}/points`, {
      method: 'PUT',
      body: JSON.stringify({ points }),
    })
  }

  /**
   * Semantic search by vector.
   */
  async search(
    vector: number[],
    limit: number = 5,
    scoreThreshold: number = 0.3,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    }

    if (filter) {
      body.filter = filter
    }

    const data = await this.request<QdrantSearchResponse>(
      `/collections/${this.collection}/points/search`,
      { method: 'POST', body: JSON.stringify(body) }
    )

    return data.result.map((point) => ({
      id: point.payload.id,
      title: point.payload.title,
      text: point.payload.text,
      create_time: point.payload.create_time,
      score: point.score,
    }))
  }

  /**
   * Search with time range filter.
   */
  async filterSearch(
    vector: number[],
    options: {
      limit?: number
      startTime?: number
      endTime?: number
    } = {}
  ): Promise<SearchResult[]> {
    const conditions: Array<Record<string, unknown>> = []

    if (options.startTime != null) {
      conditions.push({
        key: 'create_time',
        range: { gte: options.startTime },
      })
    }
    if (options.endTime != null) {
      conditions.push({
        key: 'create_time',
        range: { lte: options.endTime },
      })
    }

    const filter = conditions.length > 0 ? { must: conditions } : undefined

    return this.search(vector, options.limit ?? 5, 0.0, filter)
  }

  /**
   * Get collection statistics.
   */
  async getStats(): Promise<{
    vectors_count: number
    points_count: number
    segments_count: number
    status: string
  }> {
    const data = await this.request<QdrantCollectionInfo>(
      `/collections/${this.collection}`
    )
    return {
      vectors_count: data.result.vectors_count,
      points_count: data.result.points_count,
      segments_count: data.result.segments_count,
      status: data.result.status,
    }
  }

  /**
   * Check if a point exists by ID.
   */
  async pointExists(pointId: string): Promise<boolean> {
    try {
      await this.request(
        `/collections/${this.collection}/points/${pointId}`
      )
      return true
    } catch {
      return false
    }
  }
}
