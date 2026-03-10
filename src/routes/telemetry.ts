import { Hono } from 'hono'
import type { Env } from '../lib/types'
import type { TelemetryEnvelope } from '../lib/telemetry'

/**
 * Telemetry query routes — admin-only.
 *
 * Exposes structured flow log entries from KV so the Architect
 * Worker can pull telemetry without direct KV access.
 *
 * GET /api/telemetry          — List recent events
 * GET /api/telemetry/:id      — Get events for a specific request/upload
 */

const telemetry = new Hono<{ Bindings: Env }>()

/**
 * GET /api/telemetry — List recent telemetry events.
 *
 * Query params:
 *   limit    — max entries (default 50, max 200)
 *   category — filter by category (request, ingestion, error, auth)
 *   cursor   — KV list cursor for pagination
 */
telemetry.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const category = c.req.query('category')
  const cursor = c.req.query('cursor') ?? undefined

  const list = await c.env.KV.list({
    prefix: 'flowlog:',
    limit,
    cursor,
  })

  // Fetch values for each key
  const entries: TelemetryEnvelope[] = []
  await Promise.all(
    list.keys.map(async (key) => {
      const raw = await c.env.KV.get(key.name)
      if (!raw) return

      const envelope: TelemetryEnvelope = JSON.parse(raw)

      // Apply category filter if specified
      if (category && envelope.category !== category) return

      entries.push(envelope)
    })
  )

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  return c.json({
    count: entries.length,
    cursor: list.list_complete ? null : list.cursor,
    entries,
  })
})

/**
 * GET /api/telemetry/:id — Get all events for a specific request or upload.
 *
 * Searches flow logs for entries matching the given requestId/uploadId.
 */
telemetry.get('/:id', async (c) => {
  const targetId = c.req.param('id')

  // Scan flow logs for matching requestId
  const list = await c.env.KV.list({ prefix: 'flowlog:', limit: 500 })

  const entries: TelemetryEnvelope[] = []
  await Promise.all(
    list.keys.map(async (key) => {
      // Quick check: the key contains the timestamp and requestId
      // Format: flowlog:{timestamp}:{requestId}
      if (!key.name.includes(targetId)) return

      const raw = await c.env.KV.get(key.name)
      if (!raw) return

      entries.push(JSON.parse(raw))
    })
  )

  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  if (entries.length === 0) {
    return c.json({ error: 'No telemetry found for this ID' }, 404)
  }

  return c.json({ requestId: targetId, count: entries.length, entries })
})

export { telemetry }
