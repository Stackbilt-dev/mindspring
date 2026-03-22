<div align="center">
<img src="assets/banner.png" alt="MindSpring — semantic conversation search" width="100%" />
</div>

# MindSpring

Semantic search engine for AI conversation exports, deployed on Cloudflare Workers.

Upload your ChatGPT or Claude conversation exports, and MindSpring indexes them into a vector database for semantic search, similarity analysis, and RAG-powered chat — all running at the edge with zero GPU infrastructure to manage.

## Architecture

```
Browser (SPA) → Hono API (Cloudflare Worker)
                    ├── Vectorize (vector storage + search)
                    ├── R2 (raw file storage)
                    ├── Workers AI (embeddings + text generation)
                    ├── Queue (async ingestion pipeline)
                    └── KV (state, auth, conversation text, telemetry)
```

**Key design constraints:**

- Single Worker deployment — API + static frontend served together
- Fully Cloudflare-native — no external services (Vectorize, not Qdrant)
- Every module under 400 lines — strict decomposition
- Streaming JSON parser for files up to 1GB+ without memory bloat
- Zero external runtime dependencies beyond Hono

## Frontend

MindSpring includes a vanilla HTML/CSS/JS single-page application served as static assets from the Worker. No build step, no framework dependencies.

**Pages:**

- **Search** — Semantic search with debounced input, score bars, staggered card animations
- **Chat** — RAG-powered conversational interface for asking questions about your conversation history. Uses DeepSeek R1 reasoning model to synthesize insights across multiple conversations, with collapsible reasoning blocks and source citations
- **Upload** — Drag-and-drop file upload with multipart chunking for large files (50MB chunks) and real-time progress
- **Detail** — Full conversation view with message threading and similar conversation discovery
- **Settings** — API key configuration and system health dashboard

**Design system:** "Infrastructure Noir" aesthetic using the Cloud Architecture palette — Midnight Console, Architectural Tan, Visionary Purple, System Green, Cloudflare Cyan. Typography: Syne (display), DM Sans (body), JetBrains Mono (data).

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers paid plan for Queue + AI + Vectorize)

### 1. Clone and install

```bash
git clone https://github.com/Stackbilt-dev/mindspring.git
cd mindspring
npm install
```

### 2. Create Cloudflare resources

```bash
# KV namespace for state, auth keys, conversation text, and telemetry
wrangler kv namespace create MINDSPRING_KV
wrangler kv namespace create MINDSPRING_KV --preview

# R2 bucket for uploaded conversation files
wrangler r2 bucket create mindspring-uploads

# Vectorize index for semantic search
wrangler vectorize create mindspring-conversations --dimensions=1024 --metric=cosine

# Queue for async ingestion
wrangler queues create mindspring-ingestion
wrangler queues create mindspring-ingestion-dlq
```

Paste the KV namespace IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "<your-kv-id>"
preview_id = "<your-preview-kv-id>"
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your CLOUDFLARE_API_TOKEN
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Bootstrap an admin API key

```bash
wrangler kv key put --binding KV "apikey:your-initial-admin-key" \
  '{"name":"bootstrap","scope":"admin","createdAt":"2025-01-01T00:00:00Z","lastUsedAt":null,"revoked":false}' \
  --preview false --remote
```

Then use this key to create scoped keys via the API:

```bash
curl -X POST https://mindspring.<your-subdomain>.workers.dev/api/auth/keys \
  -H "Authorization: Bearer your-initial-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-ingest-key", "scope": "ingest"}'
```

### 6. Use the frontend

Open your Worker URL in a browser. Go to **Settings**, paste your API key, and save. You can now search conversations and upload files through the UI.

## API Reference

All endpoints require an API key via `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### Search & Chat

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/search?q=<query>` | `read` | Semantic search. Params: `q` (required), `limit` (max 100), `threshold` (0-1). |
| `POST` | `/api/chat` | `read` | RAG chat. Body: `{"question": "...", "history": [...]}`. Returns `{"answer": "...", "sources": [...]}`. |
| `GET` | `/api/conversations` | `read` | Browse all conversations. Params: `limit` (max 100), `cursor`. |
| `GET` | `/api/conversations/:id` | `read` | Fetch a single conversation by ID. |
| `GET` | `/api/conversations/:id/similar` | `read` | Find similar conversations. Params: `limit` (max 20). |

