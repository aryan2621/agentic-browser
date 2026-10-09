/** Messages between the main process and the speech-to-text utility process. */
export type ToSpeechWorker =
  | { type: 'transcribe'; id: number; modelPath: string; pcm16: ArrayBuffer; language: string }
  | { type: 'warmup'; modelPath: string }
  | { type: 'unload' }

export type FromSpeechWorker =
  | { type: 'ready' }
  | { type: 'result'; id: number; text: string; language: string | null; ms: number }
  | { type: 'error'; id: number; message: string }
