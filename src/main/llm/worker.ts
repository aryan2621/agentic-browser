/**
 * Inference worker. Runs inside an Electron utilityProcess so model loading and token
 * generation never block the main process or the UI.
 *
 * node-llama-cpp is ESM-only; it is loaded with a dynamic import() (kept as a real import()
 * in the CommonJS bundle) the first time it is needed.
 */
import type {
  ChatHistoryItem,
  Llama,
  LlamaContext,
  LlamaContextSequence,
  LlamaEmbeddingContext,
  LlamaGrammar,
  LlamaModel
} from 'node-llama-cpp'
import type { LlmErrorCode } from '@shared/types'
import type { FromWorker, ModelSpec, ToWorker, WorkerHardware, WorkerStatus } from './protocol'

type NodeLlamaCpp = typeof import('node-llama-cpp')

const port = process.parentPort

function send(msg: FromWorker): void {
  port.postMessage(msg)
}

class WorkerError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string
  ) {
    super(message)
  }
}

// ------------------------------------------------------------------ state

let lib: NodeLlamaCpp | null = null
let llama: Llama | null = null
let gpuPreference: 'auto' | 'off' = 'auto'
let idleUnloadMs = 10 * 60_000

interface GenSlot {
  spec: ModelSpec
  model: LlamaModel
  context: LlamaContext
  /**
   * One sequence reused by every request (they run one at a time). Reuse lets llama.cpp keep the
   * evaluated prompt prefix, so repeated system prompts aren't re-processed.
   */
  sequence: LlamaContextSequence
  lastUsed: number
}
interface EmbedSlot {
  spec: ModelSpec
  model: LlamaModel
  context: LlamaEmbeddingContext
  lastUsed: number
}

let gen: GenSlot | null = null
let embedSlot: EmbedSlot | null = null
let loading = false
let busy = 0
const aborts = new Map<number, AbortController>()
const grammarCache = new Map<string, LlamaGrammar>()

/** Serialises everything that touches the generation model (one sequence, one model). */
let genQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = genQueue.then(fn, fn)
  genQueue = run.catch(() => undefined)
  return run
}

async function getLib(): Promise<NodeLlamaCpp> {
  lib ??= await import('node-llama-cpp')
  return lib
}

async function getLlamaInstance(): Promise<Llama> {
  if (llama) return llama
  const m = await getLib()
  llama = await m.getLlama({
    gpu: gpuPreference === 'off' ? false : 'auto',
    // Use only the prebuilt binaries that ship with the app. Never download or compile llama.cpp
    // at runtime: that would be a hidden network call and needs a toolchain users don't have.
    build: 'never',
    logLevel: m.LlamaLogLevel.warn,
    logger: (level, message) => {
      const text = message.trim()
      if (!text) return
      send({
        type: 'log',
        level: level === m.LlamaLogLevel.error ? 'error' : 'warn',
        message: text
      })
    }
  })
  return llama
}

// ------------------------------------------------------------------ status

async function status(): Promise<WorkerStatus> {
  let vramUsedBytes: number | null = null
  if (llama && llama.gpu !== false) {
    try {
      vramUsedBytes = (await llama.getVramState()).used
    } catch {
      vramUsedBytes = null
    }
  }
  return {
    genModel: gen?.spec.id ?? null,
    embedModel: embedSlot?.spec.id ?? null,
    loading,
    gpu: llama?.gpu ?? false,
    gpuLayers: gen?.model.gpuLayers ?? null,
    contextSize: gen?.context.contextSize ?? null,
    memoryBytes: process.memoryUsage().rss,
    vramUsedBytes
  }
}

async function pushStatus(): Promise<void> {
  send({ type: 'status', status: await status() })
}

// ------------------------------------------------------------------ model loading

function classifyLoadError(err: unknown, path: string): WorkerError {
  const message = err instanceof Error ? err.message : String(err)
  if (lib && err instanceof lib.InsufficientMemoryError) {
    return new WorkerError('OUT_OF_MEMORY', `Not enough memory to load the model: ${message}`)
  }
  if (/ENOENT|no such file/i.test(message)) {
    return new WorkerError('MODEL_MISSING', `Model file not found: ${path}`)
  }
  if (/memory|alloc|OOM/i.test(message)) {
    return new WorkerError('OUT_OF_MEMORY', `Not enough memory: ${message}`)
  }
  if (/magic|invalid (gguf|file)|unexpected end|truncat|checksum/i.test(message)) {
    return new WorkerError(
      'MODEL_CORRUPT',
      `Failed to load model (file may be corrupted): ${message}`
    )
  }
  // e.g. an architecture this llama.cpp build doesn't support: redownloading won't help.
  return new WorkerError('MODEL_LOAD_FAILED', `Failed to load model: ${message}`)
}

