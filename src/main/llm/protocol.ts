// Typed message protocol between the main process and the inference utility process.
import type { GpuBackend, LlmErrorCode } from '@shared/types'
import type { JsonSchema, PromptMessage } from './provider'

export type WorkerSlot = 'gen' | 'embed'

export interface ModelSpec {
  /** Identifier used for status display and cache keys. */
  id: string
  path: string
  contextSize: number
}

export type ToWorker =
  | { type: 'configure'; idleUnloadMs: number; gpu: 'auto' | 'off' }
  | { type: 'hardware'; id: number }
  | {
      type: 'generate'
      id: number
      model: ModelSpec
      messages: PromptMessage[]
      temperature: number
      maxTokens: number
      jsonSchema?: JsonSchema
    }
  | { type: 'abort'; id: number }
  | { type: 'tokenize'; id: number; model: ModelSpec; texts: string[] }
  | { type: 'context-size'; id: number; model: ModelSpec }
  | { type: 'embed'; id: number; model: ModelSpec; texts: string[] }
  | { type: 'unload'; id: number }

export interface WorkerHardware {
  gpu: GpuBackend
  gpuDeviceNames: string[]
  vramTotalBytes: number
  vramFreeBytes: number
  unifiedMemory: boolean
}

export interface WorkerStatus {
  genModel: string | null
  embedModel: string | null
  loading: boolean
  gpu: GpuBackend
  gpuLayers: number | null
  contextSize: number | null
  memoryBytes: number
  vramUsedBytes: number | null
}

export type FromWorker =
  | { type: 'ready' }
  | { type: 'token'; id: number; text: string }
  | { type: 'result'; id: number; value: unknown }
  | {
      type: 'generated'
      id: number
      text: string
      tokens: number
      tokensPerSecond: number | null
      stopReason: 'eos' | 'maxTokens' | 'abort'
    }
  | { type: 'error'; id: number; code: LlmErrorCode; message: string }
  | { type: 'status'; status: WorkerStatus }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
