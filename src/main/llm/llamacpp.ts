import { utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { LlmStatus, ModelRole } from '@shared/types'
import type { FromWorker, ModelSpec, ToWorker, WorkerHardware, WorkerStatus } from './protocol'
import {
  LlmError,
  toErrorInfo,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type GenerationRole,
  type LLMProvider
} from './provider'

/** Resolves a role to a model file on disk (provided by the model manager + settings). */
export type ModelResolver = (role: ModelRole) => ModelSpec | null

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onToken?: (text: string) => void
}

const MAX_RESTARTS_PER_MINUTE = 3

/**
 * Client for the inference utility process. Owns the worker lifecycle: lazy start,
 * crash detection with automatic restart, request multiplexing, streaming and aborts.
 */
export class LlamaCppProvider implements LLMProvider {
  readonly kind = 'llamacpp' as const

  private child: UtilityProcess | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly events = new EventEmitter<{ status: [LlmStatus] }>()
  private workerStatus: WorkerStatus | null = null
  private generating = 0
  private lastTps: number | null = null
  private lastError: LlmStatus['error'] = null
  private restarts: number[] = []
  private config: { idleUnloadMs: number; gpu: 'auto' | 'off' }
  private disposed = false
  private killing = false

  constructor(
    private readonly resolveModel: ModelResolver,
    config: { idleUnloadMs: number; gpu: 'auto' | 'off' },
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void = () => {}
  ) {
    this.config = config
  }

