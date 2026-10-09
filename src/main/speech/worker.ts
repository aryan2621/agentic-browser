/**
 * Speech-to-text utility process: Whisper (whisper.cpp via @fugood/whisper.node, Metal/CUDA/Vulkan
 * when available). Kept out of the main process for the same reasons as LLM inference: a native
 * crash or memory spike cannot take the app down, and the model's memory is freed by unloading.
 */
import type { FromSpeechWorker, ToSpeechWorker } from './protocol'

interface TranscribeResult {
  result: string
  language?: string
}
interface WhisperContext {
  transcribeData(
    audio: ArrayBuffer,
    options?: { language?: string; maxThreads?: number; temperature?: number }
  ): { stop: () => Promise<void>; promise: Promise<TranscribeResult> }
  release(): Promise<void>
}
interface WhisperModule {
  initWhisper(options: {
    filePath: string
    useGpu?: boolean
    useFlashAttn?: boolean
  }): Promise<WhisperContext>
}

const port = process.parentPort
const send = (msg: FromSpeechWorker): void => port.postMessage(msg)

const IDLE_UNLOAD_MS = 5 * 60_000

let lib: WhisperModule | null = null
let ctx: { path: string; context: WhisperContext } | null = null
let lastUsed = 0
let queue: Promise<unknown> = Promise.resolve()

async function context(path: string): Promise<WhisperContext> {
  if (ctx?.path === path) return ctx.context
  await unload()
  // The binding is CommonJS with a native addon; load it only when speech is first used.
  // (A variable specifier keeps the bundler and type checker out of the package's TS sources.)
  const specifier = '@fugood/whisper.node'
  lib ??= (await import(specifier)) as WhisperModule
  const loaded = await lib.initWhisper({ filePath: path, useGpu: true, useFlashAttn: true })
  ctx = { path, context: loaded }
  return loaded
}

async function unload(): Promise<void> {
  const current = ctx
  ctx = null
  if (current) await current.context.release().catch(() => undefined)
}

async function transcribe(msg: Extract<ToSpeechWorker, { type: 'transcribe' }>): Promise<void> {
  const started = Date.now()
  try {
    const whisper = await context(msg.modelPath)
    const { promise } = whisper.transcribeData(msg.pcm16, {
      language: msg.language || 'auto',
      temperature: 0
    })
    const res = await promise
    lastUsed = Date.now()
    send({
      type: 'result',
      id: msg.id,
      text: res.result.replace(/\s+/g, ' ').trim(),
      language: res.language ?? null,
      ms: Date.now() - started
    })
  } catch (err) {
    send({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
  }
}

port.on('message', (event: { data: ToSpeechWorker }) => {
  const msg = event.data
  if (msg.type === 'transcribe') {
    const run = queue.then(() => transcribe(msg))
    queue = run.catch(() => undefined)
  } else if (msg.type === 'warmup') {
    // Load the model while the user is still speaking.
    const run = queue.then(async () => {
      await context(msg.modelPath)
      lastUsed = Date.now()
    })
    queue = run.catch(() => undefined)
  } else if (msg.type === 'unload') {
    // Queued, so the model is never freed in the middle of a transcription.
    queue = queue.then(unload).catch(() => undefined)
  }
})

setInterval(() => {
  if (!ctx || Date.now() - lastUsed <= IDLE_UNLOAD_MS) return
  queue = queue
    .then(async () => {
      if (ctx && Date.now() - lastUsed > IDLE_UNLOAD_MS) await unload()
    })
    .catch(() => undefined)
}, 30_000).unref()

send({ type: 'ready' })
