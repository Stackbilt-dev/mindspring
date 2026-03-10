import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { QdrantClient } from '../lib/qdrant'
import { generateQueryEmbedding } from '../lib/embeddings'

const search = new Hono<{ Bindings: Env }>()

/**
 * Scroll Qdrant for points matching a payload filter.
 * Shared helper for conversation lookups by ID.
 */
async function scrollByFilter(
  env: Env,
  filter: Record<string, unknown>,
  limit: number = 1
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const url = `${env.QDRANT_CLOUD_URL.replace(/\/$/, '')}/collections/${env.QDRANT_COLLECTION}/points/scroll`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.QDRANT_API_KEY,
    },
    body: JSON.stringify({
      filter,
      limit,
      with_payload: true,
      with_vector: false,
    }),
  })

  if (!response.ok) {
    throw new Error(`Qdrant scroll error: ${response.status}`)
  }

  const data = (await response.json()) as {
    result: {
      points: Array<{ id: string; payload: Record<string, unknown> }>
    }
  }
  return data.result.points
}

/**
 * GET /api/search — Semantic search across conversations.
 *
 * Query params:
 *   q         — search query (required)
 *   limit     — max results (default 10, max 100)
 *   threshold — minimum similarity score (default 0.3)
 *   start     — filter: start timestamp (unix seconds)
 *   end       — filter: end timestamp (unix seconds)
 */
search.get('/', async (c) => {
  const query = c.req.query('q')
  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400)
  }

  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 100)
  const threshold = parseFloat(c.req.query('threshold') ?? '0.3')
  const startTime = c.req.query('start')
    ? parseFloat(c.req.query('start')!)
    : undefined
  const endTime = c.req.query('end')
    ? parseFloat(c.req.query('end')!)
    : undefined

  const qdrant = new QdrantClient(c.env)
  const queryVector = await generateQueryEmbedding(query, c.env)

  let results

  if (startTime != null || endTime != null) {
    results = await qdrant.filterSearch(queryVector, {
      limit,
      startTime,
      endTime,
    })
  } else {
    results = await qdrant.search(queryVector, limit, threshold)
  }

  return c.json({
    query,
    count: results.length,
    results,
  })
})

/**
 * GET /api/conversations — Browse all conversations (paginated).
 *
 * Query params:
 *   limit  — page size (default 20, max 100)
 *   offset — cursor for next page (returned as next_offset)
 */
search.get('/conversations', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100)
  const offset = c.req.query('offset') ?? undefined

  const url = `${c.env.QDRANT_CLOUD_URL.replace(/\/$/, '')}/collections/${c.env.QDRANT_COLLECTION}/points/scroll`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': c.env.QDRANT_API_KEY,
    },
    body: JSON.stringify({
      limit,
      offset,
      with_payload: true,
      with_vector: false,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    return c.json({ error: `Qdrant error: ${body}` }, 502)
  }

  const data = (await response.json()) as {
    result: {
      points: Array<{
        id: string
        payload: Record<string, unknown>
      }>
      next_page_offset: string | null
    }
  }

  return c.json({
    conversations: data.result.points.map((p) => ({
      id: p.payload.id,
      title: p.payload.title,
      text: p.payload.text,
      create_time: p.payload.create_time,
      source: p.payload.source,
    })),
    next_offset: data.result.next_page_offset,
  })
})

/**
 * GET /api/conversations/:id — Fetch a single conversation by ID.
 */
search.get('/conversations/:id', async (c) => {
  const conversationId = c.req.param('id')

  try {
    const points = await scrollByFilter(c.env, {
      must: [{ key: 'id', match: { value: conversationId } }],
    })

    if (points.length === 0) {
      return c.json({ error: 'Conversation not found' }, 404)
    }

    const p = points[0].payload
    return c.json({
      id: p.id,
      title: p.title,
      text: p.text,
      create_time: p.create_time,
      update_time: p.update_time,
      source: p.source,
      upload_id: p.upload_id,
    })
  } catch (err) {
    return c.json({ error: 'Failed to fetch conversation', detail: String(err) }, 502)
  }
})

/**
 * GET /api/conversations/:id/similar — Find similar conversations.
 *
 * Query params:
 *   limit — max results (default 5, max 20)
 */
search.get('/conversations/:id/similar', async (c) => {
  const conversationId = c.req.param('id')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5'), 20)

  try {
    const points = await scrollByFilter(c.env, {
      must: [{ key: 'id', match: { value: conversationId } }],
    })

    if (points.length === 0) {
      return c.json({ error: 'Conversation not found' }, 404)
    }

    const text = points[0].payload.text as string
    const queryVector = await generateQueryEmbedding(text, c.env)
    const qdrant = new QdrantClient(c.env)

    // Fetch one extra to filter out self
    const results = await qdrant.search(queryVector, limit + 1, 0.2)
    const filtered = results
      .filter((r) => r.id !== conversationId)
      .slice(0, limit)

    return c.json({ results: filtered })
  } catch (err) {
    return c.json({ error: 'Search failed', detail: String(err) }, 502)
  }
})

export { search }
