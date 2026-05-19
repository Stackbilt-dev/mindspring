import { Hono } from 'hono'
import type { Env } from '../lib/types'
import {
  createNotebook,
  createSource,
  getNotebook,
  type SourceType,
} from '../lib/v2-store'
import {
  createArtifact,
  getNotebookSourceHashes,
  listNotebookChunks,
} from '../lib/v2-artifacts-store'
import { generateQueryEmbedding } from '../lib/embeddings'
import { VectorStore } from '../lib/vectorize'
import { generateChatResponse } from '../lib/generate'

const notebooksV2 = new Hono<{ Bindings: Env }>()
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

const VALID_SOURCE_TYPES = new Set([
  'markdown',
  'txt',
  'pdf',
  'url',
  'chat_export',
])

const VALID_ARTIFACT_TEMPLATES = new Set([
  'briefing_doc',
  'faq_glossary',
  'implementation_plan',
  'world_bible',
])

notebooksV2.post('/', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const body = await c.req.json<{
    title: string
    description?: string
    type: string
    instructions?: string
  }>()

  if (!body.title?.trim()) {
    return c.json({ error: 'title is required' }, 400)
  }
  if (!VALID_NOTEBOOK_TYPES.has(body.type)) {
    return c.json({ error: 'invalid notebook type' }, 400)
  }

  try {
    const notebook = await createNotebook(c.env, {
      workspaceId,
      title: body.title.trim(),
      description: body.description,
      type: body.type as
        | 'conversation_archive'
        | 'dev_docs'
        | 'style_guide'
        | 'narrative_bible'
        | 'workflow_ops'
        | 'personal_archive'
        | 'research',
      instructions: body.instructions ?? '',
    })
    return c.json(notebook, 201)
  } catch (err) {
    return c.json({ error: String(err) }, 501)
  }
})

notebooksV2.post('/:notebookId/sources', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')

  const body = await c.req.json<{
    title: string
    type: string
    sourceUploadId: string
    parserType?: string
    contentHash?: string
  }>()

  if (!body.title?.trim() || !body.sourceUploadId) {
    return c.json({ error: 'title and sourceUploadId are required' }, 400)
  }
  if (!VALID_SOURCE_TYPES.has(body.type)) {
    return c.json({ error: 'invalid source type' }, 400)
  }

  const progressRaw = await c.env.KV.get(`upload:${body.sourceUploadId}`)
  if (!progressRaw) {
    return c.json({ error: 'source upload not found' }, 404)
  }
  const progress = JSON.parse(progressRaw) as { r2Key: string }

  const contentHash = body.contentHash ?? `pending:${body.sourceUploadId}`

  try {
    const source = await createSource(c.env, {
      workspaceId,
      notebookId,
      title: body.title.trim(),
      type: body.type as SourceType,
      r2ObjectKey: progress.r2Key,
      contentHash,
    })

    const jobId = crypto.randomUUID()
    if (!c.env.DB) {
      return c.json({ error: 'D1 DB binding is required for v2 ingestion' }, 501)
    }
    await c.env.DB
      .prepare(
        `INSERT INTO ingestion_jobs (job_id, workspace_id, notebook_id, source_id, status, error_message, updated_at)
         VALUES (?, ?, ?, ?, 'queued', NULL, ?)`
      )
      .bind(
        jobId,
        workspaceId,
        notebookId,
        source.id,
        new Date().toISOString()
      )
      .run()

    await c.env.KV.put(
      `ingestjob:${jobId}`,
      JSON.stringify({
        job_id: jobId,
        workspace_id: workspaceId,
        notebook_id: notebookId,
        source_id: source.id,
        r2_key: progress.r2Key,
        parser_type: (body.parserType ?? body.type) as SourceType,
        content_hash: contentHash,
      })
    )

    await c.env.INGESTION_QUEUE.send({
      job_id: jobId,
      workspace_id: workspaceId,
      notebook_id: notebookId,
      source_id: source.id,
      r2_key: progress.r2Key,
      parser_type: (body.parserType ?? body.type) as SourceType,
      content_hash: contentHash,
    })

    return c.json({ source, jobId }, 202)
  } catch (err) {
    return c.json({ error: String(err) }, 501)
  }
})

