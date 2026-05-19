/*
  Boundary contract draft for MindSpring v0.2.
  This file is intentionally outside src/ so it does not affect runtime build.
*/

export type NotebookType =
  | 'dev_docs'
  | 'style_guide'
  | 'narrative_bible'
  | 'workflow_ops'
  | 'personal_archive'

export type SourceType = 'markdown' | 'txt' | 'pdf' | 'url' | 'chat_export'
export type SourceStatus = 'pending' | 'processing' | 'indexed' | 'failed'

export interface NotebookContractRecord {
  id: string
  workspaceId: string
  title: string
  description?: string
  type: NotebookType
  instructions: string
  createdAt: string
  updatedAt: string
}

export interface SourceContractRecord {
  id: string
  workspaceId: string
  notebookId: string
  title: string
  type: SourceType
  r2ObjectKey: string
  contentHash: string
  status: SourceStatus
  createdAt: string
}

export interface CitationContractRecord {
  id: string
  workspaceId: string
  notebookId: string
  sourceId: string
  chunkId: string
  chunkHash: string
  sourceHash: string
  retrievalScore: number
  charStart: number
  charEnd: number
}

export interface QueueIngestionPayloadV2 {
  job_id: string
  workspace_id: string
  notebook_id: string
  source_id: string
  r2_key: string
  parser_type: SourceType
  content_hash: string
}
