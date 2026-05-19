import type { Env } from './types'

export type NotebookType =
  | 'dev_docs'
  | 'style_guide'
  | 'narrative_bible'
  | 'workflow_ops'
  | 'personal_archive'

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
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 DB binding is required for /api/v2 routes')
  return env.DB
}

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
  }
}
