import type { StoredChunk } from './db'
import type { GenerationRole, LLMProvider } from './llm/provider'
import { chunkMarkdown } from './summarize'

/** Persistence for page chunk embeddings (implemented by AppDatabase). */
export interface ChunkStore {
  getChunks(url: string, hash: string, model: string): StoredChunk[]
  putChunks(url: string, hash: string, model: string, chunks: StoredChunk[]): void
}

export interface RetrievedChunk {
  index: number
  text: string
  score: number
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Some embedding models (nomic-embed) expect task prefixes. */
function prefixes(modelId: string): { doc: string; query: string } {
  return /nomic/i.test(modelId)
    ? { doc: 'search_document: ', query: 'search_query: ' }
    : { doc: '', query: '' }
}

export interface RetrievalParams {
  provider: LLMProvider
  store: ChunkStore
  /** Role whose tokenizer is used for chunking. */
  role: GenerationRole
  url: string
  contentHash: string
  markdown: string
  query: string
  topK?: number
  chunkTokens?: number
  signal?: AbortSignal
}

/** Embed (or load cached) page chunks and return the most relevant ones in document order. */
export async function retrieveRelevantChunks(p: RetrievalParams): Promise<RetrievedChunk[]> {
  const model = p.provider.modelId('embed')
  if (!model) throw new Error('No embedding model configured.')
  const pre = prefixes(model)

  let chunks = p.store.getChunks(p.url, p.contentHash, model)
  if (chunks.length === 0) {
    const pieces = await chunkMarkdown(p.markdown, (t) => p.provider.countTokens(t, p.role), {
      maxTokens: p.chunkTokens ?? 350,
      overlapTokens: 40
    })
    const vectors = await p.provider.embed(
      pieces.map((c) => pre.doc + (c.heading ? `${c.heading}\n` : '') + c.text),
      { signal: p.signal }
    )
    chunks = pieces.map((c, i) => ({ index: i, text: c.text, vector: vectors[i]! }))
    p.store.putChunks(p.url, p.contentHash, model, chunks)
  }

  const [queryVector] = await p.provider.embed([pre.query + p.query], { signal: p.signal })
  if (!queryVector) return []
  const scored = chunks.map((c) => ({
    index: c.index,
    text: c.text,
    score: cosineSimilarity(queryVector, c.vector)
  }))
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, p.topK ?? 6)
  top.sort((a, b) => a.index - b.index)
  return top
}
