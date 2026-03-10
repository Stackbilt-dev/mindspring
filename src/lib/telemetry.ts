import type { Context, Next } from 'hono'
import type { Env, AppVariables } from './types'

/**
 * TelemetryCollector — structured event logging to KV.
 *
 * Mirrors EdgeStack's FLOW_LOGS pattern: each event is a
 * RunTelemetryEnvelope stored in KV with a time-sortable key.
 * Events surface in the Architect Engine's agent-facing summaries.
 *
 * KV key format: flowlog:{ISO-timestamp}:{requestId}
 * TTL: 7 days (configurable)
 */

const LOG_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export interface TelemetryEnvelope {
  /** Unique request/event ID */
  requestId: string
  /** ISO timestamp */
  timestamp: string
  /** Service origin */
  service: 'mindspring'
  /** Event category */
  category: 'request' | 'ingestion' | 'search' | 'auth' | 'error'
  /** HTTP method if applicable */
  method?: string
  /** Route path */
  path?: string
  /** HTTP status code */
  status?: number
  /** Duration in milliseconds */
  durationMs?: number
  /** Auth key name (not the raw key) */
  authKeyName?: string
  /** Structured event data */
  data?: Record<string, unknown>
  /** Error details */
  error?: {
    message: string
    stack?: string
  }
}

/**
 * Write a telemetry event to FLOW_LOGS KV.
 */
export async function logEvent(
  env: Env,
  envelope: TelemetryEnvelope
): Promise<void> {
  const key = `flowlog:${envelope.timestamp}:${envelope.requestId}`
  await env.KV.put(key, JSON.stringify(envelope), {
    expirationTtl: LOG_TTL_SECONDS,
  })
}

/**
 * Hono middleware: capture request telemetry for every API call.
 *
 * Logs method, path, status, duration, and auth identity.
 * Errors are captured separately with stack traces.
 */
export function telemetryMiddleware() {
  return async (c: Context<{ Bindings: Env; Variables: AppVariables }>, next: Next) => {
    const requestId = crypto.randomUUID()
    const start = Date.now()

    // Attach requestId to context for downstream use
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)

    try {
      await next()
    } catch (err) {
      const envelope: TelemetryEnvelope = {
        requestId,
        timestamp: new Date().toISOString(),
        service: 'mindspring',
        category: 'error',
        method: c.req.method,
        path: c.req.path,
        status: 500,
        durationMs: Date.now() - start,
        error: {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      }

      // Fire-and-forget — don't let telemetry failure break the request
      c.executionCtx.waitUntil(logEvent(c.env, envelope))

      throw err
    }

    // Log successful request
    const envelope: TelemetryEnvelope = {
      requestId,
      timestamp: new Date().toISOString(),
      service: 'mindspring',
      category: 'request',
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
      authKeyName: c.get('authRecord')?.name,
    }

    // Fire-and-forget
    c.executionCtx.waitUntil(logEvent(c.env, envelope))
  }
}

/**
 * Log an ingestion event (called from queue consumer).
 */
export async function logIngestionEvent(
  env: Env,
  data: {
    uploadId: string
    action: 'started' | 'batch_complete' | 'completed' | 'failed'
    totalItems?: number
    processedItems?: number
    batchIndex?: number
    durationMs?: number
    errorMessage?: string
  }
): Promise<void> {
  const envelope: TelemetryEnvelope = {
    requestId: data.uploadId,
    timestamp: new Date().toISOString(),
    service: 'mindspring',
    category: 'ingestion',
    data: {
      action: data.action,
      totalItems: data.totalItems,
      processedItems: data.processedItems,
      batchIndex: data.batchIndex,
      durationMs: data.durationMs,
    },
    error: data.errorMessage
      ? { message: data.errorMessage }
      : undefined,
  }

  await logEvent(env, envelope)
}
