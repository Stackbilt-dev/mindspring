import { Hono } from 'hono'
import type { Env, UploadProgress } from '../lib/types'

const upload = new Hono<{ Bindings: Env }>()

/**
 * POST /api/uploads — Initiate a multipart upload session.
 *
 * Returns an uploadId that the client uses to upload parts
 * directly to R2, then calls /complete when done.
 */
upload.post('/', async (c) => {
  const body = await c.req.json<{ fileName: string; fileSize: number }>()
  const { fileName, fileSize } = body

  if (!fileName) {
    return c.json({ error: 'fileName is required' }, 400)
  }

  const uploadId = crypto.randomUUID()
  const r2Key = `uploads/${uploadId}/${fileName}`

  // Create the R2 multipart upload
  const multipartUpload = await c.env.UPLOADS_BUCKET.createMultipartUpload(
    r2Key
  )

  // Store initial progress in KV
  const progress: UploadProgress = {
    status: 'uploading',
    r2Key,
    fileName,
    fileSize: fileSize ?? 0,
    totalConversations: null,
    processedConversations: 0,
    lastCheckpointIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await c.env.KV.put(`upload:${uploadId}`, JSON.stringify(progress))

  return c.json({
    uploadId,
    r2Key,
    multipartUploadId: multipartUpload.uploadId,
  })
})

/**
 * POST /api/uploads/:id/part — Upload a single part.
 *
 * For server-side multipart assembly. The client sends each
 * chunk through the Worker, which forwards to R2.
 */
upload.post('/:id/part', async (c) => {
  const uploadId = c.req.param('id')
  const partNumber = parseInt(c.req.query('partNumber') ?? '0')
  const r2UploadId = c.req.query('multipartUploadId') ?? ''

  if (!partNumber || !r2UploadId) {
    return c.json({ error: 'partNumber and multipartUploadId required' }, 400)
  }

  // Read progress to get the R2 key
  const progressRaw = await c.env.KV.get(`upload:${uploadId}`)
  if (!progressRaw) {
    return c.json({ error: 'Upload not found' }, 404)
  }
  const progress: UploadProgress = JSON.parse(progressRaw)

  // Resume the multipart upload and upload this part
  const multipartUpload = c.env.UPLOADS_BUCKET.resumeMultipartUpload(
    progress.r2Key,
    r2UploadId
  )

  const partBody = await c.req.arrayBuffer()
  const uploadedPart = await multipartUpload.uploadPart(partNumber, partBody)

  return c.json({
    partNumber,
    etag: uploadedPart.etag,
  })
})

/**
 * POST /api/uploads/:id/complete — Finalize the upload and enqueue ingestion.
 */
upload.post('/:id/complete', async (c) => {
  const uploadId = c.req.param('id')
  const body = await c.req.json<{
    multipartUploadId: string
    parts: Array<{ partNumber: number; etag: string }>
  }>()

  const progressRaw = await c.env.KV.get(`upload:${uploadId}`)
  if (!progressRaw) {
    return c.json({ error: 'Upload not found' }, 404)
  }
  const progress: UploadProgress = JSON.parse(progressRaw)

  // Complete the R2 multipart upload
  const multipartUpload = c.env.UPLOADS_BUCKET.resumeMultipartUpload(
    progress.r2Key,
    body.multipartUploadId
  )
  await multipartUpload.complete(body.parts)

  // Update status
  progress.status = 'processing'
  progress.updatedAt = new Date().toISOString()
  await c.env.KV.put(`upload:${uploadId}`, JSON.stringify(progress))

  // Enqueue ingestion job
  await c.env.INGESTION_QUEUE.send({
    uploadId,
    r2Key: progress.r2Key,
  })

  return c.json({ status: 'processing', uploadId }, 202)
})

/**
 * POST /api/uploads/simple — Direct upload for small files (<5MB).
 * Bypasses multipart; body IS the JSON file.
 */
upload.post('/simple', async (c) => {
  const contentLength = parseInt(c.req.header('content-length') ?? '0')
  const fileName = c.req.header('x-file-name') ?? 'conversations.json'

  if (contentLength > 5 * 1024 * 1024) {
    return c.json(
      { error: 'File too large for simple upload. Use multipart.' },
      413
    )
  }

  const uploadId = crypto.randomUUID()
  const r2Key = `uploads/${uploadId}/${fileName}`

  // Store directly to R2
  const body = await c.req.arrayBuffer()
  await c.env.UPLOADS_BUCKET.put(r2Key, body)

  // Store progress
  const progress: UploadProgress = {
    status: 'processing',
    r2Key,
    fileName,
    fileSize: body.byteLength,
    totalConversations: null,
    processedConversations: 0,
    lastCheckpointIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await c.env.KV.put(`upload:${uploadId}`, JSON.stringify(progress))

  // Enqueue ingestion
  await c.env.INGESTION_QUEUE.send({ uploadId, r2Key })

  return c.json({ status: 'processing', uploadId }, 202)
})

/**
 * GET /api/uploads/:id/status — Poll ingestion progress.
 */
upload.get('/:id/status', async (c) => {
  const uploadId = c.req.param('id')
  const progressRaw = await c.env.KV.get(`upload:${uploadId}`)

  if (!progressRaw) {
    return c.json({ error: 'Upload not found' }, 404)
  }

  return c.json(JSON.parse(progressRaw))
})

export { upload }
