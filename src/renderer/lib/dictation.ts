import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

export type DictationState = 'idle' | 'recording' | 'transcribing'

const SAMPLE_RATE = 16_000
const MAX_SECONDS = 120

/** Decode a recording, mix it to mono and resample to 16 kHz 16-bit PCM (whisper.cpp's input). */
async function toPcm16(blob: Blob): Promise<ArrayBuffer> {
  const decoder = new AudioContext()
  try {
    const audio = await decoder.decodeAudioData(await blob.arrayBuffer())
    // The recorder stops a moment after the limit; trim so the upload never exceeds it.
    const frames = Math.max(
      1,
      Math.min(Math.ceil(audio.duration * SAMPLE_RATE), SAMPLE_RATE * MAX_SECONDS)
    )
    const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE)
    const src = offline.createBufferSource()
    src.buffer = audio
    src.connect(offline.destination)
    src.start()
    const samples = (await offline.startRendering()).getChannelData(0)
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return pcm.buffer
  } finally {
    void decoder.close()
  }
}

/**
 * Click-to-talk dictation: record from the microphone, then transcribe locally with Whisper.
 * `onText` receives the recognised text. Audio stays on this computer.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  // A start in progress (waiting for mic permission): blocks a second click from starting twice.
  const starting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  const start = useCallback(async () => {
    if (starting.current) return
    starting.current = true
    setError(null)
    try {
      if (!(await api.invoke('speech:mic-access'))) {
        throw new Error('Microphone access is off. Allow it in System Settings → Privacy.')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      // The mic button went away while permission was being asked: release the mic at once.
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const chunks: Blob[] = []
      const rec = new MediaRecorder(stream)
      recorder.current = rec
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        recorder.current = null
        setState('transcribing')
        void (async () => {
          try {
            const pcm16 = await toPcm16(new Blob(chunks, { type: rec.mimeType }))
            if (pcm16.byteLength < SAMPLE_RATE * 2 * 0.3)
              throw new Error('Too short: hold on a moment longer.')
            const { text } = await api.invoke('speech:transcribe', { pcm16 })
            if (!mounted.current) return
            if (text) onTextRef.current(text)
            else setError('No speech detected.')
          } catch (err) {
            setError(cleanError(err))
          } finally {
            setState('idle')
          }
        })()
      }
      rec.start()
      setState('recording')
      void api.invoke('speech:warmup').catch(() => undefined)
      timer.current = setTimeout(stop, MAX_SECONDS * 1000)
    } catch (err) {
      setError(cleanError(err))
      setState('idle')
    } finally {
      starting.current = false
    }
  }, [stop])

  const toggle = useCallback(() => {
    if (state === 'recording') stop()
    else if (state === 'idle') void start()
  }, [state, start, stop])

  useEffect(() => stop, [stop])

  return { state, error, toggle, clearError: () => setError(null) }
}

function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
