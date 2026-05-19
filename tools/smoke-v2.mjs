#!/usr/bin/env node
import { randomUUID } from 'node:crypto'

const BASE_URL = process.env.MINDSPRING_BASE_URL || 'https://mindspring.blue-pine-edf6.workers.dev'
const API_KEY = process.env.MINDSPRING_API_KEY

if (!API_KEY) {
  console.error('Missing MINDSPRING_API_KEY')
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${API_KEY}`,
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  })

  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(body)}`)
  }

  return body
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const workspaceId = randomUUID()
  const notebookName = `smoke-v2-${Date.now()}`

  const notebook = await request(`/api/v2/workspaces/${workspaceId}/notebooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: notebookName,
      type: 'workflow_ops',
      instructions: 'Answer strictly from notebook sources with citations.',
    }),
  })

  const sourceText = [
    'MindSpring v2 smoke source.',
    'The system validates notebook scoped retrieval.',
    'Chunked ingestion writes to D1 and Vectorize.',
    'This source should be cited in notebook chat.',
  ].join('\n')

  const upload = await request('/api/uploads/simple', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-File-Name': `smoke-${Date.now()}.txt`,
    },
    body: sourceText,
  })

  const sourceReg = await request(
    `/api/v2/workspaces/${workspaceId}/notebooks/${notebook.id}/sources`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Smoke Source',
        type: 'txt',
        sourceUploadId: upload.uploadId,
        parserType: 'txt',
      }),
    }
  )

  let lastError = null
  let jobStatus = null
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    try {
      jobStatus = await request(
        `/api/v2/workspaces/${workspaceId}/notebooks/${notebook.id}/jobs/${sourceReg.jobId}`
      )
      if (jobStatus.status === 'completed') break
      if (jobStatus.status === 'failed') {
        throw new Error(`ingestion failed: ${jobStatus.errorMessage || 'unknown error'}`)
      }
      lastError = `job status ${jobStatus.status}`
    } catch (err) {
      lastError = `job poll error: ${err?.message || String(err)}`
    }
  }

  if (!jobStatus || jobStatus.status !== 'completed') {
    throw new Error(`Ingestion job did not complete. Last status: ${lastError}`)
  }

  let chat = null
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    try {
      chat = await request(
        `/api/v2/workspaces/${workspaceId}/notebooks/${notebook.id}/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'What does this notebook source say about ingestion?',
          }),
        }
      )

      if (Array.isArray(chat.citations) && chat.citations.length > 0) break
      lastError = `attempt ${i + 1}: no citations yet`
    } catch (err) {
      lastError = `attempt ${i + 1}: ${err?.message || String(err)}`
      // keep retrying while ingestion catches up
    }
  }

  if (!chat || !Array.isArray(chat.citations) || chat.citations.length === 0) {
    throw new Error(
      `Notebook chat did not return citations within retry window. Last status: ${lastError}. Last chat: ${JSON.stringify(chat)}`
    )
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspaceId,
        notebookId: notebook.id,
        uploadId: upload.uploadId,
        sourceId: sourceReg.source?.id,
        jobId: sourceReg.jobId,
        jobStatus: jobStatus.status,
        citationCount: chat.citations.length,
      },
      null,
      2
    )
  )
}

main().catch((err) => {
  console.error(err.message || String(err))
  process.exit(1)
})
