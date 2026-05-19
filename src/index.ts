import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env, AppVariables, IngestionMessage } from './lib/types'
import { requireAuth } from './lib/auth'
import { telemetryMiddleware } from './lib/telemetry'
import { rateLimit } from './lib/rate-limit'
import { validateBodySize, validateUpload, validateSearchParams } from './lib/validate'
import { upload } from './routes/upload'
import { search } from './routes/search'
import { conversations } from './routes/conversations'
import { stats } from './routes/stats'
import { auth } from './routes/auth'
import { telemetry } from './routes/telemetry'
import { chat } from './routes/chat'
import { handleIngestion } from './queue'

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>()

// --- Global middleware ---

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-File-Name'],
    exposeHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  })
)

app.use('/api/*', telemetryMiddleware())
// Body size limit: skip upload routes (they have their own 1GB limit via validateUpload)
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/uploads')) return next()
  return validateBodySize()(c, next)
})

// --- Auth management: admin only ---
app.route('/api/auth', auth)

// --- Telemetry query: admin only ---
app.use('/api/telemetry', requireAuth('admin'))
app.use('/api/telemetry/*', requireAuth('admin'))
app.route('/api/telemetry', telemetry)

// --- Uploads: requires 'ingest' scope ---
app.use('/api/uploads', requireAuth('ingest'))
app.use('/api/uploads/*', requireAuth('ingest'))
app.use('/api/uploads', validateUpload())
app.use('/api/uploads/*', validateUpload())
// Status polling gets a generous limit; upload mutations are tighter
app.use('/api/uploads/*/status', rateLimit({ maxRequests: 60, windowSeconds: 60 }))
app.use('/api/uploads', rateLimit({ maxRequests: 20, windowSeconds: 60 }))
app.use('/api/uploads/*', rateLimit({ maxRequests: 20, windowSeconds: 60 }))
app.route('/api/uploads', upload)

// --- Search: requires 'read' scope ---
app.use('/api/search', requireAuth('read'))
app.use('/api/search/*', requireAuth('read'))
app.use('/api/search', validateSearchParams())
app.use('/api/search/*', validateSearchParams())
app.use('/api/search', rateLimit({ maxRequests: 60, windowSeconds: 60 }))
app.use('/api/search/*', rateLimit({ maxRequests: 60, windowSeconds: 60 }))
app.route('/api/search', search)

// --- Chat (RAG): requires 'read' scope ---
app.use('/api/chat', requireAuth('read'))
app.use('/api/chat/*', requireAuth('read'))
app.use('/api/chat', rateLimit({ maxRequests: 20, windowSeconds: 60 }))
app.use('/api/chat/*', rateLimit({ maxRequests: 20, windowSeconds: 60 }))
app.route('/api/chat', chat)

// --- Conversations: requires 'read' scope ---
app.use('/api/conversations', requireAuth('read'))
app.use('/api/conversations/*', requireAuth('read'))
app.use('/api/conversations', rateLimit({ maxRequests: 60, windowSeconds: 60 }))
app.use('/api/conversations/*', rateLimit({ maxRequests: 60, windowSeconds: 60 }))
app.route('/api/conversations', conversations)

// --- Stats: requires 'read' scope ---
app.use('/api/stats', requireAuth('read'))
app.use('/api/health', requireAuth('read'))
app.route('/api', stats)

// --- Public root ---
app.get('/', (c) => {
  return c.json({
    name: 'MindSpring',
    version: '0.4.0',
    description: 'Semantic search engine for AI conversation exports',
    auth: 'API key required — pass via Authorization: Bearer <key> or X-API-Key header',
    docs: 'https://github.com/Stackbilt-dev/mindspring',
    endpoints: {
      'POST /api/uploads/simple': 'Upload a conversation file (<5MB)',
      'POST /api/uploads': 'Initiate multipart upload for large files',
      'GET /api/uploads/:id/status': 'Check ingestion progress',
      'GET /api/search?q=': 'Semantic search',
      'POST /api/chat': 'RAG chat — ask questions about your conversation history',
      'GET /api/conversations': 'Browse all conversations',
      'GET /api/conversations/:id': 'Fetch a single conversation',
      'GET /api/conversations/:id/similar': 'Find similar conversations',
      'GET /api/stats': 'Collection statistics',
      'GET /api/health': 'Service health check',
      'POST /api/auth/keys': 'Create API key (admin)',
      'GET /api/auth/keys': 'List API keys (admin)',
      'DELETE /api/auth/keys/:name': 'Revoke API key (admin)',
      'GET /api/telemetry': 'Query flow logs (admin)',
    },
  })
})

export default {
  fetch: app.fetch,

  async queue(
    batch: MessageBatch<IngestionMessage>,
    env: Env
  ): Promise<void> {
    await handleIngestion(batch, env)
  },
}
