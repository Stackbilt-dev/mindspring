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

export { notebooksV2Manage }