notebooksV2.post('/:notebookId/chat', async (c) => {
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const body = await c.req.json<{
    message: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }>()

  if (!body.message?.trim()) {
    return c.json({ error: 'message is required' }, 400)
  }

  let contexts: Array<{ id: string; title: string; text: string; score: number }> = []
  let citations: Array<{
    sourceId: string
    sourceTitle: string
    chunkId: string
    score: number
    textSnippet: string
  }> = []

  try {
    const queryVector = await generateQueryEmbedding(body.message, c.env)
    const store = new VectorStore(c.env)
    const results = await store.search(queryVector, 20, 0, {
      hydrateFullText: true,
      notebookId,
    })
    contexts = results.map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      score: r.score,
    }))
    citations = results.map((r) => ({
      sourceId: r.id,
      sourceTitle: r.title,
      chunkId: r.id,
      score: r.score,
      textSnippet: r.text.slice(0, 240),
    }))
  } catch {
    // Continue to D1 fallback below.
  }

  if (contexts.length === 0 && c.env.DB) {
    const fallbackChunks = await c.env.DB
      .prepare(
        `SELECT c.id, c.source_id, c.content, s.title
         FROM chunks c
         JOIN sources s ON s.id = c.source_id
         WHERE c.notebook_id = ?
         ORDER BY c.created_at DESC
         LIMIT 8`
      )
      .bind(notebookId)
      .all<{
        id: string
        source_id: string
        content: string
        title: string
      }>()

    if (fallbackChunks.results.length > 0) {
      contexts = fallbackChunks.results.map((row) => ({
        id: row.id,
        title: row.title,
        text: row.content,
        score: 1,
      }))
      citations = fallbackChunks.results.map((row) => ({
        sourceId: row.source_id,
        sourceTitle: row.title,
        chunkId: row.id,
        score: 1,
        textSnippet: row.content.slice(0, 240),
      }))
    }
  }

  if (contexts.length === 0) {
    return c.json({ response: 'No matching notebook sources found.', citations: [] })
  }

  let response: string
  try {
    response = await generateChatResponse(
      body.message,
      contexts,
      body.history ?? [],
      c.env
    )
  } catch {
    response = [
      'Model generation is temporarily unavailable. Returning source-grounded excerpts instead.',
      '',
      ...contexts
        .slice(0, 3)
        .map(
          (ctx, idx) =>
            `${idx + 1}. ${ctx.title}: ${ctx.text.slice(0, 280).replace(/\\s+/g, ' ')}`
        ),
    ].join('\\n')
  }

  return c.json({ response, citations })
})

notebooksV2.post('/:notebookId/artifacts', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const body = await c.req.json<{
    template: string
    additionalDirectives?: string
  }>()

  if (!VALID_ARTIFACT_TEMPLATES.has(body.template)) {
    return c.json({ error: 'invalid artifact template' }, 400)
  }

  const notebook = await getNotebook(c.env, workspaceId, notebookId)
  if (!notebook) return c.json({ error: 'notebook not found' }, 404)

  const chunks = await listNotebookChunks(c.env, workspaceId, notebookId, 12)
  if (chunks.length === 0) {
    return c.json({ error: 'notebook has no indexed chunks yet' }, 400)
  }

  const contexts = chunks.map((chunk) => ({
    id: chunk.id,
    title: chunk.source_title,
    text: chunk.content,
    score: 1,
  }))

  const templatePrompt = [
    `Generate a ${body.template} from notebook sources.`,
    'Use only grounded source content. Cite assumptions as unknown when unsupported.',
    body.additionalDirectives ?? '',
  ]
    .filter(Boolean)
    .join('\n')

  let content: string
  try {
    content = await generateChatResponse(templatePrompt, contexts, [], c.env)
  } catch {
    content = [
      `# ${body.template}`,
      '',
      'Model generation unavailable. Source-grounded excerpts:',
      ...contexts
        .slice(0, 5)
        .map((ctx, i) => `${i + 1}. ${ctx.title}: ${ctx.text.slice(0, 320)}`),
    ].join('\n')
  }

  const snapshotHashes = await getNotebookSourceHashes(c.env, workspaceId, notebookId)
  const title = `${body.template.replace(/_/g, ' ')} · ${new Date().toISOString()}`

  const artifact = await createArtifact(c.env, {
    workspaceId,
    notebookId,
    title,
    template: body.template as
      | 'briefing_doc'
      | 'faq_glossary'
      | 'implementation_plan'
      | 'world_bible',
    content,
    snapshotHashes,
  })

  return c.json(
    {
      id: artifact.id,
      notebookId: artifact.notebook_id,
      title: artifact.title,
      template: artifact.template,
      content: artifact.content,
      snapshotHashes,
      stale: false,
      createdAt: artifact.created_at,
    },
    201
  )
})

notebooksV2.get('/:notebookId/jobs/:jobId', async (c) => {
  const workspaceId = requireParam(c.req.param('workspaceId'), 'workspaceId')
  const notebookId = requireParam(c.req.param('notebookId'), 'notebookId')
  const jobId = requireParam(c.req.param('jobId'), 'jobId')

  if (!c.env.DB) {
    return c.json({ error: 'D1 DB binding is required for v2 ingestion' }, 501)
  }

  const row = await c.env.DB
    .prepare(
      `SELECT job_id, workspace_id, notebook_id, source_id, status, error_message, updated_at
       FROM ingestion_jobs
       WHERE job_id = ? AND workspace_id = ? AND notebook_id = ?`
    )
    .bind(jobId, workspaceId, notebookId)
    .first<{
      job_id: string
      workspace_id: string
      notebook_id: string
      source_id: string
      status: 'queued' | 'parsing' | 'embedding' | 'completed' | 'failed'
      error_message: string | null
      updated_at: string
    }>()

  if (!row) {
    return c.json({ error: 'job not found' }, 404)
  }

  return c.json({
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    notebookId: row.notebook_id,
    sourceId: row.source_id,
    status: row.status,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  })
})

export { notebooksV2 }