### Upload & Ingestion

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/api/uploads/simple` | `ingest` | Direct upload for files under 5MB. Send file as body with `X-File-Name` header. |
| `POST` | `/api/uploads` | `ingest` | Initiate multipart upload for large files. Body: `{"fileName": "...", "fileSize": N}`. |
| `POST` | `/api/uploads/:id/part` | `ingest` | Upload a part. Query: `partNumber`, `multipartUploadId`. |
| `POST` | `/api/uploads/:id/complete` | `ingest` | Finalize upload and start ingestion. Body: `{"multipartUploadId": "...", "parts": [...]}`. |
| `GET` | `/api/uploads/:id/status` | `ingest` | Poll ingestion progress. |

### Admin

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/api/auth/keys` | `admin` | Create a new API key. Body: `{"name": "...", "scope": "read\|ingest\|admin"}`. |
| `GET` | `/api/auth/keys` | `admin` | List all API keys (metadata only). |
| `DELETE` | `/api/auth/keys/:name` | `admin` | Revoke an API key by name. |
| `GET` | `/api/telemetry` | `admin` | Query flow log events. Params: `limit` (max 200), `category`, `cursor`. |
| `GET` | `/api/telemetry/:id` | `admin` | Get all events for a specific request or upload ID. |

### System

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/stats` | `read` | Vectorize index statistics. |
| `GET` | `/api/health` | `read` | Service health check (Vectorize + Workers AI). |
| `GET` | `/` | public | Service info and endpoint listing (or frontend UI if assets are deployed). |

The full OpenAPI 3.1 specification is in [`openapi.yaml`](openapi.yaml).

## Supported Formats

MindSpring accepts conversation exports from:

- **ChatGPT** — `conversations.json` from [Settings > Data Controls > Export](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)
- **Claude** — JSON exports with `chat_messages` arrays

Both array (`[{...}, ...]`) and object (`{"key": {...}, ...}`) JSON root formats are supported.

## Large File Handling

MindSpring is designed for large conversation archives (hundreds of MB to 1GB+):

1. **Upload**: Files under 5MB use the simple upload path. Larger files use R2 multipart upload — the frontend automatically chunks at 50MB boundaries and uploads parts sequentially with progress tracking. Chunks are sent directly to R2, never buffered in Worker memory.
2. **Ingestion**: A streaming JSON parser reads the file from R2 chunk by chunk, extracting conversations without loading the entire file into memory. Peak memory usage is ~2x the largest single conversation object.
3. **Checkpointing**: Progress is saved to KV after every batch of 100 conversations. If the Worker hits CPU limits or crashes, the Queue redelivers the message and ingestion resumes from the last checkpoint.
4. **Embeddings**: Text is embedded via Cloudflare Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024 dimensions) in sub-batches of 96.
5. **Storage**: Vectors and metadata previews are stored in Vectorize (10KB metadata limit). Full conversation text is stored in KV under `conv:{id}` keys, hydrated on read.

## RAG Chat

MindSpring includes a conversational RAG (Retrieval-Augmented Generation) interface powered by DeepSeek R1, a reasoning model running on Workers AI.

**How it works:**

1. Your question is embedded and used to retrieve the top 8 most relevant conversations from Vectorize
2. Retrieved conversations are packed into a context window (~4K tokens) as source material
3. DeepSeek R1 (`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`) reasons across the retrieved conversations and synthesizes an answer
4. The response includes source citations linking back to specific conversations

**What makes it useful:**

- Surfaces **cross-conversation patterns** — recurring themes, evolving thinking, contradictions
- Supports **multi-turn chat** — follow up on previous answers with up to 4 exchanges of history
- **Collapsible reasoning blocks** — see the model's chain of thought or hide it for cleaner output
- Every answer cites its **source conversations** with relevance scores, clickable to view the full conversation

## Auth Model

API keys have one of three scopes, with hierarchical access:

| Scope | Access |
|-------|--------|
| `read` | Search, browse conversations, stats, health |
| `ingest` | Everything in `read` + upload files and trigger ingestion |
| `admin` | Everything in `ingest` + key management and telemetry |

Keys are stored in KV. The bootstrap key is created via `wrangler kv key put`; subsequent keys are managed through the `/api/auth/keys` endpoints.

## Telemetry

Every API request and ingestion lifecycle event writes a structured `TelemetryEnvelope` to KV under the `flowlog:` prefix with a 7-day TTL. Envelopes include:

- Request ID, timestamp, HTTP method/path/status
- Duration in milliseconds
- Auth key identity (name, not the raw key)
- Ingestion progress (started, batch_complete, completed, failed)
- Error details with stack traces

Query telemetry via `GET /api/telemetry` (admin scope required).

## Rate Limiting

KV-backed sliding window rate limiting protects all endpoints:

| Endpoint Group | Limit |
|---------------|-------|
| Search / Browse / Conversations | 60 requests/minute per key |
| Chat (RAG) | 20 requests/minute per key |
| Upload status polling | 60 requests/minute per key |
| Upload mutations | 20 requests/minute per key |

Rate limit headers are included in every response:
- `X-RateLimit-Limit` — max requests per window
- `X-RateLimit-Remaining` — requests remaining
- `X-RateLimit-Reset` — unix timestamp when the window resets

## Development

```bash
# Install dependencies
npm install

