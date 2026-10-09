import { useEffect, useState } from 'react'
import type {
  Bookmark,
  DownloadInfo,
  HistoryEntry,
  LibraryPage as Page,
  TabId
} from '@shared/types'
import type { LlmErrorInfo } from '@shared/types'
import { api, openInNewTab, useIpcEvent, useSettings } from '../lib/api'
import { Markdown } from '../lib/markdown'
import { ErrorBox } from './ErrorBox'
import { DownloadsView } from './DownloadsView'
import { IconTrash } from './Icons'

const HISTORY_PAGE = 50
const DOWNLOADS_PAGE = 20

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** "Today", "Yesterday", or a full date, for the day headings. */
function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

function groupByDay<T>(items: T[], ts: (item: T) => number): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = []
  for (const item of items) {
    const day = dayLabel(ts(item))
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(item)
    else groups.push({ day, items: [item] })
  }
  return groups
}

function Pager({
  page,
  hasNext,
  onPage
}: {
  page: number
  hasNext: boolean
  onPage: (page: number) => void
}) {
  if (page === 0 && !hasNext) return null
  return (
    <nav className="pager" aria-label="Pages">
      <button className="btn subtle" disabled={page === 0} onClick={() => onPage(page - 1)}>
        ← Newer
      </button>
      <span className="hint">Page {page + 1}</span>
      <button className="btn subtle" disabled={!hasNext} onClick={() => onPage(page + 1)}>
        Older →
      </button>
    </nav>
  )
}

/** "Ask about your history": answers from the opt-in local index of visited pages. */
function HistoryAsk() {
  const [settings, updateSettings] = useSettings()
  const [question, setQuestion] = useState('')
  const [pages, setPages] = useState<number | null>(null)
  const [answer, setAnswer] = useState<{
    streamId: string | null
    text: string
    running: boolean
    progress: string | null
    error: LlmErrorInfo | null
  } | null>(null)
  const on = settings?.historyIndex ?? false

  useEffect(() => {
    if (on) void api.invoke('history:index-info').then((i) => setPages(i.pages))
  }, [on, answer?.running])

  useIpcEvent('stream', (e) => {
    setAnswer((a) => {
      if (!a || a.streamId !== e.streamId) return a
      switch (e.kind) {
        case 'progress':
          return { ...a, progress: e.message || null }
        case 'token':
          return { ...a, text: a.text + e.text, progress: null }
        case 'done':
          return { ...a, text: e.text, running: false, progress: null }
        case 'error':
          return {
            ...a,
            running: false,
            progress: null,
            error: e.error.code === 'ABORTED' ? null : e.error
          }
        default:
          return a
      }
    })
  })

  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (!q || answer?.running) return
    setAnswer({ streamId: null, text: '', running: true, progress: 'Searching…', error: null })
    const { streamId } = await api.invoke('history:ask', { question: q })
    setAnswer((a) => (a ? { ...a, streamId } : a))
  }

  if (!settings) return null
  if (!on) {
    return (
      <div className="history-ask off">
        <div>
          <strong>Ask AI about your history</strong>
          <p className="hint">
            Keeps the text of pages you visit on this computer so the local model can answer
            questions like “that article about solar panels last week”. Nothing leaves your
            computer. Only pages visited after you switch it on are included.
          </p>
        </div>
        <button className="btn" onClick={() => void updateSettings({ historyIndex: true })}>
          Turn on
        </button>
      </div>
    )
  }
  return (
    <div className="history-ask">
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input
          className="text-input grow"
          aria-label="Ask about your history"
          placeholder="Ask about pages you visited…"
          value={question}
          maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          className="btn primary"
          type="submit"
          disabled={!question.trim() || answer?.running}
        >
          Ask
        </button>
      </form>
      {answer && (
        <div className="history-answer" aria-live="polite">
          {answer.running && !answer.text && (
            <p className="hint">{answer.progress ?? 'Thinking…'}</p>
          )}
          {answer.text && <Markdown text={answer.text} />}
          {answer.error && <ErrorBox error={answer.error} onOpenSettings={() => undefined} />}
        </div>
      )}
      <p className="hint">
        {pages ?? 0} pages indexed on this computer ·{' '}
        <button
          className="link"
          onClick={() => void api.invoke('history:index-clear').then(() => setPages(0))}
        >
          Clear AI history index
        </button>{' '}
        ·{' '}
        <button className="link" onClick={() => void updateSettings({ historyIndex: false })}>
          Turn off
        </button>
      </p>
    </div>
  )
}