/**
 * Load with GPU offload, falling back to CPU-only when the GPU path fails (driver, Vulkan or VRAM
 * problems). Only a failure on CPU as well is reported, so a GPU issue is never mislabelled as a
 * corrupted file.
 */
async function loadWithFallback(
  l: Llama,
  path: string,
  gpuLayers: Parameters<Llama['loadModel']>[0]['gpuLayers']
): Promise<LlamaModel> {
  if (l.gpu === false) return l.loadModel({ modelPath: path, gpuLayers: 0 })
  try {
    return await l.loadModel({ modelPath: path, gpuLayers })
  } catch (err) {
    if (/ENOENT|no such file/i.test(err instanceof Error ? err.message : String(err))) throw err
    send({
      type: 'log',
      level: 'warn',
      message: `GPU load failed (${err instanceof Error ? err.message : String(err)}); retrying on CPU.`
    })
    return l.loadModel({ modelPath: path, gpuLayers: 0 })
  }
}

async function disposeGen(): Promise<void> {
  const slot = gen
  gen = null
  grammarCache.clear()
  if (!slot) return
  await slot.context.dispose().catch(() => undefined)
  await slot.model.dispose().catch(() => undefined)
}

async function disposeEmbed(): Promise<void> {
  const slot = embedSlot
  embedSlot = null
  if (!slot) return
  await slot.context.dispose().catch(() => undefined)
  await slot.model.dispose().catch(() => undefined)
}

async function ensureGen(spec: ModelSpec): Promise<GenSlot> {
  if (gen && gen.spec.path === spec.path && gen.spec.contextSize === spec.contextSize) {
    gen.lastUsed = Date.now()
    return gen
  }
  // Only one large model may be resident at a time.
  await disposeGen()
  loading = true
  await pushStatus()
  try {
    const l = await getLlamaInstance()
    let model: LlamaModel
    try {
      // Fit GPU layers for the configured context, so the context isn't silently shrunk later.
      model = await loadWithFallback(l, spec.path, {
        fitContext: { contextSize: spec.contextSize }
      })
    } catch (err) {
      throw classifyLoadError(err, spec.path)
    }
    // Clamp to what memory allows: node-llama-cpp picks the largest size in [min, max] that fits.
    const createContext = (m: LlamaModel): Promise<LlamaContext> => {
      const max = Math.min(spec.contextSize, m.trainContextSize || spec.contextSize)
      return m.createContext({
        contextSize: { min: Math.min(2048, max), max },
        sequences: 1,
        // Slightly faster prompt reading on GPUs (measured: flash attention made no difference).
        batchSize: 1024
      })
    }
    let context: LlamaContext
    try {
      context = await createContext(model)
    } catch (err) {
      await model.dispose().catch(() => undefined)
      // Not enough VRAM for the context: retry with everything on CPU before giving up.
      if (l.gpu === false) {
        const e = classifyLoadError(err, spec.path)
        throw e.code === 'MODEL_CORRUPT' || e.code === 'MODEL_LOAD_FAILED'
          ? new WorkerError('OUT_OF_MEMORY', e.message)
          : e
      }
      try {
        model = await l.loadModel({ modelPath: spec.path, gpuLayers: 0 })
        context = await createContext(model)
      } catch (cpuErr) {
        await model.dispose().catch(() => undefined)
        const e = classifyLoadError(cpuErr, spec.path)
        throw e.code === 'MODEL_CORRUPT' || e.code === 'MODEL_LOAD_FAILED'
          ? new WorkerError('OUT_OF_MEMORY', e.message)
          : e
      }
    }
    gen = { spec, model, context, sequence: context.getSequence(), lastUsed: Date.now() }
    send({
      type: 'log',
      level: 'info',
      message: `Loaded ${spec.id} (gpu=${String(l.gpu)}, layers=${model.gpuLayers}, ctx=${context.contextSize})`
    })
    return gen
  } finally {
    loading = false
    await pushStatus()
  }
}

async function ensureEmbed(spec: ModelSpec): Promise<EmbedSlot> {
  if (embedSlot && embedSlot.spec.path === spec.path) {
    embedSlot.lastUsed = Date.now()
    return embedSlot
  }
  await disposeEmbed()
  loading = true
  await pushStatus()
  try {
    const l = await getLlamaInstance()
    let model: LlamaModel
    try {
      model = await loadWithFallback(l, spec.path, 'auto')
    } catch (err) {
      throw classifyLoadError(err, spec.path)
    }
    try {
      const context = await model.createEmbeddingContext({
        contextSize: Math.min(spec.contextSize, model.trainContextSize || 2048)
      })
      embedSlot = { spec, model, context, lastUsed: Date.now() }
      return embedSlot
    } catch (err) {
      await model.dispose().catch(() => undefined)
      throw classifyLoadError(err, spec.path)
    }
  } finally {
    loading = false
    await pushStatus()
  }
}

