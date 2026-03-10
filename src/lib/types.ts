// Cloudflare bindings
export interface Env {
  UPLOADS_BUCKET: R2Bucket
  INGESTION_QUEUE: Queue<IngestionMessage>
  KV: KVNamespace
  AI: Ai

  // Vars
  QDRANT_COLLECTION: string
  EMBEDDING_MODEL: string
  EMBEDDING_DIMENSION: string
  BATCH_SIZE: string

  // Secrets
  QDRANT_CLOUD_URL: string
  QDRANT_API_KEY: string
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

// Qdrant point payload
export interface ConversationPayload {
  id: string
  title: string
  text: string
  create_time: number
  update_time: number
  source: 'gpt' | 'claude'
  upload_id: string
}

// Search result from Qdrant
export interface SearchResult {
  id: string
  title: string
  text: string
  create_time: number
  score: number
}

// Qdrant API types
export interface QdrantSearchResponse {
  result: Array<{
    id: string
    version: number
    score: number
    payload: ConversationPayload
  }>
  status: string
  time: number
}

export interface QdrantUpsertPoint {
  id: string
  vector: number[]
  payload: ConversationPayload
}

export interface QdrantCollectionInfo {
  result: {
    vectors_count: number
    indexed_vectors_count: number
    points_count: number
    segments_count: number
    status: string
  }
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
