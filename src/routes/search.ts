import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { VectorStore } from '../lib/vectorize'
import { generateQueryEmbedding } from '../lib/embeddings'

const search = new Hono<{ Bindings: Env }>()

/**
 * GET /search — Semantic search across conversations.
 */
search.get('/', async (c) => {
  const query = c.req.query('q')
  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400)
  }

  const limit = Math.min(parseInt(c.req.query('limit') ?? '10'), 100)
  const threshold = parseFloat(c.req.query('threshold') ?? '0.3')

  const store = new VectorStore(c.env)
  const queryVector = await generateQueryEmbedding(query, c.env)
  const results = await store.search(queryVector, limit, threshold, {
    hydrateFullText: false,
  })

  return c.json({
    query,
    count: results.length,
    results,
  })
})

export { search }
