import type { Env } from './types'

export type NotebookType =
  | 'conversation_archive'
  | 'dev_docs'
  | 'style_guide'
  | 'narrative_bible'
  | 'workflow_ops'
  | 'personal_archive'
  | 'research'

export type SourceType = 'markdown' | 'txt' | 'pdf' | 'url' | 'chat_export'

export interface NotebookRecord {
  id: string
  workspace_id: string
  title: string
  description: string | null
  type: NotebookType
  instructions: string
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface SourceRecord {
  id: string
  workspace_id: string
  notebook_id: string
  title: string
  type: SourceType
  r2_object_key: string
  content_hash: string
  status: 'pending' | 'processing' | 'indexed' | 'failed'
  created_at: string
  deleted_at?: string | null
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 DB binding is required for /api/v2 routes')
  return env.DB
}

export { requireDb }

export async function createNotebook(
  env: Env,
  payload: {
    workspaceId: string
    title: string
    description?: string
    type: NotebookType
    instructions?: string
  }
): Promise<NotebookRecord> {
  const db = requireDb(env)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()

  await db
    .prepare(
      `INSERT INTO notebooks (id, workspace_id, title, description, type, instructions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      payload.workspaceId,
      payload.title,
      payload.description ?? null,
      payload.type,
      payload.instructions ?? '',
      now,
      now
    )
    .run()

  return {
    id,
    workspace_id: payload.workspaceId,
    title: payload.title,
    description: payload.description ?? null,
    type: payload.type,
    instructions: payload.instructions ?? '',
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
}

export async function createSource(
  env: Env,
  payload: {
    workspaceId: string
    notebookId: string
    title: string
    type: SourceType
    r2ObjectKey: string
    contentHash: string
  }
): Promise<SourceRecord> {
  const db = requireDb(env)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()

  await db
    .prepare(
      `INSERT INTO sources (id, workspace_id, notebook_id, title, type, r2_object_key, content_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(
      id,
      payload.workspaceId,
      payload.notebookId,
      payload.title,
      payload.type,
      payload.r2ObjectKey,
      payload.contentHash,
      now
    )
    .run()

  return {
    id,
    workspace_id: payload.workspaceId,
    notebook_id: payload.notebookId,
    title: payload.title,
    type: payload.type,
    r2_object_key: payload.r2ObjectKey,
    content_hash: payload.contentHash,
    status: 'pending',
    created_at: now,
    deleted_at: null,
  }
}

export async function listNotebooks(
  env: Env,
  workspaceId: string
): Promise<Array<NotebookRecord & { source_count: number; chunk_count: number }>> {
  const db = requireDb(env)
  const rows = await db
    .prepare(
      `SELECT
         n.id, n.workspace_id, n.title, n.description, n.type, n.instructions, n.created_at, n.updated_at, n.deleted_at,
         COUNT(DISTINCT s.id) AS source_count,
         COUNT(DISTINCT c.id) AS chunk_count
       FROM notebooks n
       LEFT JOIN sources s ON s.notebook_id = n.id AND s.deleted_at IS NULL
       LEFT JOIN chunks c ON c.notebook_id = n.id
       WHERE n.workspace_id = ? AND n.deleted_at IS NULL
       GROUP BY n.id
       ORDER BY n.updated_at DESC`
    )
    .bind(workspaceId)
    .all<NotebookRecord & { source_count: number; chunk_count: number }>()

  return rows.results
}

export async function getNotebook(
  env: Env,
  workspaceId: string,
  notebookId: string
): Promise<(NotebookRecord & { source_count: number; chunk_count: number }) | null> {
  const db = requireDb(env)
  const row = await db
    .prepare(
      `SELECT
         n.id, n.workspace_id, n.title, n.description, n.type, n.instructions, n.created_at, n.updated_at, n.deleted_at,
         COUNT(DISTINCT s.id) AS source_count,
         COUNT(DISTINCT c.id) AS chunk_count
       FROM notebooks n
       LEFT JOIN sources s ON s.notebook_id = n.id AND s.deleted_at IS NULL
       LEFT JOIN chunks c ON c.notebook_id = n.id
       WHERE n.workspace_id = ? AND n.id = ? AND n.deleted_at IS NULL
       GROUP BY n.id`
    )
    .bind(workspaceId, notebookId)
    .first<NotebookRecord & { source_count: number; chunk_count: number }>()

  return row ?? null
}

export async function patchNotebook(
  env: Env,
  workspaceId: string,
  notebookId: string,
  updates: Partial<Pick<NotebookRecord, 'title' | 'description' | 'instructions' | 'type'>>
): Promise<boolean> {
  const db = requireDb(env)
  const now = new Date().toISOString()

  const result = await db
    .prepare(
      `UPDATE notebooks
       SET
         title = CASE WHEN ? THEN ? ELSE title END,
         description = CASE WHEN ? THEN ? ELSE description END,
         instructions = CASE WHEN ? THEN ? ELSE instructions END,
         type = CASE WHEN ? THEN ? ELSE type END,
         updated_at = ?
       WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`
    )
    .bind(
      updates.title !== undefined ? 1 : 0,
      updates.title ?? null,
      updates.description !== undefined ? 1 : 0,
      updates.description ?? null,
      updates.instructions !== undefined ? 1 : 0,
      updates.instructions ?? null,
      updates.type !== undefined ? 1 : 0,
      updates.type ?? null,
      now,
      workspaceId,
      notebookId
    )
    .run()

  return Boolean(result.meta.changes)
}

export async function softDeleteNotebook(
  env: Env,
  workspaceId: string,
  notebookId: string
): Promise<boolean> {
  const db = requireDb(env)
  const now = new Date().toISOString()

  const notebookRes = await db
    .prepare(
      `UPDATE notebooks
       SET deleted_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`
    )
    .bind(now, now, workspaceId, notebookId)
    .run()

  if (!notebookRes.meta.changes) return false

  await db
    .prepare(`UPDATE sources SET deleted_at = ? WHERE workspace_id = ? AND notebook_id = ?`)
    .bind(now, workspaceId, notebookId)
    .run()

  return true
}

export async function listSources(
  env: Env,
  workspaceId: string,
  notebookId: string
): Promise<Array<SourceRecord & { chunk_count: number }>> {
  const db = requireDb(env)
  const rows = await db
    .prepare(
      `SELECT
         s.id, s.workspace_id, s.notebook_id, s.title, s.type, s.r2_object_key, s.content_hash, s.status, s.created_at, s.deleted_at,
         COUNT(c.id) AS chunk_count
       FROM sources s
       LEFT JOIN chunks c ON c.source_id = s.id
       WHERE s.workspace_id = ? AND s.notebook_id = ? AND s.deleted_at IS NULL
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    )
    .bind(workspaceId, notebookId)
    .all<SourceRecord & { chunk_count: number }>()

  return rows.results
}

export async function getSource(
  env: Env,
  workspaceId: string,
  notebookId: string,
  sourceId: string
): Promise<(SourceRecord & { chunk_count: number }) | null> {
  const db = requireDb(env)
  const row = await db
    .prepare(
      `SELECT
         s.id, s.workspace_id, s.notebook_id, s.title, s.type, s.r2_object_key, s.content_hash, s.status, s.created_at, s.deleted_at,
         COUNT(c.id) AS chunk_count
       FROM sources s
       LEFT JOIN chunks c ON c.source_id = s.id
       WHERE s.workspace_id = ? AND s.notebook_id = ? AND s.id = ? AND s.deleted_at IS NULL
       GROUP BY s.id`
    )
    .bind(workspaceId, notebookId, sourceId)
    .first<SourceRecord & { chunk_count: number }>()

  return row ?? null
}
