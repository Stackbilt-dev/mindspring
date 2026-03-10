import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env, IngestionMessage } from './lib/types'
import { upload } from './routes/upload'
import { search } from './routes/search'
import { stats } from './routes/stats'
import { handleIngestion } from './queue'

const app = new Hono<{ Bindings: Env }>()

// Middleware
app.use('*', logger())
app.use(
  '/api/*',
  cors({
    origin: '*', // Tighten in production
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-File-Name'],
  })
)

// Routes
app.route('/api/uploads', upload)
app.route('/api', search)
app.route('/api', stats)

// Root
app.get('/', (c) => {
  return c.json({
    name: 'MindSpring Cloud',
    version: '0.1.0',
    endpoints: {
      search: 'GET /api/search?q=<query>',
      conversations: 'GET /api/conversations',
      upload: 'POST /api/uploads/simple',
      uploadMultipart: 'POST /api/uploads',
      stats: 'GET /api/stats',
      health: 'GET /api/health',
    },
  })
})

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,

  // Queue consumer for async ingestion
  async queue(
    batch: MessageBatch<IngestionMessage>,
    env: Env
  ): Promise<void> {
    await handleIngestion(batch, env)
  },
}
