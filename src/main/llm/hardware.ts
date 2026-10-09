import os from 'node:os'
import type { HardwareInfo, ModelRecommendation } from '@shared/types'
import type { WorkerHardware } from './protocol'
import { MODEL_CATALOG } from './models'

const GB = 1024 ** 3

const FAST_MODEL = 'llama-3.2-3b-instruct-q4_k_m'
const STRONG_MODEL = 'qwen3-8b-q4_k_m'
const EMBED_MODEL = 'nomic-embed-text-v1.5-q8_0'
const SPEECH_MODEL = 'whisper-large-v3-turbo-q5_0'
const SMALL_SPEECH_MODEL = 'whisper-small-q5_1'
for (const id of [FAST_MODEL, STRONG_MODEL, EMBED_MODEL, SPEECH_MODEL, SMALL_SPEECH_MODEL]) {
  if (!MODEL_CATALOG.some((m) => m.id === id)) throw new Error(`Unknown catalog model ${id}`)
}

export function systemInfo(gpu: WorkerHardware | null): HardwareInfo {
  const cpus = os.cpus()
  return {
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    cpuModel: cpus[0]?.model ?? 'Unknown CPU',
    cpuCores: cpus.length,
    platform: process.platform,
    arch: process.arch,
    gpu: gpu?.gpu ?? false,
    gpuDeviceNames: gpu?.gpuDeviceNames ?? [],
    vramTotalBytes: gpu?.vramTotalBytes ?? 0,
    vramFreeBytes: gpu?.vramFreeBytes ?? 0,
    unifiedMemory: gpu?.unifiedMemory ?? false
  }
}

/**
 * Pick models that fit. One text model serves summaries, chat and search answers: the more
 * accurate Qwen3 8B when it fits comfortably (16 GB RAM or an 8 GB GPU), otherwise Llama 3.2 3B.
 * Speech-to-text runs alongside it: Whisper turbo unless memory is tight.
 */
export function recommendModels(
  hw: Pick<HardwareInfo, 'totalRamBytes' | 'vramTotalBytes' | 'gpu' | 'unifiedMemory'>
): ModelRecommendation {
  const ramGb = hw.totalRamBytes / GB
  const vramGb = hw.unifiedMemory ? 0 : hw.vramTotalBytes / GB
  const speech = ramGb >= 7 ? SPEECH_MODEL : SMALL_SPEECH_MODEL
  if (ramGb < 7) {
    return {
      fast: FAST_MODEL,
      embed: EMBED_MODEL,
      speech,
      tier: 'insufficient',
      reason: `${ramGb.toFixed(0)} GB RAM is below the 8 GB minimum. The 3B model may run slowly or fail to load.`
    }
  }
  if (ramGb >= 15 || (hw.gpu !== false && vramGb >= 8)) {
    return {
      fast: STRONG_MODEL,
      embed: EMBED_MODEL,
      speech,
      tier: 'standard',
      reason: `${ramGb.toFixed(0)} GB RAM: Qwen3 8B for accurate summaries, chat and search answers.`
    }
  }
  return {
    fast: FAST_MODEL,
    embed: EMBED_MODEL,
    speech,
    tier: 'small',
    reason: `${ramGb.toFixed(0)} GB RAM: Llama 3.2 3B for summaries, chat and search answers.`
  }
}
