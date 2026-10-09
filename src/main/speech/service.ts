import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { FromSpeechWorker, ToSpeechWorker } from './protocol'
import { SPEECH_LANGUAGES } from '@shared/speechLanguages'

/** 16 kHz mono 16-bit PCM: whisper.cpp's input format. Two minutes is plenty for dictation. */
export const MAX_SPEECH_BYTES = 16_000 * 2 * 120
/** A transcription taking longer than this is treated as stuck (the worker is restarted). */
const TRANSCRIBE_TIMEOUT_MS = 90_000

export class SpeechError extends Error {
  constructor(
    readonly code: 'NO_MODEL' | 'FAILED',
    message: string
  ) {
    super(message)
  }
}

/**
 * Speech-to-text for the mic buttons. Runs Whisper in its own utility process, started on first
 * use and restarted if it crashes; audio never leaves the machine.
 */
export class SpeechService {
  private child: UtilityProcess | null = null
  private ready: Promise<UtilityProcess> | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (text: string) => void; reject: (err: Error) => void }
  >()

  constructor(
    private readonly modelPath: () => string | null,
    private readonly language: () => string,
    private readonly log: (message: string) => void
  ) {}

  async transcribe(pcm16: ArrayBuffer): Promise<string> {
    const path = this.modelPath()
    if (!path) {
      throw new SpeechError(
        'NO_MODEL',
        'No speech model installed. Download one in Settings → Models (Speech to text).'
      )
    }
    const child = await this.start()
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new SpeechError('FAILED', 'Speech recognition took too long. Try again.'))
        this.log('Speech: transcription timed out; restarting the speech process')
        this.dispose()
      }, TRANSCRIBE_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer)
          resolve(text)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        }
      })
      const msg: ToSpeechWorker = {
        type: 'transcribe',
        id,
        modelPath: path,
        pcm16,
        language: languageCode(this.language())
      }
      child.postMessage(msg)
    })
  }

  /** Start loading the model (called when recording starts, so it is ready when it stops). */
  async warmup(): Promise<void> {
    const path = this.modelPath()
    if (!path) return
    const child = await this.start()
    const msg: ToSpeechWorker = { type: 'warmup', modelPath: path }
    child.postMessage(msg)
  }

  unload(): void {
    const msg: ToSpeechWorker = { type: 'unload' }
    this.child?.postMessage(msg)
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
    this.ready = null
  }

  private start(): Promise<UtilityProcess> {
    if (this.ready) return this.ready
    this.ready = new Promise<UtilityProcess>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'speechWorker.js'), [], {
        serviceName: 'Agentic Browser Speech',
        stdio: 'inherit'
      })
      this.child = child
      child.on('message', (msg: FromSpeechWorker) => {
        if (msg.type === 'ready') {
          resolve(child)
          return
        }
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.type === 'result') {
          this.log(`Speech: transcribed in ${msg.ms} ms (${msg.language ?? '?'})`)
          p.resolve(msg.text)
        } else {
          p.reject(new SpeechError('FAILED', `Speech recognition failed: ${msg.message}`))
        }
      })
      child.on('exit', (code) => {
        this.child = null
        this.ready = null
        for (const p of this.pending.values()) {
          p.reject(
            new SpeechError('FAILED', `The speech process stopped (code ${code}). Try again.`)
          )
        }
        this.pending.clear()
        reject(new SpeechError('FAILED', 'The speech process did not start.'))
      })
    })
    return this.ready
  }
}

/** Map the language setting ("de", "German", "" = detect) to a Whisper language code. */
function languageCode(setting: string): string {
  const s = setting.trim().toLowerCase()
  if (!s) return 'auto'
  if (SPEECH_LANGUAGES.some((l) => l.code === s)) return s
  const names: Record<string, string> = {
    english: 'en',
    hindi: 'hi',
    spanish: 'es',
    french: 'fr',
    german: 'de',
    italian: 'it',
    portuguese: 'pt',
    dutch: 'nl',
    russian: 'ru',
    chinese: 'zh',
    japanese: 'ja',
    korean: 'ko',
    arabic: 'ar',
    turkish: 'tr',
    polish: 'pl',
    ukrainian: 'uk',
    swedish: 'sv',
    bengali: 'bn',
    tamil: 'ta',
    telugu: 'te',
    marathi: 'mr',
    urdu: 'ur',
    indonesian: 'id',
    vietnamese: 'vi'
  }
  return names[s] ?? 'auto'
}
