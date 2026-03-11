# MindSpring Cloud — Product Requirements Document

> **Note:** This PRD was written during initial planning and references Qdrant Cloud as the vector store. During implementation, the project pivoted to **Cloudflare Vectorize** to keep the entire stack Cloudflare-native. Full conversation text is stored in KV (`conv:{id}`) due to Vectorize's 10KB metadata limit. All other architectural decisions remain as described. See `README.md` for the current architecture.

## 1. Overview

Replatform MindSpring from a local Python/Streamlit application to a cloud-native TypeScript service deployed on Cloudflare, using Hono as the API framework. The resulting product is a web service where users upload their GPT/Claude conversation exports, which are ingested asynchronously, embedded, stored in a vector database, and made searchable through a browser-based UI.

### 1.1 Why Cloudflare

- Edge-first: search responses served from nearest PoP
- Workers AI: embedding generation without managing GPU infra
- R2 + Queues: native primitives for file storage and async ingestion
- Zero cold-start on paid plan; predictable pricing at scale

### 1.2 Core User Story

> "I export my ChatGPT or Claude conversations, upload the JSON file to MindSpring Cloud, and within minutes I can semantically search and explore topic relationships across all my conversations from any browser."

---

## 2. Architecture

```
                         ┌─────────────────────┐
                         │   Frontend (SPA)     │
                         │  Pages / Static Assets│
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │    Hono API Worker    │
                         │  (Routes + Auth)      │
                         └──┬─────┬─────┬───────┘
                            │     │     │
               ┌────────────▼┐  ┌▼────▼────────┐
               │   Qdrant    │  │  R2 Bucket    │
               │   Cloud     │  │  (raw uploads)│
               └─────────────┘  └──────┬────────┘
                                       │
                              ┌────────▼─────────┐
                              │  Ingestion Worker │
                              │  (Queue Consumer) │
                              │  + Workers AI     │
                              └──────────────────┘
```

### 2.1 Components

| Component | Technology | Purpose |
|---|---|---|
| API Worker | Hono on Cloudflare Workers | Routes, auth, search, stats |
| Ingestion Worker | Cloudflare Queue consumer | Async chunking, embedding, upsert |
| Vector DB | Qdrant Cloud | Vector storage + search |
| File Storage | Cloudflare R2 | Raw conversation JSON uploads |
| Embeddings | Cloudflare Workers AI | Replace Ollama (`@cf/baai/bge-large-en-v1.5`, 1024-dim) |
| Frontend | Static SPA (Cloudflare Pages) | Search UI, topic map, upload |
| Auth | Cloudflare Access or simple API keys | Protect user data |

---

## 3. The Big File Problem

**This is the critical design constraint.** Conversation exports are the single largest payload users will send. A ChatGPT `conversations.json` with years of history can easily be **200MB-1GB+**. Claude exports are similarly large.

### 3.1 Constraints

| Limit | Value |
|---|---|
| Workers request body (free) | 100 MB |
| Workers request body (paid) | 100 MB |
| Workers CPU time (paid) | 30s per request (soft), 15min via Cron/Queue |
| R2 single PUT | 5 GB |
| R2 multipart upload | 5 TB (parts: 5MB-5GB each) |
| Queue message size | 128 KB |
| Workers AI batch embedding | Model-dependent (~96 inputs/call) |

### 3.2 Upload Strategy: Multipart Direct-to-R2

The API Worker **never buffers the full file in memory**. Instead:

1. **Client requests upload session** — `POST /api/uploads` returns a presigned R2 multipart upload ID + part URLs
2. **Client uploads parts directly to R2** — browser streams the file in ~10MB chunks using the [R2 multipart upload API](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/), bypassing the 100MB Worker body limit entirely
3. **Client completes upload** — `POST /api/uploads/:id/complete` signals the API Worker
4. **API Worker enqueues ingestion job** — pushes a message to the Cloudflare Queue with the R2 object key

```
Browser                API Worker              R2
  │                        │                    │
  ├─ POST /uploads ───────►│                    │
  │◄── uploadId + parts ───┤                    │
  │                        │                    │
  ├─ PUT part 1 ──────────────────────────────►│
  ├─ PUT part 2 ──────────────────────────────►│
  ├─ PUT part N ──────────────────────────────►│
  │                        │                    │
  ├─ POST /uploads/:id ──►│                    │
  │   /complete            ├─ completeUpload ─►│
  │                        ├─ enqueue job       │
  │◄── 202 Accepted ──────┤                    │
```

### 3.3 Ingestion Pipeline (Queue Consumer)

The Ingestion Worker processes uploads asynchronously with a **streaming chunked approach** — the spiritual successor to `split_json.py` + `load_conversations.py`:

```
R2 Object (raw JSON)
    │
    ▼
Stream-parse with JSON tokenizer (equivalent of ijson)
    │
    ▼
Buffer conversations in batches of 100
    │
    ▼
For each batch:
    ├─ Extract text (GPT mapping / Claude messages format)
    ├─ Generate embeddings via Workers AI (sub-batches of 96)
    ├─ Upsert vectors to Qdrant Cloud
    └─ Update progress record in KV
```

