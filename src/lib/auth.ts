import type { Context, Next } from 'hono'
import type { Env, AppVariables, ApiKeyRecord, ApiKeyScope } from './types'

export type { ApiKeyRecord, ApiKeyScope }

/**
 * API key authentication middleware.
 *
 * Validates requests against keys stored in KV under the `apikey:{key}` prefix.
 * Compatible with EdgeStack's AUTH_SERVICE boundary — API keys are the
 * machine-to-machine auth primitive used by the Architect Worker to
 * trigger programmatic ingestion.
 *
 * Key format in KV:
 *   Key:   apikey:{the-api-key}
 *   Value: JSON ApiKeyRecord
 *
 * Keys are checked via:
 *   - `Authorization: Bearer <key>` header
 *   - `X-API-Key: <key>` header
 *
 * Management endpoints (create/revoke) are in routes/auth.ts.
 */

/**
 * Scope hierarchy: admin > ingest > read.
 * A scope grants access to its own level and everything below.
 */
const SCOPE_HIERARCHY: Record<ApiKeyScope, number> = {
  admin: 3,
  ingest: 2,
  read: 1,
}

/**
 * Check if a given scope satisfies a required scope.
 */
export function scopeSatisfies(
  held: ApiKeyScope,
  required: ApiKeyScope
): boolean {
  return SCOPE_HIERARCHY[held] >= SCOPE_HIERARCHY[required]
}

/**
 * Extract the API key from the request.
 */
function extractApiKey(c: Context<{ Bindings: Env; Variables: AppVariables }>): string | null {
  // Bearer token
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }

  // X-API-Key header
  const apiKeyHeader = c.req.header('X-API-Key')
  if (apiKeyHeader) {
    return apiKeyHeader.trim()
  }

  return null
}

/**
 * Middleware factory: require authentication with a minimum scope.
 *
 * Usage:
 *   app.use('/api/uploads/*', requireAuth('ingest'))
 *   app.use('/api/search/*', requireAuth('read'))
 *   app.use('/api/auth/*', requireAuth('admin'))
 */
export function requireAuth(requiredScope: ApiKeyScope) {
  return async (c: Context<{ Bindings: Env; Variables: AppVariables }>, next: Next) => {
    const apiKey = extractApiKey(c)

    if (!apiKey) {
      return c.json(
        { error: 'Authentication required', hint: 'Provide Authorization: Bearer <key> or X-API-Key header' },
        401
      )
    }

    // Look up key in KV
    const recordRaw = await c.env.KV.get(`apikey:${apiKey}`)
    if (!recordRaw) {
      return c.json({ error: 'Invalid API key' }, 401)
    }

    const record: ApiKeyRecord = JSON.parse(recordRaw)

    if (record.revoked) {
      return c.json({ error: 'API key has been revoked' }, 401)
    }

    if (!scopeSatisfies(record.scope, requiredScope)) {
      return c.json(
        {
          error: 'Insufficient permissions',
          required: requiredScope,
          held: record.scope,
        },
        403
      )
    }

    // Update last-used timestamp (fire-and-forget, don't block the request)
    c.executionCtx.waitUntil(
      c.env.KV.put(
        `apikey:${apiKey}`,
        JSON.stringify({ ...record, lastUsedAt: new Date().toISOString() })
      )
    )

    // Attach identity to context for downstream use
    c.set('authKey', apiKey)
    c.set('authRecord', record)

    await next()
  }
}
