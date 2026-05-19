# MindSpring Architecture

## Runtime Model

- Cloudflare Worker (Hono) serves API + static SPA
- Queue consumer handles asynchronous ingestion
- Data planes:
  - Vectorize: embeddings + lightweight metadata
  - KV: fast hydration + request telemetry + v1 progress states
  - D1: v2 relational notebook/source/chunk/job state
  - R2: raw uploaded source files

## v1 vs v2 Boundaries

### v1 (`/api/*`)

- Primary primitive: conversation archive
- Storage pattern:
  - full conversation text in KV (`conv:*`)
  - vector metadata in Vectorize
- Ingestion supports JSON array/object conversation exports

### v2 (`/api/v2/workspaces/:workspaceId/notebooks/*`)

- Primary primitive: Knowledge Notebook (workspace scoped)
- Storage pattern:
  - notebooks/sources/chunks/jobs in D1
  - vectors in Vectorize with notebook/source/chunk metadata pointers
  - raw files in R2
- Ingestion supports parser-typed jobs from source registration
- Current parser coverage: `markdown`, `txt`, `chat_export` (+ NDJSON thread-compatible ingest path)
- Artifacts are persisted in D1 with `snapshot_hashes`; stale state is computed by comparing current source hashes.

## Query Flow

1. request enters notebook scoped route
2. embedding generated via Workers AI
3. vector search in Vectorize
4. notebook scope enforced via metadata filter + app-level guard
5. fallback to D1 chunk retrieval when vector/generation path degrades

## Deletion Model

- Notebook delete is soft-delete (`deleted_at`) in D1
- Sources under notebook are soft-deleted together
- This avoids irreversible data loss and enables async cleanup workflows

## Design Constraints

- Module size cap: < 400 lines per source module
- Keep runtime dependency surface minimal (Hono only)
- Prefer deterministic, source-grounded outputs with explicit citations
- Keep OSS-safe boundaries: no secrets/PII artifacts in tracked files
