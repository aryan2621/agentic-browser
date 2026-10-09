export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export function gpuLabel(gpu: string | false): string {
  if (gpu === false) return 'CPU'
  return gpu === 'metal'
    ? 'Metal GPU'
    : gpu === 'cuda'
      ? 'CUDA GPU'
      : gpu === 'vulkan'
        ? 'Vulkan GPU'
        : String(gpu)
}

export const isMac = window.api.platform === 'darwin'
export const mod = isMac ? '⌘' : 'Ctrl+'