function HistorySection() {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<HistoryEntry[] | null>(null)
  const [hasNext, setHasNext] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [reload, setReload] = useState(0)

  useEffect(() => setPage(0), [query])

  useEffect(() => {
    let stale = false
    const t = setTimeout(() => {
      void api
        .invoke('history:list', {
          query: query.trim() || undefined,
          // One extra row tells whether there is a next page.
          limit: HISTORY_PAGE + 1,
          offset: page * HISTORY_PAGE
        })
        .then((list) => {
          if (stale) return
          setRows(list.slice(0, HISTORY_PAGE))
          setHasNext(list.length > HISTORY_PAGE)
        })
    }, 150)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [query, page, reload])

  return (
    <section className="library-section" aria-label="History">
      <HistoryAsk />
      <div className="row gap">
        <input
          className="text-input grow"
          type="search"
          aria-label="Search history"
          placeholder="Search history"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {confirmClear ? (
          <>
            <button
              className="btn danger"
              onClick={() => {
                void api.invoke('history:clear').then(() => setReload((n) => n + 1))
                setConfirmClear(false)
              }}
            >
              Clear all history
            </button>
            <button className="btn subtle" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn subtle" onClick={() => setConfirmClear(true)}>
            Clear history
          </button>
        )}
      </div>
      {rows === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty small">
          <p>{query.trim() ? 'No pages match your search.' : 'No history yet.'}</p>
        </div>
      ) : (
        groupByDay(rows, (h) => h.visitedAt).map((g) => (
          <div key={g.day} className="library-day">
            <h3>{g.day}</h3>
            <ul className="library-list">
              {g.items.map((h) => (
                <li key={h.id} className="library-row history-row">
                  <span className="library-time">
                    {new Date(h.visitedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                  <button
                    className="library-link"
                    onClick={() => openInNewTab(h.url)}
                    title={h.url}
                  >
                    <span className="library-title">{h.title || h.url}</span>
                    <span className="library-host">{hostOf(h.url)}</span>
                  </button>
                  <button
                    className="icon-btn history-delete"
                    aria-label={`Remove ${h.title || h.url} from history`}
                    title="Remove from history"
                    onClick={() => {
                      void api
                        .invoke('history:delete', { id: h.id })
                        .then(() => setReload((n) => n + 1))
                    }}
                  >
                    <IconTrash />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      <Pager page={page} hasNext={hasNext} onPage={setPage} />
    </section>
  )
}

function DownloadsSection({ list }: { list: DownloadInfo[] | null }) {
  const [page, setPage] = useState(0)
  const sorted = list ? [...list].sort((a, b) => b.startedAt - a.startedAt) : null
  const pages = sorted ? Math.max(1, Math.ceil(sorted.length / DOWNLOADS_PAGE)) : 1
  const current = Math.min(page, pages - 1)
  const slice = sorted?.slice(current * DOWNLOADS_PAGE, (current + 1) * DOWNLOADS_PAGE) ?? null
  return (
    <section className="library-section" aria-label="Downloads">
      {slice && slice.length > 0 ? (
        groupByDay(slice, (d) => d.startedAt).map((g) => (
          <div key={g.day} className="library-day">
            <h3>{g.day}</h3>
            <DownloadsView list={g.items} showClear={false} />
          </div>
        ))
      ) : (
        <DownloadsView list={slice} showClear={false} />
      )}
      <div className="row gap space-between">
        <Pager page={current} hasNext={current < pages - 1} onPage={setPage} />
        {list?.some((d) => d.state !== 'progressing' && d.state !== 'paused') && (
          <button className="btn subtle" onClick={() => void api.invoke('downloads:clear')}>
            Clear finished
          </button>
        )}
      </div>
    </section>
  )
}

const BOOKMARKS_PAGE = 50

function BookmarksSection({ list }: { list: Bookmark[] | null }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null)
  useEffect(() => setPage(0), [query])
  const q = query.trim().toLowerCase()
  // Newest first.
  const matches = (list ?? [])
    .filter((b) => !q || b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q))
    .reverse()
  const pages = Math.max(1, Math.ceil(matches.length / BOOKMARKS_PAGE))
  const current = Math.min(page, pages - 1)
  const slice = matches.slice(current * BOOKMARKS_PAGE, (current + 1) * BOOKMARKS_PAGE)
  const saveTitle = (): void => {
    if (editing && editing.title.trim())
      void api.invoke('bookmarks:rename', { id: editing.id, title: editing.title.trim() })
    setEditing(null)
  }
  return (
    <section className="library-section" aria-label="Bookmarks">
      <input
        className="text-input"
        type="search"
        aria-label="Search bookmarks"
        placeholder="Search bookmarks"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {list === null ? (
        <p className="hint">Loading…</p>
      ) : slice.length === 0 ? (
        <div className="empty small">
          <p>
            {q
              ? 'No bookmarks match your search.'
              : 'No bookmarks yet. Click the star in the address bar (or press ⌘D) to add one.'}
          </p>
        </div>
      ) : (
        <ul className="library-list">
          {slice.map((b) => (
            <li key={b.id} className="library-row history-row">
              {editing?.id === b.id ? (
                <input
                  className="text-input grow"
                  aria-label="Bookmark name"
                  autoFocus
                  value={editing.title}
                  maxLength={300}
                  onChange={(e) => setEditing({ id: b.id, title: e.target.value })}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveTitle()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <button className="library-link" onClick={() => openInNewTab(b.url)} title={b.url}>
                  <span className="library-title">{b.title}</span>
                  <span className="library-host">{hostOf(b.url)}</span>
                </button>
              )}
              <button
                className="btn subtle small"
                onClick={() => setEditing({ id: b.id, title: b.title })}
              >
                Rename
              </button>
              <button
                className="icon-btn history-delete"
                aria-label={`Delete bookmark ${b.title}`}
                title="Delete bookmark"
                onClick={() => void api.invoke('bookmarks:delete', { id: b.id })}
              >
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pager page={current} hasNext={current < pages - 1} onPage={setPage} />
    </section>
  )
}

/** The History / Bookmarks / Downloads tab, opened from the toolbar icon. */
export function LibraryPage({
  tabId,
  page,
  downloads,
  bookmarks
}: {
  tabId: TabId
  page: Page
  downloads: DownloadInfo[] | null
  bookmarks: Bookmark[] | null
}) {
  const sections: Array<{ id: Page; label: string }> = [
    { id: 'history', label: 'History' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'downloads', label: 'Downloads' }
  ]
  return (
    <div className="library-page">
      <header className="search-header">
        <div className="search-tabs" role="tablist" aria-label="History and downloads">
          {sections.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={page === s.id}
              className={`search-tab ${page === s.id ? 'active' : ''}`}
              onClick={() => void api.invoke('tabs:open-page', { page: s.id, tabId })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </header>
      <div className="library-body">
        {page === 'history' && <HistorySection />}
        {page === 'bookmarks' && <BookmarksSection list={bookmarks} />}
        {page === 'downloads' && <DownloadsSection list={downloads} />}
      </div>
    </div>
  )
}
