import type { ModelEntry } from '@shared/types'
import { api } from '../lib/api'
import { formatBytes, formatDuration } from '../lib/format'

export function ModelProgress({ model }: { model: ModelEntry }) {
  const s = model.state
  if (s.kind === 'downloading' || s.kind === 'paused') {
    const pct = s.totalBytes > 0 ? (s.receivedBytes / s.totalBytes) * 100 : 0
    return (
      <div className="dl">
        <progress max={100} value={pct} aria-label={`${model.name} download progress`} />
        <div className="dl-meta">
          <span>
            {formatBytes(s.receivedBytes)} / {formatBytes(s.totalBytes)} ({pct.toFixed(1)}%)
          </span>
          {s.kind === 'downloading' ? (
            <span>
              {formatBytes(s.bytesPerSecond)}/s · ETA {formatDuration(s.etaSeconds)}
            </span>
          ) : (
            <span>Paused</span>
          )}
        </div>
      </div>
    )
  }
  if (s.kind === 'verifying') return <div className="hint">Verifying SHA-256 checksum…</div>
  if (s.kind === 'error')
    return (
      <div className="error-message" role="alert">
        {s.message}
      </div>
    )
  return null
}

export function ModelActions({
  model,
  onAfterDelete
}: {
  model: ModelEntry
  onAfterDelete?: () => void
}) {
  const s = model.state
  const id = model.id
  switch (s.kind) {
    case 'absent':
      return (
        <button className="btn" onClick={() => void api.invoke('models:download', { modelId: id })}>
          Download
        </button>
      )
    case 'downloading':
      return (
        <div className="row gap">
          <button className="btn" onClick={() => void api.invoke('models:pause', { modelId: id })}>
            Pause
          </button>
          <button
            className="btn subtle"
            onClick={() => void api.invoke('models:cancel', { modelId: id })}
          >
            Cancel
          </button>
        </div>
      )
    case 'paused':
    case 'error':
      return (
        <div className="row gap">
          <button
            className="btn"
            onClick={() => void api.invoke('models:download', { modelId: id })}
          >
            {s.kind === 'paused' || s.receivedBytes > 0 ? 'Resume' : 'Retry'}
          </button>
          <button
            className="btn subtle"
            onClick={() => void api.invoke('models:cancel', { modelId: id })}
          >
            Cancel
          </button>
        </div>
      )
    case 'verifying':
      return null
    case 'ready':
      return (
        <button
          className="btn subtle"
          onClick={() => {
            void api.invoke('models:delete', { modelId: id }).then(() => onAfterDelete?.())
          }}
        >
          {model.imported ? 'Remove' : 'Delete'}
        </button>
      )
  }
}
