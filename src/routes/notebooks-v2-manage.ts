import { Hono } from 'hono'
import type { Env } from '../lib/types'
import {
  getNotebook,
  getSource,
  listNotebooks,
  listSources,
  patchNotebook,
  softDeleteNotebook,
} from '../lib/v2-store'
import {
  getArtifact,
  getNotebookSourceHashes,
  listArtifacts,
  listNotebookChunks,
} from '../lib/v2-artifacts-store'
import { generateQueryEmbedding } from '../lib/embeddings'
import { VectorStore } from '../lib/vectorize'

const notebooksV2Manage = new Hono<{ Bindings: Env }>()

function requireParam(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing path param: ${name}`)
  return value
}

const VALID_NOTEBOOK_TYPES = new Set([
  'conversation_archive',
  'dev_docs',
  'style_guide',
  'narrative_bible',
  'workflow_ops',
  'personal_archive',
  'research',
])

notebooksV2Manage.get('/', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  try {
    const notebooks = await listNotebooks(c.env, workspaceId)
    return c.json({ notebooks })
  } catch (err) {
    return c.json({ error: String(err) }, 501)
  }
})

notebooksV2Manage.get('/:notebookId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  return c.json(notebook)
})

notebooksV2Manage.patch('/:notebookId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const body = await c.req.json<{
    title?: string
    description?: string | null
    instructions?: string
    type?: string
  }>()

  if (body.type && !VALID_NOTEBOOK_TYPES.has(body.type)) {
    return c.json({ error: 'invalid notebook type' }, 400)
  }

  const updated = await patchNotebook(c.env, workspaceId, notebookId, {
    title: body.title,
    description: body.description,
    instructions: body.instructions,
    type: body.type as
      | 'conversation_archive'
      | 'dev_docs'
      | 'style_guide'
      | 'narrative_bible'
      | 'workflow_ops'
      | 'personal_archive'
      | 'research'
      | undefined,
  })

  if (!updated) return c.json({ error: 'notebook not found' }, 404)

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  return c.json(notebook)
})

notebooksV2Manage.delete('/:notebookId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')

  const deleted = await softDeleteNotebook(c.env, workspaceId, notebookId)
  if (!deleted) return c.json({ error: 'notebook not found' }, 404)

  return c.json({ deleted: true, notebookId })
})

notebooksV2Manage.get('/:notebookId/sources', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  const sources = await listSources(c.env, workspaceId, notebookId)
  return c.json({ notebookId, count: sources.length, sources })
})

notebooksV2Manage.get('/:notebookId/sources/:sourceId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const sourceId = requireParam(c.req.param('sourceId'), 'sourceId')

  const source = await getSource(c.env, workspaceId, notebookId, sourceId)
  if (!source) return c.json({ error: 'source not found' }, 404)

  return c.json(source)
})

notebooksV2Manage.post('/:notebookId/search', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const body = await c.req.json<{
    query: string
    limit?: number
    threshold?: number
  }>()

  if (!body.query?.trim()) {
    return c.json({ error: 'query is required' }, 400)
  }

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  const queryVector = await generateQueryEmbedding(body.query, c.env)
  const store = new VectorStore(c.env)
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 50)
  const threshold = body.threshold ?? 0

  const results = await store.search(queryVector, limit, threshold, {
    hydrateFullText: true,
    notebookId,
  })

  return c.json({
    query: body.query,
    notebookId,
    count: results.length,
    results,
  })
})

notebooksV2Manage.get('/:notebookId/chunks', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const limit = Math.min(
    Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
    200
  )

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  const chunks = await listNotebookChunks(c.env, workspaceId, notebookId, limit)
  return c.json({
    notebookId,
    count: chunks.length,
    chunks,
  })
})

notebooksV2Manage.get('/:notebookId/artifacts', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  const artifacts = await listArtifacts(c.env, workspaceId, notebookId)
  const currentHashes = await getNotebookSourceHashes(c.env, workspaceId, notebookId)
  const currentHashKey = JSON.stringify([...currentHashes].sort())

  return c.json({
    notebookId,
    count: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      template: artifact.template,
      createdAt: artifact.created_at,
      snapshotHashes: safeParseHashList(artifact.snapshot_hashes),
      stale: artifact.snapshot_hashes !== currentHashKey,
    })),
  })
})

notebooksV2Manage.get('/:notebookId/artifacts/:artifactId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const artifactId = requireParam(c.req.param('artifactId'), 'artifactId')

  const artifact = await getArtifact(c.env, workspaceId, notebookId, artifactId)
  if (!artifact) return c.json({ error: 'artifact not found' }, 404)

  const currentHashes = await getNotebookSourceHashes(c.env, workspaceId, notebookId)
  const currentHashKey = JSON.stringify([...currentHashes].sort())

  return c.json({
    id: artifact.id,
    notebookId: artifact.notebook_id,
    title: artifact.title,
    template: artifact.template,
    content: artifact.content,
    snapshotHashes: safeParseHashList(artifact.snapshot_hashes),
    stale: artifact.snapshot_hashes !== currentHashKey,
    createdAt: artifact.created_at,
  })
})

function safeParseHashList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

export { notebooksV2Manage }
