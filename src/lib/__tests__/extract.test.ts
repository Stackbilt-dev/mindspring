import { describe, it, expect } from 'vitest'
import {
  validateConversation,
  extractConversationText,
  detectFormat,
} from '../extract'

describe('extract conversation helpers', () => {
  it('supports AEGIS NDJSON thread format with messages[]', () => {
    const conv = {
      id: 'thread-1',
      title: 'Thread One',
      create_time: 1710000000,
      messages: [
        {
          author: { role: 'user' },
          content: { parts: ['How should we structure the ingest path?'] },
        },
        {
          author: { role: 'assistant' },
          content: { parts: ['Use NDJSON and queue checkpointing.'] },
        },
      ],
    }

    expect(validateConversation(conv)).toBe(true)
    expect(detectFormat(conv)).toBe('gpt')

    const text = extractConversationText(conv)
    expect(text).toContain('Title: Thread One')
    expect(text).toContain('user: How should we structure the ingest path?')
    expect(text).toContain('assistant: Use NDJSON and queue checkpointing.')
  })
})
