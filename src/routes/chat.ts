import { Hono } from 'hono'
import type { Env } from '../lib/types'
import { VectorStore } from '../lib/vectorize'
import { generateQueryEmbedding } from '../lib/embeddings'
import { generateChatResponse } from '../lib/generate'

const chat = new Hono<{ Bindings: Env }>()

/**
 * POST /api/chat — RAG chat endpoint.
 *
 * Accepts a question and optional conversation history.
 * Retrieves relevant conversations via semantic search,
 * then generates a synthesized response using Workers AI.
 *
 * Body:
 *   {
 *     "question": "What patterns exist in my coding questions?",
 *     "history": [
 *       { "role": "user", "content": "..." },
 *       { "role": "assistant", "content": "..." }
 *     ]
 *   }
 *
 * Response:
 *   {
 *     "answer": "...",
 *     "sources": [{ "id": "...", "title": "...", "score": 0.87 }]
 *   }
 */
chat.post('/', async (c) => {
  const body = await c.req.json<{
    question: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }>()

  const { question, history = [] } = body

  if (!question || question.trim().length === 0) {
    return c.json({ error: 'question is required' }, 400)
  }

  if (question.length > 2000) {
    return c.json({ error: 'question must be under 2000 characters' }, 400)
  }

  // 1. Embed the question
  const queryVector = await generateQueryEmbedding(question, c.env)

  // 2. Retrieve relevant conversations
  const store = new VectorStore(c.env)
  const results = await store.search(queryVector, 8, 0.2)

  if (results.length === 0) {
    return c.json({
      answer:
        "I couldn't find any conversations relevant to your question. Try uploading more conversation exports, or rephrase your question.",
      sources: [],
    })
  }

  // 3. Build context and generate response
  const contexts = results.map((r) => ({
    id: r.id,
    title: r.title,
    text: r.text,
    score: r.score,
  }))

  const answer = await generateChatResponse(question, contexts, history, c.env)

  // 4. Return answer with source citations
  const sources = results.map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
  }))

  return c.json({ answer, sources })
})

export { chat }
