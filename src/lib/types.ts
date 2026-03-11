// API key types — defined here to avoid circular imports between auth.ts and types.ts
export interface ApiKeyRecord {
  name: string
  scope: ApiKeyScope
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

export type ApiKeyScope = 'admin' | 'ingest' | 'read'

// Hono context variables set by middleware
export interface AppVariables {
  requestId: string
  authKey: string
  authRecord: ApiKeyRecord
}

// Cloudflare bindings
export interface Env {
  UPLOADS_BUCKET: R2Bucket
  INGESTION_QUEUE: Queue<IngestionMessage>
  KV: KVNamespace
  AI: Ai
  VECTORIZE: VectorizeIndex
  ASSETS: Fetcher

  // Vars
  EMBEDDING_MODEL: string
  EMBEDDING_DIMENSION: string
  BATCH_SIZE: string
}

// Queue message for ingestion jobs
export interface IngestionMessage {
  uploadId: string
  r2Key: string
  userId?: string
}

// Upload progress stored in KV
export interface UploadProgress {
  status: 'uploading' | 'processing' | 'completed' | 'failed'
  r2Key: string
  fileName: string
  fileSize: number
  totalConversations: number | null
  processedConversations: number
  lastCheckpointIndex: number
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

// Vectorize metadata stored alongside each vector.
// Vectorize has a 10KB metadata limit per vector, so full conversation
// text is stored in KV (conv:{id}) and only a preview goes here.
export interface ConversationMetadata {
  id: string
  title: string
  text_preview: string  // First 500 chars for display
  create_time: number
  update_time: number
  source: 'gpt' | 'claude'
  upload_id: string
}

// Full conversation record stored in KV
export interface ConversationRecord {
  id: string
  title: string
  text: string
  create_time: number
  update_time: number
  source: 'gpt' | 'claude'
  upload_id: string
}

// Search result returned to clients
export interface SearchResult {
  id: string
  title: string
  text: string
  create_time: number
  score: number
}

// Raw conversation formats
export interface GPTConversation {
  id?: string
  title?: string
  create_time?: number
  update_time?: number
  mapping?: Record<string, GPTMessageNode>
}

export interface GPTMessageNode {
  message?: {
    author?: { role?: string }
    content?: {
      parts?: Array<string | object>
    }
  }
}

export interface ClaudeConversation {
  uuid?: string
  name?: string
  created_at?: string
  updated_at?: string
  chat_messages?: Array<{
    sender?: string
    text?: string
  }>
}
