import type { Env } from './types'

export interface ArtifactRecord {
  id: string
  workspace_id: string
  notebook_id: string
  title: string
  template: 'briefing_doc' | 'faq_glossary' | 'implementation_plan' | 'world_bible'
  content: string
  snapshot_hashes: string
  created_at: string
}

export interface NotebookChunkRecord {
  id: string
  notebook_id: string
  source_id: string
  content: string
  chunk_hash: string
  char_start: number
  char_end: number
  created_at: string
  source_title: string
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 DB binding is required for /api/v2 routes')
  return env.DB
}

export async function listNotebookChunks(
  env: Env,
  workspaceId: string,
  notebookId: string,
  limit: number = 50
): Promise<NotebookChunkRecord[]> {
  const db = requireDb(env)
  const rows = await db
    .prepare(
      `SELECT
         c.id, c.notebook_id, c.source_id, c.content, c.chunk_hash, c.char_start, c.char_end, c.created_at,
         s.title AS source_title
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       JOIN notebooks n ON n.id = c.notebook_id
       WHERE n.workspace_id = ? AND c.notebook_id = ? AND n.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT ?`
    )
    .bind(workspaceId, notebookId, limit)
    .all<NotebookChunkRecord>()

  return rows.results
}

export async function getNotebookSourceHashes(
  env: Env,
  workspaceId: string,
  notebookId: string
): Promise<string[]> {
  const db = requireDb(env)
  const rows = await db
    .prepare(
      `SELECT content_hash
       FROM sources
       WHERE workspace_id = ? AND notebook_id = ? AND deleted_at IS NULL`
    )
    .bind(workspaceId, notebookId)
    .all<{ content_hash: string }>()

  return rows.results
    .map((r) => r.content_hash)
    .filter((hash) => typeof hash === 'string' && hash.length > 0)
    .sort()
}

export async function createArtifact(
  env: Env,
  payload: {
    workspaceId: string
    notebookId: string
    title: string
    template: 'briefing_doc' | 'faq_glossary' | 'implementation_plan' | 'world_bible'
    content: string
    snapshotHashes: string[]
  }
): Promise<ArtifactRecord> {
  const db = requireDb(env)
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const snapshotHashes = JSON.stringify([...payload.snapshotHashes].sort())

  await db
    .prepare(
      `INSERT INTO artifacts (id, workspace_id, notebook_id, title, template, content, snapshot_hashes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      payload.workspaceId,
      payload.notebookId,
      payload.title,
      payload.template,
      payload.content,
      snapshotHashes,
      now
    )
    .run()

  return {
    id,
    workspace_id: payload.workspaceId,
    notebook_id: payload.notebookId,
    title: payload.title,
    template: payload.template,
    content: payload.content,
    snapshot_hashes: snapshotHashes,
    created_at: now,
  }
}

export async function listArtifacts(
  env: Env,
  workspaceId: string,
  notebookId: string
): Promise<ArtifactRecord[]> {
  const db = requireDb(env)
  const rows = await db
    .prepare(
      `SELECT id, workspace_id, notebook_id, title, template, content, snapshot_hashes, created_at
       FROM artifacts
       WHERE workspace_id = ? AND notebook_id = ?
       ORDER BY created_at DESC`
    )
    .bind(workspaceId, notebookId)
    .all<ArtifactRecord>()

  return rows.results
}

export async function getArtifact(
  env: Env,
  workspaceId: string,
  notebookId: string,
  artifactId: string
): Promise<ArtifactRecord | null> {
  const db = requireDb(env)
  const row = await db
    .prepare(
      `SELECT id, workspace_id, notebook_id, title, template, content, snapshot_hashes, created_at
       FROM artifacts
       WHERE workspace_id = ? AND notebook_id = ? AND id = ?`
    )
    .bind(workspaceId, notebookId, artifactId)
    .first<ArtifactRecord>()

  return row ?? null
}
