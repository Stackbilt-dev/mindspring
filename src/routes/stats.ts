import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { QdrantClient } from '../lib/qdrant'

const stats = new Hono<{ Bindings: Env }>()

/**
 * GET /api/stats — Collection statistics.
 */
stats.get('/stats', async (c) => {
  const qdrant = new QdrantClient(c.env)

  try {
    const collectionStats = await qdrant.getStats()
    return c.json(collectionStats)
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
    qdrant: 'error',
    ai: 'error',
  }

  // Check Qdrant connectivity
  try {
    const qdrant = new QdrantClient(c.env)
    await qdrant.getStats()
    checks.qdrant = 'ok'
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