  // ---------------------------------------------------------------- worker lifecycle

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'worker.js'), [], {
        serviceName: 'Agentic Browser LLM',
        stdio: 'inherit'
      })
      this.child = child
      // A worker that never says "ready" is killed, so the next request starts a fresh one.
      const timer = setTimeout(() => {
        if (this.child === child) {
          this.child = null
          this.ready = null
        }
        child.kill()
        reject(new LlmError('WORKER_CRASHED', 'Inference worker did not start.'))
      }, 30_000)
      child.on('message', (msg: FromWorker) => {
        if (msg.type === 'ready') {
          clearTimeout(timer)
          this.send({ type: 'configure', ...this.config })
          resolve()
          return
        }
        this.onMessage(msg)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        // A worker replaced after a start timeout must not reset its successor.
        if (this.child === child) this.onExit(code)
        reject(new LlmError('WORKER_CRASHED', `Inference worker exited (code ${code}).`))
      })
    })
    return this.ready
  }

  private onExit(code: number): void {
    this.child = null
    this.ready = null
    this.workerStatus = null
    // `generating` is not reset: each pending generate() decrements it as it is rejected below.
    const crashed = !this.disposed && !this.killing && code !== 0
    this.killing = false
    const err = new LlmError(
      'WORKER_CRASHED',
      crashed
        ? 'The local model process stopped unexpectedly (possibly out of memory). It will restart on the next request.'
        : 'The local model process stopped.'
    )
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    if (crashed) {
      this.log('error', `LLM worker exited with code ${code}`)
      const now = Date.now()
      this.restarts = this.restarts.filter((t) => now - t < 60_000)
      this.lastError = err.toInfo()
    }
    this.emitStatus()
  }

  private send(msg: ToWorker): void {
    this.child?.postMessage(msg)
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'token':
        this.pending.get(msg.id)?.onToken?.(msg.text)
        return
      case 'result': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.resolve(msg.value)
        return
      }
      case 'generated': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.resolve(msg)
        return
      }
      case 'error': {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.reject(new LlmError(msg.code, msg.message))
        return
      }
      case 'status':
        this.workerStatus = msg.status
        this.emitStatus()
        return
      case 'log':
        this.log(msg.level, msg.message)
        return
      case 'ready':
        return
    }
  }

  private async request<T>(
    build: (id: number) => ToWorker,
    onToken?: (t: string) => void,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) throw new LlmError('WORKER_CRASHED', 'Shutting down.')
    if (!this.child) {
      const now = Date.now()
      this.restarts = this.restarts.filter((t) => now - t < 60_000)
      if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
        throw new LlmError(
          'WORKER_CRASHED',
          'The local model process keeps crashing. Try a smaller model or a smaller context size in Settings.'
        )
      }
      this.restarts.push(now)
    }
    await this.start()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LlmError('ABORTED', 'Stopped.'))
        return
      }
      const onAbort = (): void => this.send({ type: 'abort', id })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(v as T)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
        onToken
      })
      this.send(build(id))
    })
  }

  private spec(role: ModelRole): ModelSpec {
    const spec = this.resolveModel(role)
    if (!spec) {
      throw new LlmError(
        'NO_MODEL',
        role === 'embed'
          ? 'No embedding model is installed.'
          : 'No local model is installed yet. Download one from the Models screen.'
      )
    }
    return spec
  }

  // ---------------------------------------------------------------- LLMProvider

  modelId(role: GenerationRole | 'embed'): string | null {
    return this.resolveModel(role)?.id ?? null
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResult> {
    const model = this.spec(req.role)
    this.generating++
    this.emitStatus()
    try {
      const res = await this.request<Extract<FromWorker, { type: 'generated' }>>(
        (id) => ({
          type: 'generate',
          id,
          model,
          messages: req.messages,
          temperature: req.temperature,
          maxTokens: req.maxTokens ?? 1024,
          ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {})
        }),
        opts.onToken,
        opts.signal
      )
      if (res.tokensPerSecond !== null) this.lastTps = res.tokensPerSecond
      this.lastError = null
      return {
        text: res.text,
        tokens: res.tokens,
        tokensPerSecond: res.tokensPerSecond,
        stopReason: res.stopReason
      }
    } catch (err) {
      if (err instanceof LlmError && err.code !== 'ABORTED') this.lastError = err.toInfo()
      throw err
    } finally {
      this.generating = Math.max(0, this.generating - 1)
      this.emitStatus()
    }
  }

  async countTokens(texts: string[], role: GenerationRole): Promise<number[]> {
    if (texts.length === 0) return []
    const model = this.spec(role)
    return this.request<number[]>((id) => ({ type: 'tokenize', id, model, texts }))
  }

  async contextSize(role: GenerationRole): Promise<number> {
    const model = this.spec(role)
    return this.request<number>((id) => ({ type: 'context-size', id, model }))
  }

  canEmbed(): boolean {
    return this.resolveModel('embed') !== null
  }

  async embed(texts: string[], opts: { signal?: AbortSignal } = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const model = this.spec('embed')
    const out: Float32Array[] = []
    // Batch to keep individual IPC messages small and allow cancellation between batches.
    for (let i = 0; i < texts.length; i += 16) {
      if (opts.signal?.aborted) throw new LlmError('ABORTED', 'Stopped.')
      const batch = texts.slice(i, i + 16)
      out.push(
        ...(await this.request<Float32Array[]>((id) => ({
          type: 'embed',
          id,
          model,
          texts: batch
        })))
      )
    }
    return out
  }

  async hardware(): Promise<WorkerHardware> {
    return this.request<WorkerHardware>((id) => ({ type: 'hardware', id }))
  }

  configure(config: { idleUnloadMs: number; gpu: 'auto' | 'off' }): void {
    this.config = config
    this.send({ type: 'configure', ...config })
  }

  status(): LlmStatus {
    const ws = this.workerStatus
    return {
      provider: 'llamacpp',
      state:
        this.lastError && !this.generating
          ? 'error'
          : ws?.loading
            ? 'loading'
            : this.generating > 0
              ? 'generating'
              : ws?.genModel
                ? 'ready'
                : 'idle',
      activeModel: ws?.genModel ?? null,
      embedModelLoaded: Boolean(ws?.embedModel),
      gpu: ws?.gpu ?? false,
      gpuLayers: ws?.gpuLayers ?? null,
      contextSize: ws?.contextSize ?? null,
      workerMemoryBytes: ws?.memoryBytes ?? null,
      vramUsedBytes: ws?.vramUsedBytes ?? null,
      lastTokensPerSecond: this.lastTps,
      error: this.lastError
    }
  }

  onStatus(listener: (status: LlmStatus) => void): () => void {
    this.events.on('status', listener)
    return () => this.events.off('status', listener)
  }

  private emitStatus(): void {
    this.events.emit('status', this.status())
  }

  clearError(): void {
    this.lastError = null
    this.emitStatus()
  }

  async unloadAll(): Promise<void> {
    if (!this.child) return
    await this.request<null>((id) => ({ type: 'unload', id }))
  }

  async restart(): Promise<void> {
    const child = this.child
    if (child) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      this.killing = true
      child.kill()
      await exited
    }
    this.restarts = []
    this.lastError = null
    this.emitStatus()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.child?.kill()
    this.child = null
  }
}

export { toErrorInfo }
