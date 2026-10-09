import type { DownloadInfo } from '@shared/types'
import { api } from '../lib/api'
import { formatBytes, formatTime } from '../lib/format'
import { IconClose, IconFolder, IconPause, IconPlay } from './Icons'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function statusText(d: DownloadInfo): string {
  switch (d.state) {
    case 'progressing':
    case 'paused': {
      const done = formatBytes(d.receivedBytes)
      const of = d.totalBytes > 0 ? ` of ${formatBytes(d.totalBytes)}` : ''
      return `${done}${of}${d.state === 'paused' ? ' · Paused' : ''}`
    }
    case 'completed':
      return formatBytes(d.totalBytes || d.receivedBytes)
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Failed'
  }
}

export function DownloadsView({
  list,
  showClear = true
}: {
  list: DownloadInfo[] | null
  showClear?: boolean
}) {
  if (list === null) {
    return (
      <ul className="download-list" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="download-item">
            <span className="skeleton-line" style={{ width: '70%' }} />
            <span className="skeleton-line small" style={{ width: '35%' }} />
          </li>
        ))}
      </ul>
    )
  }
  const finished = list.some((d) => d.state !== 'progressing' && d.state !== 'paused')
  return (
    <div className="downloads-view">
      {list.length === 0 ? (
        <p className="empty">
          Files you download appear here. They are saved to your Downloads folder.
        </p>
      ) : (
        <ul className="download-list">
          {list.map((d) => {
            const active = d.state === 'progressing' || d.state === 'paused'
            const pct =
              d.totalBytes > 0
                ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100))
                : null
            return (
              <li key={d.id} className={`download-item state-${d.state}`}>
                <div className="download-main">
                  {d.state === 'completed' ? (
                    <button
                      className="link download-name"
                      title={`Open ${d.filename}`}
                      onClick={() => void api.invoke('downloads:open', { id: d.id })}
                    >
                      {d.filename}
                    </button>
                  ) : (
                    <span className="download-name" title={d.url}>
                      {d.filename}
                    </span>
                  )}
                  <span className="hint">
                    {statusText(d)} · {formatTime(d.startedAt)} · {hostOf(d.url)}
                  </span>
                  {active && (
                    <div
                      className="progress"
                      role="progressbar"
                      aria-label={`Downloading ${d.filename}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct ?? undefined}
                    >
                      <span
                        className={pct === null ? 'indeterminate' : ''}
                        style={pct === null ? undefined : { width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="download-actions">
                  {d.state === 'progressing' && (
                    <button
                      className="icon-btn"
                      aria-label={`Pause ${d.filename}`}
                      title="Pause"
                      onClick={() => void api.invoke('downloads:pause', { id: d.id })}
                    >
                      <IconPause />
                    </button>
                  )}
                  {d.state === 'paused' && (
                    <button
                      className="icon-btn"
                      aria-label={`Resume ${d.filename}`}
                      title="Resume"
                      onClick={() => void api.invoke('downloads:resume', { id: d.id })}
                    >
                      <IconPlay />
                    </button>
                  )}
                  {active && (
                    <button
                      className="icon-btn"
                      aria-label={`Cancel ${d.filename}`}
                      title="Cancel"
                      onClick={() => void api.invoke('downloads:cancel', { id: d.id })}
                    >
                      <IconClose />
                    </button>
                  )}
                  {d.state === 'completed' && (
                    <button
                      className="icon-btn"
                      aria-label={`Show ${d.filename} in folder`}
                      title="Show in folder"
                      onClick={() => void api.invoke('downloads:show', { id: d.id })}
                    >
                      <IconFolder />
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {showClear && finished && (
        <button className="btn" onClick={() => void api.invoke('downloads:clear')}>
          Clear finished
        </button>
      )}
    </div>
  )
}
