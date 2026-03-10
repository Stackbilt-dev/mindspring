import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { VectorStore } from '../lib/vectorize'

const stats = new Hono<{ Bindings: Env }>()

/**
 * GET /api/stats — Vectorize index statistics.
 */
stats.get('/stats', async (c) => {
  const store = new VectorStore(c.env)

  try {
    const info = await store.getStats()
    return c.json(info)
  } catch (err) {
    return c.json(
      { error: 'Failed to fetch stats', detail: String(err) },
      502
    )
  }
})

/**
 * GET /api/health — Service health check.
 */
stats.get('/health', async (c) => {
  const checks: Record<string, 'ok' | 'error'> = {
    vectorize: 'error',
    ai: 'error',
  }

  // Check Vectorize connectivity
  try {
    const store = new VectorStore(c.env)
    await store.getStats()
    checks.vectorize = 'ok'
  } catch {
    // stays error
  }

  // Check Workers AI availability
  try {
    const result = (await c.env.AI.run(
      '@cf/baai/bge-large-en-v1.5',
      { text: ['health check'] }
    )) as { data: number[][] }
    if (result.data && result.data.length > 0) {
      checks.ai = 'ok'
    }
  } catch {
    // stays error
  }

  const healthy = Object.values(checks).every((v) => v === 'ok')

  return c.json(
    { status: healthy ? 'healthy' : 'degraded', checks },
    healthy ? 200 : 503
  )
})

export { stats }
