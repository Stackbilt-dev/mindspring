import type { Context, Next } from 'hono'
import type { Env, AppVariables } from './types'

/**
 * Lightweight rate limiter backed by KV.
 *
 * Uses a sliding window approximation with per-key counters.
 * Each window is a KV entry with TTL equal to the window duration.
 *
 * KV key format: ratelimit:{identifier}:{windowKey}
 *
 * This is intentionally simple — no external dependencies, no Durable
 * Objects. For high-traffic production use, upgrade to Cloudflare's
 * Rate Limiting product or a DO-based counter.
 */

export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number
  /** Window duration in seconds */
  windowSeconds: number
  /** Function to extract the rate limit key from the request */
  keyFn: (c: Context<{ Bindings: Env; Variables: AppVariables }>) => string
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 60,
  windowSeconds: 60,
  keyFn: (c) => {
    // Rate limit by API key if authenticated, otherwise by IP
    const authKey = c.get('authKey')
    if (authKey) return `key:${authKey.slice(0, 16)}`
    return `ip:${c.req.header('cf-connecting-ip') ?? 'unknown'}`
  },
}

/**
 * Rate limiting middleware factory.
 *
 * Usage:
 *   app.use('/api/search', rateLimit({ maxRequests: 30, windowSeconds: 60 }))
 *   app.use('/api/uploads/*', rateLimit({ maxRequests: 10, windowSeconds: 60 }))
 */
export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const { maxRequests, windowSeconds, keyFn } = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  return async (
    c: Context<{ Bindings: Env; Variables: AppVariables }>,
    next: Next
  ) => {
    const identifier = keyFn(c)
    const windowKey = Math.floor(Date.now() / 1000 / windowSeconds)
    const kvKey = `ratelimit:${identifier}:${windowKey}`

    // Read current count
    const currentRaw = await c.env.KV.get(kvKey)
    const current = currentRaw ? parseInt(currentRaw) : 0

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current - 1)))
    c.header('X-RateLimit-Reset', String((windowKey + 1) * windowSeconds))

    if (current >= maxRequests) {
      const retryAfter = (windowKey + 1) * windowSeconds - Math.floor(Date.now() / 1000)
      c.header('Retry-After', String(retryAfter))

      return c.json(
        {
          error: 'Rate limit exceeded',
          retryAfter,
          limit: maxRequests,
          window: `${windowSeconds}s`,
        },
        429
      )
    }

    // Increment counter (fire-and-forget for performance)
    c.executionCtx.waitUntil(
      c.env.KV.put(kvKey, String(current + 1), {
        expirationTtl: windowSeconds * 2, // 2x window for overlap safety
      })
    )

    await next()
  }
}