**Key design decisions for large files:**

- **Stream parsing, not `JSON.parse()`** — Use a streaming JSON parser (e.g., `@streamparser/json` or `oboe.js`) to avoid loading the entire file into memory. Workers have 128MB memory limit.
- **Checkpoint/resume** — Store progress (last processed index) in KV. If the Worker hits CPU limits or fails, the Queue will redeliver and the worker resumes from checkpoint. Maps to existing `processed_conversations.json` pattern.
- **Batch alignment** — 100 conversations per batch, matching the current pipeline's mathematical harmony.
- **Backpressure** — If Qdrant or Workers AI is slow, reduce batch concurrency rather than buffering in memory.

### 3.4 File Size Tiers

| File Size | Strategy |
|---|---|
| < 5 MB | Direct upload via Worker body (`POST /api/uploads/simple`). No multipart needed. |
| 5 MB - 100 MB | Multipart upload, single Queue message, stream-process in one invocation |
| 100 MB - 1 GB | Multipart upload, single Queue message, stream-process with KV checkpointing across potential retries |
| > 1 GB | Multipart upload, Worker splits R2 object into logical segments, enqueues one message per segment for parallel ingestion |

---

## 4. API Routes

### 4.1 Upload & Ingestion

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/uploads` | Initiate multipart upload session |
| `POST` | `/api/uploads/simple` | Direct upload for small files (<5MB) |
| `POST` | `/api/uploads/:id/complete` | Complete multipart upload, enqueue ingestion |
| `GET` | `/api/uploads/:id/status` | Poll ingestion progress (reads from KV) |

### 4.2 Search & Browse

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/search?q=&limit=&threshold=` | Semantic search across conversations |
| `GET` | `/api/search?q=&start=&end=` | Search with time filters |
| `GET` | `/api/conversations?limit=&offset=` | Browse/paginate all conversations |
| `GET` | `/api/conversations/:id` | Single conversation detail |
| `GET` | `/api/conversations/:id/similar` | Find similar conversations |

### 4.3 Stats & Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stats` | Collection stats (vector count, etc.) |
| `GET` | `/api/health` | Health check (Qdrant connectivity, Workers AI) |

---

## 5. Data Model

### 5.1 Qdrant Point Schema

Unchanged from current implementation — preserves migration path:

```typescript
interface ConversationPoint {
  id: string            // MD5 hash of conversation ID
  vector: number[]      // 1024-dim embedding
  payload: {
    id: string          // Original conversation ID
    title: string
    text: string        // Extracted conversation text
    create_time: number // Unix timestamp
    update_time: number
    source: 'gpt' | 'claude'  // NEW: track origin format
    upload_id: string          // NEW: link back to upload
  }
}
```

### 5.2 KV Schemas

**Upload Progress** (`MINDSPRING_KV`):

```typescript
// Key: upload:{uploadId}
interface UploadProgress {
  status: 'uploading' | 'processing' | 'completed' | 'failed'
  r2Key: string
  totalConversations: number | null  // null until stream-count known
  processedConversations: number
  lastCheckpointIndex: number
  errorMessage?: string
  createdAt: string
  updatedAt: string
}
```

**Processed IDs** (`MINDSPRING_KV`):

```typescript
// Key: processed:{conversationId}
// Value: "1"
// TTL: none
// Replaces processed_conversations.json
```

---

## 6. Conversation Text Extraction

Port directly from `ConversationVectorStore._extract_conversation_text()`:

```typescript
function extractConversationText(conversation: Record<string, any>): string {
  const messages: string[] = []

  if (conversation.mapping) {
    // GPT format: mapping -> nodes -> message -> content -> parts
    for (const node of Object.values(conversation.mapping)) {
      const msg = (node as any)?.message
      if (msg?.content?.parts?.[0] && typeof msg.content.parts[0] === 'string') {
        const role = msg.author?.role ?? 'unknown'
        messages.push(`${role}: ${msg.content.parts[0]}`)
      }
    }
  } else if (conversation.messages) {
    // Claude format: messages array -> role + content
    for (const msg of conversation.messages) {
      if (msg?.content) {
        messages.push(`${msg.role ?? 'unknown'}: ${msg.content}`)
      }
    }
  }

  const title = conversation.title ?? 'Untitled Conversation'
  return `Title: ${title}\n\n${messages.join('\n')}`
}
```

---

## 7. Embedding Strategy

### 7.1 Model Selection

| Option | Dimensions | Notes |
|---|---|---|
| `@cf/baai/bge-large-en-v1.5` | 1024 | Best match for current 1024-dim schema |
| `@cf/baai/bge-base-en-v1.5` | 768 | Faster, lower cost, requires schema change |
| `@cf/baai/bge-small-en-v1.5` | 384 | Lightest option |

**Recommendation:** Start with `bge-large-en-v1.5` (1024-dim) to maintain compatibility with any existing Qdrant data. Can downsize later with a re-embedding migration.

### 7.2 Workers AI Batching

Workers AI embedding models accept arrays of inputs. Optimal batch size varies but ~96 inputs per call is safe. The ingestion worker should:

