import type { Context, Next } from 'hono'
import type { Env, AppVariables } from './types'

/**
 * Request validation middleware and utilities.
 *
 * Guards against malformed input at the system boundary:
 *   - Upload: file type, content-length bounds
 *   - Search: query length, numeric param ranges
 *   - General: JSON body size limits
 */

/** Maximum allowed JSON body size (10MB) */
const MAX_BODY_SIZE = 10 * 1024 * 1024

/** Maximum upload file size (1GB) */
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024

/** Maximum search query length */
const MAX_QUERY_LENGTH = 2000

/** Allowed upload content types */
const ALLOWED_UPLOAD_TYPES = [
  'application/json',
  'application/octet-stream',
]

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>

/**
 * Validate JSON body requests don't exceed size limits.
 */
export function validateBodySize() {
  return async (c: AppContext, next: Next) => {
    const contentLength = parseInt(c.req.header('content-length') ?? '0')

    if (contentLength > MAX_BODY_SIZE) {
      return c.json(
        {
          error: 'Request body too large',
          maxBytes: MAX_BODY_SIZE,
          receivedBytes: contentLength,
        },
        413
      )
    }

    await next()
  }
}

/**
 * Validate upload requests: file size and content type.
 */
export function validateUpload() {
  return async (c: AppContext, next: Next) => {
    const contentLength = parseInt(c.req.header('content-length') ?? '0')
    const contentType = c.req.header('content-type') ?? ''

    if (contentLength > MAX_UPLOAD_SIZE) {
      return c.json(
        {
          error: 'File too large',
          maxBytes: MAX_UPLOAD_SIZE,
          maxHuman: '1 GB',
        },
        413
      )
    }

    // For simple uploads, validate content type
    if (c.req.path.endsWith('/simple')) {
      const isAllowed = ALLOWED_UPLOAD_TYPES.some((t) =>
        contentType.startsWith(t)
      )
      if (!isAllowed && contentLength > 0) {
        return c.json(
          {
            error: 'Invalid content type',
            allowed: ALLOWED_UPLOAD_TYPES,
            received: contentType,
          },
          415
        )
      }
    }

    await next()
  }
}

/**
 * Validate and sanitize search query parameters.
 * Attaches validated params to context for downstream use.
 */
export function validateSearchParams() {
  return async (c: AppContext, next: Next) => {
    const query = c.req.query('q')

    if (query && query.length > MAX_QUERY_LENGTH) {
      return c.json(
        {
          error: 'Query too long',
          maxLength: MAX_QUERY_LENGTH,
          receivedLength: query.length,
        },
        400
      )
    }

    // Clamp numeric params to safe ranges
    const limit = c.req.query('limit')
    if (limit !== undefined) {
      const parsed = parseInt(limit)
      if (isNaN(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer' }, 400)
      }
    }

    const threshold = c.req.query('threshold')
    if (threshold !== undefined) {
      const parsed = parseFloat(threshold)
      if (isNaN(parsed) || parsed < 0 || parsed > 1) {
        return c.json(
          { error: 'threshold must be a number between 0 and 1' },
          400
        )
      }
    }

    await next()
  }
}