# Local development
wrangler dev

# Type check
npm run type-check

# Run tests
npm test

# Deploy
wrangler deploy
```

## Project Structure

```
src/
├── index.ts                  — Hono app, middleware wiring, route registration
├── queue.ts                  — Queue consumer: stream-parse → embed → upsert
├── lib/
│   ├── types.ts              — Env bindings, shared interfaces
│   ├── auth.ts               — API key middleware, scope hierarchy
│   ├── telemetry.ts          — Structured event logging to KV
│   ├── rate-limit.ts         — KV-backed sliding window rate limiter
│   ├── validate.ts           — Request validation (body size, params, uploads)
│   ├── stream-parser.ts      — Zero-dep streaming JSON parser for large files
│   ├── vectorize.ts          — Cloudflare Vectorize client (vectors + KV text hydration)
│   ├── embeddings.ts         — Workers AI embedding generation
│   ├── generate.ts           — Workers AI text generation (DeepSeek R1 for RAG chat)
│   ├── extract.ts            — Conversation text extraction (GPT + Claude)
│   └── __tests__/            — Unit tests
├── routes/
│   ├── auth.ts               — API key CRUD (admin)
│   ├── upload.ts             — Simple + multipart upload flows
│   ├── search.ts             — Semantic search
│   ├── chat.ts               — RAG chat (retrieve → reason → respond)
│   ├── conversations.ts      — Browse, detail, similar
│   ├── stats.ts              — Collection stats + health check
│   └── telemetry.ts          — Flow log query (admin)
frontend/
├── index.html                — App shell (header, nav, main container)
├── styles.css                — Infrastructure Noir design system
└── app.js                    — Vanilla JS SPA (router, API client, pages)
openapi.yaml                  — OpenAPI 3.1 specification (source of truth)
wrangler.toml                 — Cloudflare Workers configuration + bindings
```

## Configuration

### Environment Variables (`wrangler.toml` vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `@cf/baai/bge-large-en-v1.5` | Workers AI embedding model |
| `EMBEDDING_DIMENSION` | `1024` | Vector dimension (must match model) |
| `BATCH_SIZE` | `100` | Conversations per ingestion batch |

### Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `UPLOADS_BUCKET` | R2 | Raw conversation file storage |
| `INGESTION_QUEUE` | Queue | Async ingestion job dispatch |
| `KV` | KV Namespace | Auth keys, upload progress, conversation text, telemetry |
| `AI` | Workers AI | Embedding generation + RAG text generation |
| `VECTORIZE` | Vectorize | Vector search index (1024-dim, cosine similarity) |
| `ASSETS` | Assets | Static frontend files |

## License

MIT

---

Built by [Stackbilt](https://stackbilt.dev) — MIT License

<p>
  <a href="https://github.com/Stackbilt-dev/mindspring">
    <img src="https://img.shields.io/badge/GitHub-Stackbilt--dev/mindspring-181717?style=for-the-badge&logo=github" alt="GitHub" />
  </a>
</p>