async function grammarFor(schema: Record<string, unknown>): Promise<LlamaGrammar> {
  const key = JSON.stringify(schema)
  const cached = grammarCache.get(key)
  if (cached) return cached
  const l = await getLlamaInstance()
  // The schema is produced by our own code and matches GbnfJsonSchema.
  const grammar = await l.createGrammarForJsonSchema(
    schema as Parameters<Llama['createGrammarForJsonSchema']>[0]
  )
  grammarCache.set(key, grammar)
  return grammar
}

// ------------------------------------------------------------------ handlers

async function handleGenerate(msg: Extract<ToWorker, { type: 'generate' }>): Promise<void> {
  const controller = new AbortController()
  aborts.set(msg.id, controller)
  try {
    await enqueue(async () => {
      if (controller.signal.aborted) throw new WorkerError('ABORTED', 'Stopped.')
      const slot = await ensureGen(msg.model)
      const m = await getLib()
      busy++
      const sequence = slot.sequence
      // Recurrent/hybrid models (e.g. Qwen3.5) can't reliably rewind a reused state, so they
      // start each request from a clean sequence. Transformers keep the prefix cache.
      if (slot.model.fileInsights.isRecurrent || slot.model.fileInsights.isHybrid) {
        await sequence.clearHistory()
      }
      const systemPrompt = msg.messages
        .filter((x) => x.role === 'system')
        .map((x) => x.content)
        .join('\n\n')
      const convo = msg.messages.filter((x) => x.role !== 'system')
      const last = convo.pop()
      if (!last || last.role !== 'user')
        throw new WorkerError('GENERATION_FAILED', 'Last message must be from the user.')

      // The model's own chat template is applied by node-llama-cpp's resolved chat wrapper.
      const session = new m.LlamaChatSession({
        contextSequence: sequence,
        autoDisposeSequence: false
      })
      const history: ChatHistoryItem[] = []
      if (systemPrompt) history.push({ type: 'system', text: systemPrompt })
      for (const item of convo) {
        history.push(
          item.role === 'user'
            ? { type: 'user', text: item.content }
            : { type: 'model', response: [item.content] }
        )
      }
      session.setChatHistory(history)

      // Never let the prompt plus the answer overflow the context: node-llama-cpp would
      // silently drop the start of the prompt (the sources), so the answer could no longer be
      // grounded in them. Leave room for the chat template's own tokens.
      const promptTokens = slot.model.tokenize(msg.messages.map((x) => x.content).join('\n')).length
      const templateTokens = 16 * msg.messages.length + 32
      const room = slot.context.contextSize - promptTokens - templateTokens
      if (room < 64) {
        throw new WorkerError(
          'CONTEXT_TOO_SMALL',
          `The text is too long for the model's context (${promptTokens} of ${slot.context.contextSize} tokens). Use fewer sources, or raise the context size in Settings → Performance.`
        )
      }
      const maxTokens = Math.min(msg.maxTokens, room)

      const grammar = msg.jsonSchema ? await grammarFor(msg.jsonSchema) : undefined
      let tokenCount = 0
      let firstTokenAt: number | null = null
      const started = Date.now()
      try {
        const result = await session.promptWithMeta(last.content, {
          temperature: msg.temperature,
          maxTokens,
          signal: controller.signal,
          stopOnAbortSignal: true,
          // Reasoning models (Qwen3, ...) would otherwise spend the token budget on hidden
          // thoughts; our prompts get the answer directly.
          budgets: { thoughtTokens: 0 },
          ...(grammar ? { grammar } : {}),
          onToken: (tokens) => {
            if (firstTokenAt === null) firstTokenAt = Date.now()
            tokenCount += tokens.length
          },
          onTextChunk: (text) => send({ type: 'token', id: msg.id, text })
        })
        const elapsed = (Date.now() - (firstTokenAt ?? started)) / 1000
        slot.lastUsed = Date.now()
        send({
          type: 'generated',
          id: msg.id,
          text: result.responseText,
          tokens: tokenCount,
          tokensPerSecond: tokenCount > 1 && elapsed > 0 ? tokenCount / elapsed : null,
          stopReason:
            result.stopReason === 'abort'
              ? 'abort'
              : result.stopReason === 'maxTokens'
                ? 'maxTokens'
                : 'eos'
        })
      } finally {
        session.dispose({ disposeSequence: false })
        busy--
      }
    })
  } catch (err) {
    sendError(msg.id, err)
  } finally {
    aborts.delete(msg.id)
    void pushStatus()
  }
}

