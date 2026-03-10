import type { Env } from './types'

/**
 * Generate embeddings via Cloudflare Workers AI.
 *
 * Workers AI embedding models accept an array of text inputs
 * and return an array of float vectors. Batch size limit is
 * model-dependent (~100 inputs is safe for bge-large).
 */

const MAX_AI_BATCH_SIZE = 96

interface EmbeddingResult {
  data: number[][]
}

export async function generateEmbeddings(
  texts: string[],
  env: Env
): Promise<number[][]> {
  if (texts.length === 0) return []

  const allEmbeddings: number[][] = []

  // Sub-batch to stay within Workers AI limits
  for (let i = 0; i < texts.length; i += MAX_AI_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_AI_BATCH_SIZE)

    const result = (await env.AI.run(
      '@cf/baai/bge-large-en-v1.5',
      { text: batch }
    )) as EmbeddingResult

    if (!result.data || result.data.length !== batch.length) {
      throw new Error(
        `Embedding mismatch: sent ${batch.length} texts, got ${result.data?.length ?? 0} vectors`
      )
    }

    allEmbeddings.push(...result.data)
  }

  return allEmbeddings
}

/**
 * Generate a single embedding for a search query.
 */
export async function generateQueryEmbedding(
  query: string,
  env: Env
): Promise<number[]> {
  const [embedding] = await generateEmbeddings([query], env)
  return embedding
}
