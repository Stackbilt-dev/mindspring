import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env, AppVariables, IngestionMessage } from './lib/types'
import { requireAuth } from './lib/auth'
import { telemetryMiddleware } from './lib/telemetry'
import { upload } from './routes/upload'
import { search } from './routes/search'
import { stats } from './routes/stats'
import { auth } from './routes/auth'
import { handleIngestion } from './queue'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// --- Global middleware ---

app.use(
  '/api/*',
  cors({
    origin: '*', // Tighten in production to specific domains
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-File-Name'],
  })
)

// Telemetry on all API routes — captures request/response metrics
app.use('/api/*', telemetryMiddleware())

// --- Auth-gated routes ---

// Auth management: admin only
app.route('/api/auth', auth)

// Uploads/ingestion: requires 'ingest' scope (or higher)
app.use('/api/uploads/*', requireAuth('ingest'))
app.route('/api/uploads', upload)

// Search and browse: requires 'read' scope (or higher)
app.use('/api/search', requireAuth('read'))
app.use('/api/conversations/*', requireAuth('read'))
app.route('/api', search)

// Stats: requires 'read' scope
app.use('/api/stats', requireAuth('read'))
app.use('/api/health', requireAuth('read'))
app.route('/api', stats)

// --- Public root ---

app.get('/', (c) => {
  return c.json({
    name: 'MindSpring Cloud',
    version: '0.2.0',
    auth: 'API key required — pass via Authorization: Bearer <key> or X-API-Key header',
    endpoints: {
      search: 'GET /api/search?q=<query>',
      conversations: 'GET /api/conversations',
      upload: 'POST /api/uploads/simple',
      uploadMultipart: 'POST /api/uploads',
      stats: 'GET /api/stats',
      health: 'GET /api/health',
      authKeys: 'POST /api/auth/keys (admin)',
    },
  })
})

// --- Export for Cloudflare Workers ---

export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<IngestionMessage>,
    env: Env
  ): Promise<void> {
    await handleIngestion(batch, env)
  },
}
