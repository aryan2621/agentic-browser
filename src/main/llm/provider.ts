import type { LlmErrorCode, LlmErrorInfo, LlmStatus } from '@shared/types'

/**
 * Text generation roles. "fast" covers summaries, chat and search answers; more roles (e.g. a
 * stronger model for harder tasks) can be added here and mapped in Settings → Models.
 */
export type GenerationRole = 'fast'

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A JSON schema in the subset node-llama-cpp's grammar generator understands. */
export type JsonSchema = Record<string, unknown>

export interface GenerateRequest {
  role: GenerationRole
  messages: PromptMessage[]
  temperature: number
  maxTokens?: number
  /** When set, decoding is grammar-constrained so output is always valid JSON for this schema. */
  jsonSchema?: JsonSchema
}

export interface GenerateResult {
  text: string
  tokens: number
  tokensPerSecond: number | null
  stopReason: 'eos' | 'maxTokens' | 'abort'
}

export interface GenerateOptions {
  signal?: AbortSignal
  onToken?: (text: string) => void
}

/**
 * Everything the app needs from an inference backend. Implementations:
 *  - LlamaCppProvider: embedded llama.cpp in a utility process (default)
 *  - MockProvider: deterministic, no model files (tests / development)
 * Additional backends (OpenAI-compatible endpoint, Ollama) can implement this later.
 */
export interface LLMProvider {
  readonly kind: LlmStatus['provider']
  /** Stable identifier of the model serving a role; used as a cache key. */
  modelId(role: GenerationRole | 'embed'): string | null
  generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult>
  /** Token counts using the model's own tokenizer. */
  countTokens(texts: string[], role: GenerationRole): Promise<number[]>
  /** Context window (tokens) available for a role once loaded/configured. */
  contextSize(role: GenerationRole): Promise<number>
  embed(texts: string[], opts?: { signal?: AbortSignal }): Promise<Float32Array[]>
  canEmbed(): boolean
  status(): LlmStatus
  onStatus(listener: (status: LlmStatus) => void): () => void
  unloadAll(): Promise<void>
  restart(): Promise<void>
  dispose(): Promise<void>
}

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'LlmError'
  }

  toInfo(): LlmErrorInfo {
    return toErrorInfo(this.code, this.message)
  }
}

export function toErrorInfo(code: LlmErrorCode, message: string): LlmErrorInfo {
  switch (code) {
    case 'NO_MODEL':
      return { code, message, actions: ['open-models'] }
    case 'MODEL_MISSING':
      return { code, message, actions: ['open-models', 'redownload'] }
    case 'MODEL_CORRUPT':
      return { code, message, actions: ['redownload', 'open-models'] }
    case 'MODEL_LOAD_FAILED':
      return { code, message, actions: ['use-smaller-model', 'open-models'] }
    case 'CONTEXT_TOO_SMALL':
      return { code, message, actions: ['retry'] }
    case 'OUT_OF_MEMORY':
      return { code, message, actions: ['reduce-context', 'use-smaller-model', 'retry'] }
    case 'WORKER_CRASHED':
      return { code, message, actions: ['retry'] }
    case 'ABORTED':
      return { code, message, actions: [] }
    case 'GENERATION_FAILED':
      return { code, message, actions: ['retry'] }
  }
}

export function asLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err
  if (err instanceof Error && err.name === 'AbortError') return new LlmError('ABORTED', 'Stopped.')
  const message = err instanceof Error ? err.message : String(err)
  return new LlmError('GENERATION_FAILED', message)
}
