import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { requireAuth, type ApiKeyRecord, type ApiKeyScope } from '../lib/auth'

/**
 * Auth management routes — admin-only.
 *
 * POST /api/auth/keys          — Create a new API key
 * GET  /api/auth/keys          — List all active keys (names + scopes, not raw keys)
 * DELETE /api/auth/keys/:key   — Revoke a key
 *
 * Bootstrap: the first key must be created via wrangler CLI:
 *   wrangler kv key put --binding KV "apikey:your-bootstrap-key" \
 *     '{"name":"bootstrap","scope":"admin","createdAt":"2025-01-01T00:00:00Z","lastUsedAt":null,"revoked":false}'
 */

const auth = new Hono<{ Bindings: Env }>()

// All auth management routes require admin scope
auth.use('/*', requireAuth('admin'))

/**
 * POST /api/auth/keys — Create a new API key.
 */
auth.post('/keys', async (c) => {
  const body = await c.req.json<{ name: string; scope: ApiKeyScope }>()
  const { name, scope } = body

  if (!name || typeof name !== 'string') {
    return c.json({ error: 'name is required' }, 400)
  }

  const validScopes: ApiKeyScope[] = ['admin', 'ingest', 'read']
  if (!validScopes.includes(scope)) {
    return c.json({ error: `scope must be one of: ${validScopes.join(', ')}` }, 400)
  }

  // Generate a secure random key
  const keyBytes = new Uint8Array(32)
  crypto.getRandomValues(keyBytes)
  const apiKey = `ms_${bytesToHex(keyBytes)}`

  const record: ApiKeyRecord = {
    name,
    scope,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revoked: false,
  }

  await c.env.KV.put(`apikey:${apiKey}`, JSON.stringify(record))

  // Also store a reverse index for listing: keyindex:{name} → key
  // This lets us list keys without scanning all KV keys
  await c.env.KV.put(
    `keyindex:${name}`,
    JSON.stringify({ key: apiKey, scope, createdAt: record.createdAt })
  )

  return c.json(
    {
      apiKey,
      name,
      scope,
      createdAt: record.createdAt,
      warning: 'Store this key securely — it cannot be retrieved after this response.',
    },
    201
  )
})

/**
 * GET /api/auth/keys — List all active keys (metadata only, not raw keys).
 */
auth.get('/keys', async (c) => {
  // List keyindex:* entries from KV
  const list = await c.env.KV.list({ prefix: 'keyindex:' })

  const keys = await Promise.all(
    list.keys.map(async (entry) => {
      const name = entry.name.replace('keyindex:', '')
      const raw = await c.env.KV.get(entry.name)
      if (!raw) return null

      const index = JSON.parse(raw) as {
        key: string
        scope: string
        createdAt: string
      }

      // Check if the key is still active
      const recordRaw = await c.env.KV.get(`apikey:${index.key}`)
      if (!recordRaw) return null

      const record: ApiKeyRecord = JSON.parse(recordRaw)

      return {
        name,
        scope: record.scope,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        revoked: record.revoked,
        // Show only the prefix for identification
        keyPrefix: index.key.slice(0, 10) + '...',
      }
    })
  )

  return c.json({ keys: keys.filter(Boolean) })
})

/**
 * DELETE /api/auth/keys/:name — Revoke a key by name.
 */
auth.delete('/keys/:name', async (c) => {
  const name = c.req.param('name')

  const indexRaw = await c.env.KV.get(`keyindex:${name}`)
  if (!indexRaw) {
    return c.json({ error: 'Key not found' }, 404)
  }

  const index = JSON.parse(indexRaw) as { key: string }

  // Mark the key as revoked (don't delete — audit trail)
  const recordRaw = await c.env.KV.get(`apikey:${index.key}`)
  if (recordRaw) {
    const record: ApiKeyRecord = JSON.parse(recordRaw)
    record.revoked = true
    await c.env.KV.put(`apikey:${index.key}`, JSON.stringify(record))
  }

  return c.json({ revoked: true, name })
})

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export { auth }
