import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { VectorStore } from '../lib/vectorize'
import { generateQueryEmbedding } from '../lib/embeddings'

const conversations = new Hono<{ Bindings: Env }>()

/**
 * GET / — Browse all conversations (paginated).
 */
conversations.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20'), 100)
  const cursor = c.req.query('cursor') ?? undefined

  const store = new VectorStore(c.env)
  const { conversations: convs, cursor: nextCursor } = await store.list(
    limit,
    cursor
  )

  return c.json({
    conversations: convs.map((conv) => ({
      id: conv.id,
      title: conv.title,
      text: conv.text.slice(0, 500),
      create_time: conv.create_time,
      source: conv.source,
    })),
    next_cursor: nextCursor,
  })
})

/**
 * GET /:id — Fetch a single conversation by ID.
 */
conversations.get('/:id', async (c) => {
  const id = c.req.param('id')
  const store = new VectorStore(c.env)
  const conv = await store.getById(id)

  if (!conv) {
    return c.json({ error: 'Conversation not found' }, 404)
  }

  return c.json(conv)
})

/**
 * GET /:id/similar — Find similar conversations.
 */
conversations.get('/:id/similar', async (c) => {
  const id = c.req.param('id')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '5'), 20)

  const store = new VectorStore(c.env)
  const conv = await store.getById(id)

  if (!conv) {
    return c.json({ error: 'Conversation not found' }, 404)
  }

  const queryVector = await generateQueryEmbedding(conv.text, c.env)
  const results = await store.search(queryVector, limit + 1, 0.2)
  const filtered = results.filter((r) => r.id !== id).slice(0, limit)

  return c.json({ results: filtered })
})

export { conversations }
