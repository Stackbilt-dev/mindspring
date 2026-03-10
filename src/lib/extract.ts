import type { GPTConversation, ClaudeConversation } from './types'

/**
 * Detect conversation format and extract searchable text.
 * Direct port of ConversationVectorStore._extract_conversation_text()
 */
export function extractConversationText(
  conversation: Record<string, unknown>
): string {
  const messages: string[] = []

  if (conversation.mapping) {
    // GPT format: mapping -> nodes -> message -> content -> parts
    const mapping = conversation.mapping as Record<
      string,
      GPTConversation['mapping'] extends Record<string, infer V> ? V : never
    >
    for (const node of Object.values(mapping)) {
      const msg = (node as Record<string, unknown>)?.message as
        | Record<string, unknown>
        | undefined
      if (!msg) continue

      const content = msg.content as Record<string, unknown> | undefined
      const parts = content?.parts as Array<unknown> | undefined
      if (parts?.[0] && typeof parts[0] === 'string') {
        const author = msg.author as Record<string, unknown> | undefined
        const role = (author?.role as string) ?? 'unknown'
        messages.push(`${role}: ${parts[0]}`)
      }
    }
  } else if (conversation.chat_messages) {
    // Claude format: chat_messages array -> sender + text
    const chatMessages = conversation.chat_messages as Array<
      Record<string, unknown>
    >
    for (const msg of chatMessages) {
      const sender = (msg.sender as string) ?? 'unknown'
      const text = msg.text as string | undefined
      if (text) {
        messages.push(`${sender}: ${text}`)
      }
    }
  }

  const title =
    (conversation.title as string) ??
    (conversation.name as string) ??
    'Untitled Conversation'

  return `Title: ${title}\n\n${messages.join('\n')}`
}

/**
 * Detect whether a conversation object is GPT or Claude format.
 */
export function detectFormat(
  conversation: Record<string, unknown>
): 'gpt' | 'claude' {
  if (conversation.mapping) return 'gpt'
  return 'claude'
}

/**
 * Validate that a conversation has extractable content.
 * Port of ConversationVectorStore._validate_conversation()
 */
export function validateConversation(
  conversation: Record<string, unknown>
): boolean {
  if (typeof conversation !== 'object' || conversation === null) return false

  if (conversation.mapping) {
    const mapping = conversation.mapping as Record<
      string,
      Record<string, unknown>
    >
    if (typeof mapping !== 'object') return false

    // Check for at least one valid message node
    return Object.values(mapping).some((node) => {
      const msg = node?.message as Record<string, unknown> | undefined
      const content = msg?.content as Record<string, unknown> | undefined
      return content != null
    })
  }

  if (conversation.chat_messages) {
    const messages = conversation.chat_messages as Array<unknown>
    if (!Array.isArray(messages)) return false
    return messages.some((msg) => {
      if (typeof msg !== 'object' || msg === null) return false
      return (msg as Record<string, unknown>).text != null
    })
  }

  return false
}

/**
 * Get a stable ID from a conversation object.
 */
export function getConversationId(
  conversation: Record<string, unknown>
): string {
  return (
    (conversation.id as string) ??
    (conversation.uuid as string) ??
    crypto.randomUUID()
  )
}

/**
 * Get a creation timestamp from a conversation object.
 */
export function getCreateTime(
  conversation: Record<string, unknown>
): number {
  if (typeof conversation.create_time === 'number') {
    return conversation.create_time
  }
  if (typeof conversation.created_at === 'string') {
    return new Date(conversation.created_at).getTime() / 1000
  }
  return Date.now() / 1000
}
