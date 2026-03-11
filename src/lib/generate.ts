import type { Env } from './types'

/**
 * Text generation via Cloudflare Workers AI.
 *
 * Uses DeepSeek R1 (32B distill) for RAG chat — a reasoning model
 * that excels at cross-conversation analysis and pattern discovery.
 * Truncates context to fit within model limits.
 */

const CHAT_MODEL = '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b'
const MAX_CONTEXT_CHARS = 16000 // ~4K tokens of context
const MAX_RESPONSE_TOKENS = 2048

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface GenerateResult {
  response: string
}

interface ConversationContext {
  id: string
  title: string
  text: string
  score: number
}

/**
 * Build the system prompt for RAG chat.
 * Frames the model as an analyst of the user's conversation history.
 */
function buildSystemPrompt(contexts: ConversationContext[]): string {
  let contextBlock = ''
  let totalChars = 0

  for (const ctx of contexts) {
    const entry = `\n---\n[${ctx.title}] (relevance: ${Math.round(ctx.score * 100)}%)\n${ctx.text}`
    if (totalChars + entry.length > MAX_CONTEXT_CHARS) {
      // Truncate this entry to fit
      const remaining = MAX_CONTEXT_CHARS - totalChars
      if (remaining > 200) {
        contextBlock += entry.slice(0, remaining) + '...'
      }
      break
    }
    contextBlock += entry
    totalChars += entry.length
  }

  return `You are MindSpring, an insight engine that analyzes a user's AI conversation history. You have access to relevant conversations retrieved by semantic search.

Your role:
- Synthesize insights ACROSS multiple conversations, not just summarize one
- Identify patterns, recurring themes, contradictions, and evolution of thought
- When you reference specific conversations, mention their title
- Be direct and insightful — surface things the user might not have noticed
- If the retrieved context doesn't contain relevant information, say so honestly

Retrieved conversations:
${contextBlock}`
}

/**
 * Generate a RAG chat response.
 * 1. Takes retrieved conversation contexts from semantic search
 * 2. Builds a system prompt with the context
 * 3. Sends the user's question + optional chat history to the model
 */
export async function generateChatResponse(
  question: string,
  contexts: ConversationContext[],
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  env: Env
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(contexts) },
  ]

  // Include recent chat history (last 4 exchanges max to fit context)
  const recentHistory = history.slice(-8)
  for (const msg of recentHistory) {
    messages.push({ role: msg.role, content: msg.content })
  }

  // Add the current question
  messages.push({ role: 'user', content: question })

  const result = (await env.AI.run(CHAT_MODEL, {
    messages,
    max_tokens: MAX_RESPONSE_TOKENS,
    temperature: 0.7,
  })) as GenerateResult

  return result.response ?? ''
}
