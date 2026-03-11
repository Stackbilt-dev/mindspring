# Contributing to MindSpring

Thanks for your interest in contributing. This document covers the conventions and workflow for the project.

## Development Setup

1. **Clone and install**:
   ```bash
   git clone https://github.com/Stackbilt-dev/mindspring.git
   cd mindspring
   npm install
   ```

2. **Configure**: Copy `.env.example` to `.env` and add your `CLOUDFLARE_API_TOKEN`.

3. **Run locally**:
   ```bash
   wrangler dev
   ```

4. **Run checks**:
   ```bash
   npm run type-check   # TypeScript compilation
   npm test             # Vitest test suite
   ```

## Code Conventions

### Module Size Limit

Every source file must stay under **400 lines**. If a module is approaching this limit, decompose it into focused sub-modules. This is a hard constraint inherited from the broader StackBilt architecture.

### Zero External Runtime Dependencies

The only runtime dependency is [Hono](https://hono.dev/). Everything else — JSON parsing, rate limiting, auth, telemetry — is implemented directly against Cloudflare Workers APIs. Do not add runtime dependencies without discussion.

Dev dependencies (TypeScript, Vitest, Wrangler, `@cloudflare/workers-types`) are fine.

### File Organization

```
src/
├── index.ts       — App entry point, middleware wiring, route registration
├── queue.ts       — Queue consumer (ingestion pipeline)
├── lib/           — Shared libraries (auth, telemetry, parsing, clients)
│   └── __tests__/ — Unit tests co-located with their modules
└── routes/        — Hono route handlers, one file per resource
frontend/
├── index.html     — App shell
├── styles.css     — Design system (CSS custom properties, no preprocessor)
└── app.js         — Vanilla JS SPA (no build step, no framework)
```

- **`lib/`** contains pure logic and middleware that doesn't depend on route structure.
- **`routes/`** contains Hono route handlers grouped by resource. Each file exports a `Hono` instance that gets mounted in `index.ts`.
- **`frontend/`** is served as static assets via Cloudflare Workers Static Assets. No build step — edit and deploy.
- **Tests** go in `lib/__tests__/` or `routes/__tests__/`, mirroring the source structure.

### Frontend Conventions

- **No frameworks, no build tools.** The frontend is vanilla HTML/CSS/JS.
- **CSS custom properties** defined in `:root` for theming. Follow the Cloud Architecture palette.
- **Fonts**: Syne (display), DM Sans (body), JetBrains Mono (data). Do not add additional font imports.
- **No npm dependencies** in the frontend. Everything is self-contained.

### TypeScript

- Strict mode is enabled. Do not use `// @ts-ignore` or `any` without a comment explaining why.
- All Cloudflare bindings are typed via the `Env` interface in `lib/types.ts`. If you add a new binding in `wrangler.toml`, add the corresponding type.
- Hono context variables (set by middleware, read by handlers) are typed via `AppVariables` in `lib/types.ts`.

### Error Handling

- **Routes**: Return structured JSON errors with appropriate HTTP status codes. Never leak stack traces to the client in production.
- **Queue consumer**: Errors are caught per-message and logged to telemetry. Failed messages are retried by the Queue. Progress is checkpointed to KV so retries resume from the last successful batch.
- **Middleware**: Auth and validation middleware return early with 4xx responses. Rate limit middleware includes `Retry-After` headers.

### Telemetry

All observable events should write a `TelemetryEnvelope` to KV via `logEvent()` or `logIngestionEvent()`. This is the standard observability format for the StackBilt ecosystem. Include:

- `requestId` for correlation
- `category` for filtering (`request`, `ingestion`, `error`, `auth`)
- `durationMs` for performance tracking
- Structured `data` or `error` payloads

## Pull Request Process

1. **Branch**: Create a feature branch from `main`.
2. **Checks**: Ensure `npm run type-check` and `npm test` pass before opening a PR.
3. **Module discipline**: Verify no file exceeds 400 lines (`wc -l src/**/*.ts`).
4. **Description**: Include a summary of changes and any architectural decisions.
5. **Review**: PRs require at least one approval before merging.

## Adding a New Route

1. Create a new file in `src/routes/` (e.g., `src/routes/topics.ts`).
2. Export a `Hono` instance with your route handlers.
3. Mount it in `src/index.ts` with the appropriate auth and rate limit middleware.
4. Add the endpoint to the root `/` endpoint listing.
5. Document it in `openapi.yaml` and `README.md`.

## Adding a New Library Module

1. Create a new file in `src/lib/`.
2. Export typed functions or classes — no side effects at module level.
3. Add tests in `src/lib/__tests__/`.
4. Update `src/lib/types.ts` if new bindings or context variables are needed.

## Reporting Issues

Open an issue on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages or telemetry output
