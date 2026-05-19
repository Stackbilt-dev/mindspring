import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { generateQueryEmbedding } from '../lib/embeddings'
import { VectorStore } from '../lib/vectorize'

const workspacesV2 = new Hono<{ Bindings: Env }>()

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing path param: ${name}`)
  return value
}

workspacesV2.post('/search', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const body = await c.req.json<{
    query: string
    limit?: number
    threshold?: number
  }>()

  if (!body.query?.trim()) {
    return c.json({ error: 'query is required' }, 400)
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 DB binding is required for workspace search' }, 501)
  }

  const notebookRows = await c.env.DB
    .prepare(
      `SELECT id, title
       FROM notebooks
       WHERE workspace_id = ? AND deleted_at IS NULL`
    )
    .bind(workspaceId)
    .all<{ id: string; title: string }>()

  const notebookIds = notebookRows.results.map((n) => n.id)
  const notebookTitleById = new Map(notebookRows.results.map((n) => [n.id, n.title]))

  if (notebookIds.length === 0) {
    return c.json({ query: body.query, count: 0, results: [] })
  }

  const queryVector = await generateQueryEmbedding(body.query, c.env)
  const store = new VectorStore(c.env)
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 50)
  const threshold = body.threshold ?? 0

  const hits = await store.searchByNotebookIds(
    queryVector,
    notebookIds,
    limit,
    threshold,
    { hydrateFullText: true }
  )

  return c.json({
    query: body.query,
    count: hits.length,
    results: hits.map((hit) => ({
      ...hit,
      notebook_id: hit.notebook_id ?? null,
      notebook_title: hit.notebook_id
        ? (notebookTitleById.get(hit.notebook_id) ?? null)
        : null,
    })),
  })
})

export { workspacesV2 }
