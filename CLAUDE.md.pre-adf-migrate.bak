# MindSpring

Semantic search engine for AI conversation exports, deployed on Cloudflare Workers.

## Commands

```bash
npm install          # Install dependencies
wrangler dev         # Local development server
npm run type-check   # TypeScript type checking (tsc --noEmit)
npm test             # Run tests (vitest run)
npm run test:watch   # Run tests in watch mode
wrangler deploy      # Deploy to Cloudflare Workers
```

## Project Structure

```
src/
  index.ts              — Hono app entry, middleware wiring, route registration
  queue.ts              — Queue consumer: stream-parse → embed → upsert
  lib/                  — Shared libraries
    types.ts            — Env bindings and shared interfaces
    auth.ts             — API key middleware with scope hierarchy
    telemetry.ts        — Structured event logging to KV
    rate-limit.ts       — KV-backed sliding window rate limiter
    validate.ts         — Request validation (body size, params, uploads)
    stream-parser.ts    — Zero-dependency streaming JSON parser for large files
    vectorize.ts        — Vectorize client with KV text hydration
    embeddings.ts       — Workers AI embedding generation
    generate.ts         — Workers AI text generation (DeepSeek R1 for RAG chat)
    extract.ts          — Conversation text extraction (ChatGPT + Claude formats)
    __tests__/          — Unit tests (vitest)
  routes/
    auth.ts             — API key CRUD (admin scope)
    upload.ts           — Simple + multipart upload flows
    search.ts           — Semantic search endpoint
    chat.ts             — RAG chat (retrieve → reason → respond)
    conversations.ts    — Browse, detail, similar
    stats.ts            — Collection stats + health check
    telemetry.ts        — Flow log query (admin scope)
frontend/
  index.html            — App shell
  styles.css            — "Infrastructure Noir" design system
  app.js                — Vanilla JS SPA (router, API client, pages)
openapi.yaml            — OpenAPI 3.1 specification (API source of truth)
wrangler.toml           — Cloudflare Workers config + bindings
```

## Key Patterns and Conventions

- **Runtime**: Cloudflare Workers with Hono framework. Single Worker serves both API and static frontend.
- **Language**: TypeScript (strict mode, ESNext target, bundler module resolution).
- **Only runtime dependency**: Hono. Everything else is Cloudflare platform bindings.
- **Module size limit**: Every module stays under 400 lines.
- **Storage**: Vectorize (vectors + metadata), KV (auth keys, conversation text, telemetry, rate limits), R2 (raw file uploads).
- **Auth**: API key via `Authorization: Bearer <key>` or `X-API-Key` header. Three scopes: `read` < `ingest` < `admin` (hierarchical).
- **Rate limiting**: KV-backed sliding window, configured per route group.
- **Telemetry**: Structured `TelemetryEnvelope` objects in KV under `flowlog:` prefix with 7-day TTL.
- **Ingestion pipeline**: Upload → R2 → Queue → streaming JSON parse → embed (Workers AI, bge-large-en-v1.5, 1024d) → upsert to Vectorize. Checkpoints to KV every 100 conversations for crash recovery.
- **Frontend**: Vanilla HTML/CSS/JS SPA with no build step. Served as static assets via Workers Assets binding.
- **Testing**: Vitest.

## API Endpoints

All `/api/*` routes require auth unless noted.

| Method | Path | Scope | Purpose |
|--------|------|-------|---------|
| GET | `/` | public | Service info / frontend |
| GET | `/api/search?q=` | read | Semantic search |
| POST | `/api/chat` | read | RAG chat |
| GET | `/api/conversations` | read | Browse conversations |
| GET | `/api/conversations/:id` | read | Single conversation |
| GET | `/api/conversations/:id/similar` | read | Similar conversations |
| POST | `/api/uploads/simple` | ingest | Small file upload (<5MB) |
| POST | `/api/uploads` | ingest | Initiate multipart upload |
| POST | `/api/uploads/:id/part` | ingest | Upload part |
| POST | `/api/uploads/:id/complete` | ingest | Finalize upload |
| GET | `/api/uploads/:id/status` | ingest | Ingestion progress |
| POST | `/api/auth/keys` | admin | Create API key |
| GET | `/api/auth/keys` | admin | List API keys |
| DELETE | `/api/auth/keys/:name` | admin | Revoke API key |
| GET | `/api/telemetry` | admin | Query flow logs |
| GET | `/api/telemetry/:id` | admin | Events for specific request/upload |
| GET | `/api/stats` | read | Vectorize index stats |
| GET | `/api/health` | read | Service health check |