1. Collect 100 conversations (pipeline batch)
2. Extract text from each
3. Split into sub-batches of 96 for embedding calls
4. Reassemble and upsert to Qdrant

---

## 8. Frontend Requirements

Replace Streamlit with a static SPA deployed to Cloudflare Pages.

### 8.1 Pages

| Page | Replaces | Features |
|---|---|---|
| **Upload** | (new) | Drag-and-drop JSON upload, progress bar, format detection |
| **Search** | `Home.py` | Semantic search input, relevance slider, paginated results, conversation detail panel |
| **Topic Map** | `pages/1_Topic_Map.py` | Interactive graph visualization (vis-network or D3 force layout), similarity edges, click-to-inspect |

### 8.2 Tech Stack (Suggested)

- Framework: React or Solid (lightweight; works with Pages)
- Styling: Tailwind CSS (dark theme: `#1a1a1a` bg, `#e0e0e0` text — preserve current aesthetic)
- Graph: `vis-network` (same library backing `streamlit_agraph`) or `@antv/g6`
- Upload: `tus-js-client` or custom multipart chunker

---

## 9. Environment & Configuration

### 9.1 Cloudflare Bindings

```toml
# wrangler.toml
name = "mindspring"

[[r2_buckets]]
binding = "UPLOADS_BUCKET"
bucket_name = "mindspring-uploads"

[[queues.producers]]
binding = "INGESTION_QUEUE"
queue = "mindspring-ingestion"

[[queues.consumers]]
queue = "mindspring-ingestion"
max_batch_size = 1
max_retries = 3

[vars]
QDRANT_COLLECTION = "conversations"
EMBEDDING_MODEL = "@cf/baai/bge-large-en-v1.5"
EMBEDDING_DIMENSION = "1024"
BATCH_SIZE = "100"

# Secrets (set via `wrangler secret put`):
# QDRANT_CLOUD_URL
# QDRANT_API_KEY
```

### 9.2 Mapped from Current Config

| Current (.env) | Cloudflare Equivalent |
|---|---|
| `QDRANT_USE_CLOUD` | Always true (cloud-only) |
| `QDRANT_CLOUD_URL` | Wrangler secret |
| `QDRANT_API_KEY` | Wrangler secret |
| `QDRANT_LOCAL_PATH` | Removed (no local mode) |
| `QDRANT_COLLECTION` | Wrangler var |
| `OLLAMA_MODEL` | Replaced by `EMBEDDING_MODEL` var |
| `OLLAMA_URL` | Removed (Workers AI is in-process) |
| `BATCH_SIZE` | Wrangler var |
| `MAX_RETRIES` | Queue `max_retries` config |

---

## 10. What Gets Dropped

| Current Dependency | Reason |
|---|---|
| Streamlit | Replaced by SPA + Hono API |
| Ollama | Replaced by Workers AI |
| spacy / nltk | Unused in core search path; sentiment analysis deferred to v2 |
| numpy | `Float64Array` or plain arrays sufficient |
| psutil | No process monitoring on Workers; use Workers Analytics |
| watchdog | No filesystem; replaced by Queue-based ingestion |
| portalocker | No local file locks; Qdrant Cloud handles concurrency |
| ijson | Replaced by JS streaming JSON parser |
| Local Qdrant | Cloud-only deployment |

---

## 11. Migration Path

### Phase 1: API + Ingestion (MVP)
- Hono API Worker with search, browse, stats routes
- R2 multipart upload flow
- Queue-based ingestion with stream parsing
- Workers AI embeddings
- Qdrant Cloud integration
- Minimal frontend: upload page + search page

### Phase 2: Feature Parity
- Topic Map visualization
- Time-filtered search
- Similar conversation discovery
- Dark theme UI matching current aesthetic
- Upload history and re-ingestion

### Phase 3: Cloud-Native Enhancements
- User accounts (Cloudflare Access or auth provider)
- Per-user collections / namespacing in Qdrant
- Scheduled re-embedding when models improve
- Analytics dashboard (popular searches, usage patterns)
- Export/download processed data

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Workers AI embedding quality differs from `mxbai-embed-large` | Search relevance changes | Benchmark both models on sample data before committing; Qdrant supports multiple named vectors if dual-indexing needed |
| 1GB+ file ingestion exceeds Queue consumer CPU time | Ingestion stalls | KV checkpointing + Queue retry; segment large files into multiple Queue messages |
| Streaming JSON parser memory pressure on Workers (128MB limit) | OOM crashes | Process one conversation at a time from stream; never buffer more than one batch |
| Qdrant Cloud latency from Workers edge | Slow search | Qdrant Cloud regions align with major CF datacenters; add response caching with Cache API for repeated queries |
| R2 multipart upload complexity in browser | Poor upload UX | Use `tus-js-client` or well-tested multipart library; provide fallback for small files |

---

## 13. Success Metrics

- Upload-to-searchable latency: < 5 minutes for a 100MB file
- Search response time: < 500ms p95
- Zero local dependencies required for end users
- Supports files up to 1GB without failure
- Cost: < $25/month at moderate usage (10 users, 50k conversations)
