# MindSpring Roadmap

## Now

- v1 production flows stable:
  - conversation upload (`/api/uploads/*`)
  - semantic search (`/api/search`)
  - RAG chat (`/api/chat`)
- v2 backend foundation live:
  - notebooks CRUD/read lifecycle (workspace scoped)
  - source registration + ingestion jobs
  - job status polling
  - notebook chat with citation fallback
  - notebook search + chunk diagnostics
  - artifact create/list/detail with snapshot hashes and stale detection
- v2 parsers currently implemented:
  - `markdown`
  - `txt`
  - `chat_export`
  - NDJSON thread ingestion path for AEGIS-compatible writes

## Next

- Add source-level invalidation/staleness markers for artifacts
- Add migration bridge strategy for optional v1 -> v2 notebook wrapping
- Add artifact citation persistence rows (`citations.artifact_id`) for full audit trail

## Later

- Implement `url` parser
- Implement `pdf` parser
- Add notebook-first frontend routes once backend is fully stabilized
- Add release automation and tagged version docs for v2 milestones