function sendError(id: number, err: unknown): void {
  if (err instanceof WorkerError) {
    send({ type: 'error', id, code: err.code, message: err.message })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  if (lib && err instanceof lib.InsufficientMemoryError) {
    send({ type: 'error', id, code: 'OUT_OF_MEMORY', message })
    return
  }
  send({ type: 'error', id, code: 'GENERATION_FAILED', message })
}

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.type) {
    case 'configure': {
      idleUnloadMs = msg.idleUnloadMs
      if (msg.gpu !== gpuPreference) {
        gpuPreference = msg.gpu
        // Backend choice changes require a fresh llama instance.
        await enqueue(async () => {
          await disposeGen()
          await disposeEmbed()
          if (llama) await llama.dispose().catch(() => undefined)
          llama = null
        })
        await pushStatus()
      }
      return
    }
    case 'hardware': {
      try {
        const l = await getLlamaInstance()
        const vram = await l.getVramState()
        const hw: WorkerHardware = {
          gpu: l.gpu,
          gpuDeviceNames: await l.getGpuDeviceNames().catch(() => []),
          vramTotalBytes: vram.total,
          vramFreeBytes: vram.free,
          unifiedMemory: vram.unifiedSize > 0
        }
        send({ type: 'result', id: msg.id, value: hw })
      } catch (err) {
        sendError(msg.id, err)
      }
      return
    }
    case 'generate':
      return handleGenerate(msg)
    case 'abort':
      aborts.get(msg.id)?.abort()
      return
    case 'tokenize': {
      try {
        const counts = await enqueue(async () => {
          const slot = await ensureGen(msg.model)
          return msg.texts.map((t) => slot.model.tokenize(t).length)
        })
        send({ type: 'result', id: msg.id, value: counts })
      } catch (err) {
        sendError(msg.id, err)
      }
      return
    }
    case 'context-size': {
      try {
        const size = await enqueue(async () => (await ensureGen(msg.model)).context.contextSize)
        send({ type: 'result', id: msg.id, value: size })
      } catch (err) {
        sendError(msg.id, err)
      }
      return
    }
    case 'embed': {
      try {
        // Queued like generation, so a reconfigure or unload can't free the model mid-use
        // and two retrievals can't load it twice.
        const vectors = await enqueue(async () => {
          const slot = await ensureEmbed(msg.model)
          busy++
          try {
            const out: Float32Array[] = []
            for (const text of msg.texts) {
              const e = await slot.context.getEmbeddingFor(text)
              out.push(Float32Array.from(e.vector))
            }
            slot.lastUsed = Date.now()
            return out
          } finally {
            busy--
          }
        })
        send({ type: 'result', id: msg.id, value: vectors })
      } catch (err) {
        sendError(msg.id, err)
      }
      return
    }
    case 'unload': {
      await enqueue(async () => {
        await disposeGen()
        await disposeEmbed()
      })
      await pushStatus()
      send({ type: 'result', id: msg.id, value: null })
      return
    }
  }
}

// Idle unload: free RAM/VRAM when models have not been used for a while.
setInterval(() => {
  if (idleUnloadMs <= 0 || busy > 0 || loading) return
  const now = Date.now()
  // Re-check inside the queue: a request queued meanwhile has just used the model.
  if (gen && now - gen.lastUsed > idleUnloadMs) {
    void enqueue(async () => {
      if (gen && Date.now() - gen.lastUsed > idleUnloadMs) await disposeGen()
    }).then(pushStatus)
  }
  if (embedSlot && now - embedSlot.lastUsed > idleUnloadMs) {
    void enqueue(async () => {
      if (embedSlot && Date.now() - embedSlot.lastUsed > idleUnloadMs) await disposeEmbed()
    }).then(pushStatus)
  }
}, 15_000).unref()

// Periodic status so the UI can show memory use.
setInterval(() => {
  if (gen || embedSlot) void pushStatus()
}, 5_000).unref()

port.on('message', (event: { data: ToWorker }) => {
  void handle(event.data)
})

process.on('uncaughtException', (err) => {
  send({ type: 'log', level: 'error', message: `Worker crashed: ${err.stack ?? err.message}` })
  process.exit(1)
})

send({ type: 'ready' })
