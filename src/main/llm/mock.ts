import { EventEmitter } from 'node:events'
import type { LlmStatus } from '@shared/types'
import {
  LlmError,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type GenerationRole,
  type LLMProvider
} from './provider'

export interface MockProviderOptions {
  /** Delay between streamed tokens in ms. */
  tokenDelayMs?: number
  /** Scripted responses consumed in order (fixtures for scripted runs). */
  script?: string[]
  contextSize?: number
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('ABORTED', 'Stopped.'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new LlmError('ABORTED', 'Stopped.'))
      },
      { once: true }
    )
  })

/** Rough deterministic tokenizer for the mock (≈ 4 chars per token). */
export function mockTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

function hashVector(text: string, dims = 64): Float32Array {
  const v = new Float32Array(dims)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619)
    v[Math.abs(h) % dims]! += 1
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  return v.map((x) => x / norm)
}

/**
 * Deterministic provider for tests and for running the app without model files.
 * Produces plausible output from the prompt itself so the whole UI can be exercised.
 */
export class MockProvider implements LLMProvider {
  readonly kind = 'mock' as const
  private readonly events = new EventEmitter<{ status: [LlmStatus] }>()
  private readonly script: string[]
  private generating = 0
  readonly calls: GenerateRequest[] = []

  constructor(private readonly opts: MockProviderOptions = {}) {
    this.script = [...(opts.script ?? [])]
  }

  enqueue(...responses: string[]): void {
    this.script.push(...responses)
  }

  modelId(role: GenerationRole | 'embed'): string {
    return `mock-${role}`
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResult> {
    this.calls.push(req)
    this.generating++
    this.emit()
    try {
      const text = this.script.shift() ?? this.respond(req)
      const pieces = text.match(/\S+\s*|\s+/g) ?? []
      let out = ''
      for (const p of pieces) {
        await sleep(this.opts.tokenDelayMs ?? 0, opts.signal)
        out += p
        opts.onToken?.(p)
      }
      return { text: out, tokens: pieces.length, tokensPerSecond: 42, stopReason: 'eos' }
    } finally {
      this.generating--
      this.emit()
    }
  }

  private respond(req: GenerateRequest): string {
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    // Structured output: the mock has no grammar, so it returns an empty object.
    if (req.jsonSchema) return '{}'
    const content = /<page_content[^>]*>([\s\S]*?)<\/page_content>/.exec(user)?.[1] ?? user
    const sentences = content
      .replace(/[#>*_`[\]()]/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 20)
      .slice(0, 3)
    if (/summar/i.test(req.messages[0]?.content ?? '')) {
      return [
        '## TL;DR',
        `Mock summary: ${sentences[0] ?? 'This page has little text.'}`,
        '',
        '## Key points',
        ...sentences.map((s) => `- ${s}`)
      ].join('\n')
    }
    return `Mock answer. The page says: "${sentences[0] ?? 'nothing relevant'}"`
  }

  async countTokens(texts: string[]): Promise<number[]> {
    return texts.map(mockTokenCount)
  }

  async contextSize(): Promise<number> {
    return this.opts.contextSize ?? 8192
  }

  canEmbed(): boolean {
    return true
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashVector(t))
  }

  status(): LlmStatus {
    return {
      provider: 'mock',
      state: this.generating > 0 ? 'generating' : 'ready',
      activeModel: 'Mock model',
      embedModelLoaded: true,
      gpu: false,
      gpuLayers: null,
      contextSize: this.opts.contextSize ?? 8192,
      workerMemoryBytes: null,
      vramUsedBytes: null,
      lastTokensPerSecond: 42,
      error: null
    }
  }

  onStatus(listener: (status: LlmStatus) => void): () => void {
    this.events.on('status', listener)
    return () => this.events.off('status', listener)
  }

  private emit(): void {
    this.events.emit('status', this.status())
  }

  async unloadAll(): Promise<void> {}
  async restart(): Promise<void> {}
  async dispose(): Promise<void> {}
}
