# MindSpring Agent API Guide

This guide is for AI agents and automation clients that need deterministic access to the MindSpring backend.

## Base Configuration

Required environment variables:

```bash
export MINDSPRING_BASE_URL="https://mindspring.blue-pine-edf6.workers.dev"
export MINDSPRING_API_KEY="<ingest-or-admin-key>"
```

Auth header used on all requests:

```bash
-H "Authorization: Bearer ${MINDSPRING_API_KEY}"
```

## Notebook Types

Allowed `type` values:

- `conversation_archive`
- `dev_docs`
- `style_guide`
- `narrative_bible`
- `workflow_ops`
- `personal_archive`
- `research`

## End-to-End Flow (v2)

### 1) Create notebook

```bash
WORKSPACE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

curl -sS -X POST "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "My Knowledge Notebook",
    "type": "research",
    "instructions": "Answer only from source evidence and cite chunks."
  }'
```

Capture `id` as `NOTEBOOK_ID`.

### 2) Upload source file to ingest queue

For small payloads (< 5MB), use simple upload:

```bash
UPLOAD_PAYLOAD='{"id":"thread-1","title":"Example","create_time":1710000000,"messages":[{"author":{"role":"user"},"content":{"parts":["Hello"]}}]}'

UPLOAD_ID=$(curl -sS -X POST "${MINDSPRING_BASE_URL}/api/uploads/simple" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/x-ndjson" \
  -H "X-File-Name: source.ndjson" \
  --data-binary "${UPLOAD_PAYLOAD}" | jq -r '.uploadId')
```

### 3) Register source in notebook

```bash
curl -sS -X POST "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/sources" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Source A\",\"type\":\"chat_export\",\"sourceUploadId\":\"${UPLOAD_ID}\",\"parserType\":\"chat_export\"}"
```

Capture `jobId`.

### 4) Poll ingestion job status

```bash
JOB_ID="<job-id>"

curl -sS "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/jobs/${JOB_ID}" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}"
```

Terminal states:

- `completed`
- `failed` (check `errorMessage`)

### 5) Notebook-scoped search

```bash
curl -sS -X POST "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/search" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query":"What are recurring ingestion themes?","limit":10,"threshold":0.0}'
```

### 6) Notebook-scoped chat

```bash
curl -sS -X POST "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/chat" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize this notebook and cite sources."}'
```

Response includes `response` + `citations[]`.

### 7) Create artifact

```bash
curl -sS -X POST "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/artifacts" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"template":"briefing_doc"}'
```

### 8) List and fetch artifacts

```bash
curl -sS "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/artifacts" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}"

curl -sS "${MINDSPRING_BASE_URL}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${NOTEBOOK_ID}/artifacts/<artifactId>" \
  -H "Authorization: Bearer ${MINDSPRING_API_KEY}"
```

Artifact responses include `snapshotHashes` and `stale`.

## Agent Reliability Rules

### Rate limiting and retries

MindSpring returns `429` with:

- `Retry-After`
- `X-RateLimit-*` headers

Agent policy:

1. On `429`, wait `Retry-After` seconds.
2. Retry with exponential backoff and jitter for 5xx/network errors.
3. Do not poll job status faster than every 2 seconds.

### Idempotency guidance

- Re-uploading already ingested conversations is safe for v1 dedupe semantics via `processed:<id>`.
- For v2 source registration, treat each `sourceUploadId` + `notebookId` pair as a single source intent.

### Failure handling

- `404` on notebook/source/job endpoints: verify `workspaceId` and object IDs are from same workspace scope.
- `failed` ingestion job: inspect `errorMessage`, fix parser type or source payload shape, retry with a fresh upload/source registration.

## Endpoint Summary (v2)

- `POST /api/v2/workspaces/:workspaceId/notebooks`
- `GET /api/v2/workspaces/:workspaceId/notebooks`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId`
- `PATCH /api/v2/workspaces/:workspaceId/notebooks/:notebookId`
- `DELETE /api/v2/workspaces/:workspaceId/notebooks/:notebookId` (soft delete)
- `POST /api/v2/workspaces/:workspaceId/notebooks/:notebookId/sources`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/sources`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/sources/:sourceId`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/jobs/:jobId`
- `POST /api/v2/workspaces/:workspaceId/notebooks/:notebookId/search`
- `POST /api/v2/workspaces/:workspaceId/notebooks/:notebookId/chat`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/chunks`
- `POST /api/v2/workspaces/:workspaceId/notebooks/:notebookId/artifacts`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/artifacts`
- `GET /api/v2/workspaces/:workspaceId/notebooks/:notebookId/artifacts/:artifactId`
