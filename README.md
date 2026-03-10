# MindSpring

Semantic search engine for AI conversation exports, deployed on Cloudflare Workers.

Upload your ChatGPT or Claude conversation exports, and MindSpring indexes them into a vector database for semantic search, topic discovery, and similarity analysis — all running at the edge with zero GPU infrastructure to manage.

## Architecture

```
Client → Hono API (Cloudflare Worker)
              ├── Qdrant Cloud (vector storage + search)
              ├── R2 (raw file storage)
              ├── Workers AI (embedding generation)
              ├── Queue (async ingestion pipeline)
              └── KV (state, auth, telemetry)
```

**Key design constraints:**

- Single Worker deployment — no multi-service orchestration
- Every module under 400 lines — strict decomposition
- Streaming JSON parser for files up to 1GB+ without memory bloat
- Zero external runtime dependencies beyond Hono

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers paid plan for Queue + AI)
- A [Qdrant Cloud](https://cloud.qdrant.io/) cluster (free tier works)

### 1. Clone and install

```bash
git clone https://github.com/Stackbilt-dev/mindspring.git
cd mindspring
npm install
```

### 2. Create Cloudflare resources

```bash
# KV namespace for state, auth keys, and telemetry
wrangler kv namespace create MINDSPRING_KV
wrangler kv namespace create MINDSPRING_KV --preview

# R2 bucket for uploaded conversation files
wrangler r2 bucket create mindspring-uploads

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

### 3. Set secrets

```bash
wrangler secret put QDRANT_CLOUD_URL
# Paste your Qdrant cluster URL, e.g.: https://xyz.us-east-1.aws.cloud.qdrant.io:6333

wrangler secret put QDRANT_API_KEY
# Paste your Qdrant API key
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Bootstrap an admin API key

```bash
wrangler kv key put --binding KV "apikey:your-initial-admin-key" \
  '{"name":"bootstrap","scope":"admin","createdAt":"2025-01-01T00:00:00Z","lastUsedAt":null,"revoked":false}'
```

Then use this key to create scoped keys via the API:

```bash
curl -X POST https://mindspring.<your-subdomain>.workers.dev/api/auth/keys \
  -H "Authorization: Bearer your-initial-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-ingest-key", "scope": "ingest"}'
```

## API Reference

All endpoints require an API key via `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### Search

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `GET` | `/api/search?q=<query>` | `read` | Semantic search. Params: `q` (required), `limit` (max 100), `threshold` (0-1), `start`/`end` (unix timestamps). |
| `GET` | `/api/conversations` | `read` | Browse all conversations. Params: `limit` (max 100), `offset` (cursor). |
| `GET` | `/api/conversations/:id` | `read` | Fetch a single conversation by ID. |
| `GET` | `/api/conversations/:id/similar` | `read` | Find similar conversations. Params: `limit` (max 20). |

### Upload & Ingestion

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| `POST` | `/api/uploads/simple` | `ingest` | Direct upload for files under 5MB. Send JSON as body with `X-File-Name` header. |
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
| `GET` | `/api/stats` | `read` | Vector store collection statistics. |
| `GET` | `/api/health` | `read` | Service health check (Qdrant + Workers AI). |
| `GET` | `/` | public | Service info and endpoint listing. |

## Supported Formats

MindSpring accepts conversation exports from:

- **ChatGPT** — `conversations.json` from [Settings → Data Controls → Export](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data)
- **Claude** — JSON exports with `chat_messages` arrays

Both array (`[{...}, ...]`) and object (`{"key": {...}, ...}`) JSON root formats are supported.

## Large File Handling

MindSpring is designed for large conversation archives (hundreds of MB to 1GB+):

1. **Upload**: Files under 5MB use the simple upload path. Larger files use R2 multipart upload — chunks are sent directly to object storage, never buffered in Worker memory.
2. **Ingestion**: A streaming JSON parser reads the file from R2 chunk by chunk, extracting conversations without loading the entire file into memory. Peak memory usage is ~2x the largest single conversation object.
3. **Checkpointing**: Progress is saved to KV after every batch of 100 conversations. If the Worker hits CPU limits or crashes, the Queue redelivers the message and ingestion resumes from the last checkpoint.
4. **Embeddings**: Text is embedded via Cloudflare Workers AI (`@cf/baai/bge-large-en-v1.5`, 1024 dimensions) in sub-batches of 96.

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

Lightweight KV-backed rate limiting protects all endpoints:

| Endpoint Group | Limit |
|---------------|-------|
| Search / Browse | 60 requests/minute per key |
| Upload / Ingest | 10 requests/minute per key |

Rate limit headers are included in every response:
- `X-RateLimit-Limit` — max requests per window
- `X-RateLimit-Remaining` — requests remaining
- `X-RateLimit-Reset` — unix timestamp when the window resets

## Development

```bash
# Local development (uses .dev.vars for secrets)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Qdrant credentials
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
│   ├── qdrant.ts             — Qdrant Cloud REST client
│   ├── embeddings.ts         — Workers AI embedding generation
│   └── extract.ts            — Conversation text extraction (GPT + Claude)
├── routes/
│   ├── auth.ts               — API key CRUD (admin)
│   ├── upload.ts             — Simple + multipart upload flows
│   ├── search.ts             — Semantic search, browse, detail, similar
│   ├── stats.ts              — Collection stats + health check
│   └── telemetry.ts          — Flow log query (admin)
```

## Configuration

### Environment Variables (`wrangler.toml` vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_COLLECTION` | `conversations` | Qdrant collection name |
| `EMBEDDING_MODEL` | `@cf/baai/bge-large-en-v1.5` | Workers AI embedding model |
| `EMBEDDING_DIMENSION` | `1024` | Vector dimension (must match model) |
| `BATCH_SIZE` | `100` | Conversations per ingestion batch |

### Secrets (set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `QDRANT_CLOUD_URL` | Qdrant Cloud cluster URL |
| `QDRANT_API_KEY` | Qdrant Cloud API key |

### Cloudflare Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `UPLOADS_BUCKET` | R2 | Raw conversation file storage |
| `INGESTION_QUEUE` | Queue | Async ingestion job dispatch |
| `KV` | KV Namespace | Auth keys, upload progress, processed IDs, telemetry |
| `AI` | Workers AI | Embedding generation |

## License

MIT
