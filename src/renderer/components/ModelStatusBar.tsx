import type { LlmStatus } from '@shared/types'
import { formatBytes, gpuLabel } from '../lib/format'

export function ModelStatusBar({ status }: { status: LlmStatus | null }) {
  if (!status) return null
  const label =
    status.provider === 'mock'
      ? 'Mock model (no inference)'
      : status.state === 'loading'
        ? 'Model loading…'
        : (status.activeModel ?? 'Model not loaded (loads on first use)')
  return (
    <div className="model-status" aria-live="polite">
      <span className={`dot state-${status.state}`} aria-hidden="true" />
      <span className="model-status-name" title={label}>
        {label}
      </span>
      {status.provider === 'llamacpp' && status.activeModel && (
        <span className="model-status-meta">
          {status.gpu !== false && status.gpuLayers === 0
            ? 'CPU (GPU fallback)'
            : gpuLabel(status.gpu)}
          {status.gpu !== false && status.gpuLayers ? ` · ${status.gpuLayers} layers` : ''}
          {status.contextSize ? ` · ctx ${status.contextSize}` : ''}
          {status.workerMemoryBytes ? ` · RAM ${formatBytes(status.workerMemoryBytes)}` : ''}
          {status.vramUsedBytes ? ` · VRAM ${formatBytes(status.vramUsedBytes)}` : ''}
        </span>
      )}
      {status.lastTokensPerSecond !== null && (
        <span className="model-status-tps">{status.lastTokensPerSecond.toFixed(1)} tok/s</span>
      )}
    </div>
  )
}
