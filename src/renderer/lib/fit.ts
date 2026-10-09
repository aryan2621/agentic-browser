import { useEffect, useState } from 'react'
import type { HardwareInfo, ModelEntry } from '@shared/types'
import { api } from './api'

/**
 * Whether this computer can run a catalog model: its RAM requirement must fit in system RAM, or
 * in VRAM on a machine with a discrete GPU. Imported files have no known requirement and always
 * count as fitting (the user chose them).
 */
export function modelFits(model: ModelEntry, hw: HardwareInfo | null): boolean {
  if (model.minRamBytes === null || hw === null) return true
  const vram = hw.unifiedMemory || hw.gpu === false ? 0 : hw.vramTotalBytes
  return model.minRamBytes <= Math.max(hw.totalRamBytes, vram)
}

let cached: Promise<HardwareInfo> | null = null

/** Hardware info (RAM, GPU), fetched once per session. */
export function useHardware(): HardwareInfo | null {
  const [hw, setHw] = useState<HardwareInfo | null>(null)
  useEffect(() => {
    cached ??= api.invoke('llm:hardware').then((r) => r.hardware)
    let alive = true
    void cached.then((h) => alive && setHw(h)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return hw
}
