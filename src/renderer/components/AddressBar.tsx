import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DownloadInfo, HistoryEntry, LlmStatus, TabInfo } from '@shared/types'
import { displayUrl, looksLikeAddress } from '@shared/url'
import { api } from '../lib/api'
import { gpuLabel, mod } from '../lib/format'
import {
  IconBack,
  IconDownload,
  IconForward,
  IconLock,
  IconReload,
  IconHistory,
  IconMore,
  IconSettings,
  IconStar,
  IconSidebar,
  IconSparkle,
  IconStop
} from './Icons'

interface Props {
  tab: TabInfo | null
  /** ⌘R / Reload in an AI tab: run its search again. */
  onReloadAi: () => void
  focusSignal: number
  panelOpen: boolean
  onTogglePanel: () => void
  onOpenSettings: () => void
  status: LlmStatus | null
  /** Address suggestions are open over the page area (the page view must hide). */
  onCover: (covered: boolean) => void
  downloads: DownloadInfo[] | null
  onOpenDownloads: () => void
  /** Open the History & Downloads tab. */
  onOpenLibrary: () => void
  /** The page is bookmarked (star filled); null hides the star (not a web page). */
  bookmarked: boolean | null
  onToggleBookmark: () => void
}

/** Address without the scheme, as typed: "example.com/path". */
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '')
}

/**
 * Inline completion like Chrome: typing "git" with "github.com" in history completes to
 * "github.com" (the completed part is selected, so typing on replaces it).
 */
function inlineCompletion(typed: string, suggestion: HistoryEntry | undefined): string | null {
  if (!suggestion || !typed || /\s/.test(typed)) return null
  const t = typed.toLowerCase()
  const full = bareUrl(suggestion.url)
  for (const cand of [full, full.replace(/^www\./i, '')]) {
    if (!cand.toLowerCase().startsWith(t) || cand.length <= t.length) continue
    const hostEnd = cand.indexOf('/')
    // Complete to the host first; once the host is typed, complete the whole address.
    const target = hostEnd > 0 && t.length < hostEnd ? cand.slice(0, hostEnd) : cand
    if (target.length > t.length) return typed + target.slice(t.length)
  }
  return null
}

/** Total progress of running downloads (0–1), or null when none has a known size. */
function downloadProgress(list: DownloadInfo[]): number | null {
  const running = list.filter((d) => d.state === 'progressing' && d.totalBytes > 0)
  if (running.length === 0) return null
  const total = running.reduce((n, d) => n + d.totalBytes, 0)
  return running.reduce((n, d) => n + d.receivedBytes, 0) / total
}

/** What the address bar shows for a tab: an AI tab's question, otherwise the address. */
function shownValue(tab: TabInfo | null): string {
  return tab ? (tab.ai ?? displayUrl(tab.url)) : ''
}

export function AddressBar({
  tab,
  onReloadAi,
  focusSignal,
  panelOpen,
  onTogglePanel,
  onOpenSettings,
  status,
  onCover,
  downloads,
  onOpenDownloads,
  onOpenLibrary,
  bookmarked,
  onToggleBookmark
}: Props) {
  // Incognito windows show a badge (asked once: a window never changes kind).
  const [incognito, setIncognito] = useState(false)
  useEffect(() => {
    void api.invoke('ui:window-info').then((i) => setIncognito(i.incognito))
  }, [])
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([])
  const [selected, setSelected] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  // Text the user typed (without the inline completion) and the completion to select.
  const typedRef = useRef('')
  const selectFrom = useRef<number | null>(null)
  const suggestSeq = useRef(0)

  useEffect(() => {
    if (!editing) setValue(shownValue(tab))
  }, [tab, editing])

  // Switching tabs drops an unfinished edit, so Enter can't load it into the other tab.
  const tabId = tab?.id ?? null
  useEffect(() => {
    setEditing(false)
    setSuggestions([])
  }, [tabId])

  const open = editing && suggestions.length > 0
  useEffect(() => {
    onCover(open)
  }, [open, onCover])

  useLayoutEffect(() => {
    if (selectFrom.current === null || !inputRef.current) return
    inputRef.current.setSelectionRange(selectFrom.current, value.length)
    selectFrom.current = null
  }, [value])

  const closeSuggestions = (): void => {
    suggestSeq.current++
    setSuggestions([])
    setSelected(-1)
  }

  const onType = (next: string, deleting: boolean): void => {
    typedRef.current = next
    setValue(next)
    setSelected(-1)
    const seq = ++suggestSeq.current
    if (!next.trim()) {
      setSuggestions([])
      return
    }
    void api.invoke('history:suggest', { query: next.trim() }).then((list) => {
      if (seq !== suggestSeq.current) return
      setSuggestions(list)
      const completed = deleting ? null : inlineCompletion(typedRef.current, list[0])
      if (completed && inputRef.current?.value === typedRef.current) {
        selectFrom.current = typedRef.current.length
        setValue(completed)
      }
    })
  }

  const go = (input: string): void => {
    if (!tab || !input.trim()) return
    closeSuggestions()
    setEditing(false)
    inputRef.current?.blur()
    // In an AI tab a new question replaces the answer; an address opens as a web page.
    if (tab.ai !== null && !looksLikeAddress(input))
      void api.invoke('tabs:ask-ai', { tabId: tab.id, query: input })
    else void api.invoke('tabs:navigate', { tabId: tab.id, input })
  }

  useEffect(() => {
    if (focusSignal === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const pick = selected >= 0 ? suggestions[selected] : undefined
    go(pick ? pick.url : value)
  }

  const secure = tab?.url.startsWith('https://')
  const insecure = tab?.url.startsWith('http://')
  const progress = downloads ? downloadProgress(downloads) : null

  const statusPill = status && (
    <span
      className={`status-pill state-${status.state}`}
      title={
        status.activeModel ? `${status.activeModel} on ${gpuLabel(status.gpu)}` : 'Local model'
      }
    >
      <span className="dot" aria-hidden="true" />
      {status.provider === 'mock'
        ? 'Mock model'
        : status.state === 'loading'
          ? 'Loading…'
          : status.activeModel
            ? gpuLabel(status.gpu)
            : 'Local AI'}
    </span>
  )

  return (
    <div className="toolbar">
      <div className="nav-buttons">
        <button
          className="icon-btn"
          aria-label={`Back (${mod}[)`}
          title={`Back (${mod}[)`}
          disabled={!tab?.canGoBack}
          onClick={() => tab && void api.invoke('tabs:back', { tabId: tab.id })}
        >
          <IconBack />
        </button>
        <button
          className="icon-btn"
          aria-label={`Forward (${mod}])`}
          title={`Forward (${mod}])`}
          disabled={!tab?.canGoForward}
          onClick={() => tab && void api.invoke('tabs:forward', { tabId: tab.id })}
        >
          <IconForward />
        </button>
        {tab?.loading ? (
          <button
            className="icon-btn"
            aria-label="Stop loading"
            title="Stop"
            onClick={() => void api.invoke('tabs:stop', { tabId: tab.id })}
          >
            <IconStop />
          </button>
        ) : (
          <button
            className="icon-btn"
            aria-label={`Reload (${mod}R)`}
            title={`Reload (${mod}R)`}
            disabled={!tab}
            onClick={() => {
              if (tab?.ai) onReloadAi()
              else if (tab) void api.invoke('tabs:reload', { tabId: tab.id })
            }}
          >
            <IconReload />
          </button>
        )}
      </div>
      <form className="address" onSubmit={submit} role="search">
        {tab?.ai && !editing && (
          <span className="address-lock" title="AI result">
            <IconSparkle />
          </span>
        )}
        {secure && !editing && (
          <span className="address-lock" title="Secure connection">
            <IconLock />
          </span>
        )}
        {insecure && !editing && (
          <span className="address-insecure" title="The connection to this site is not encrypted">
            Not secure
          </span>
        )}
        <input
          ref={inputRef}
          aria-label="Address and search bar"
          placeholder={
            tab?.ai ? 'Ask another question or enter address' : 'Search or enter address'
          }
          value={value}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="address-suggestions"
          aria-autocomplete="both"
          aria-activedescendant={selected >= 0 ? `suggestion-${selected}` : undefined}
          onFocus={(e) => {
            setEditing(true)
            e.target.select()
          }}
          onBlur={() => {
            setEditing(false)
            closeSuggestions()
          }}
          onChange={(e) =>
            onType(
              e.target.value,
              (e.nativeEvent as InputEvent).inputType?.startsWith('delete') ?? false
            )
          }
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && open) {
              e.preventDefault()
              setSelected((i) => Math.min(i + 1, suggestions.length - 1))
            } else if (e.key === 'ArrowUp' && open) {
              e.preventDefault()
              setSelected((i) => Math.max(i - 1, -1))
            } else if (e.key === 'Escape') {
              if (open) {
                closeSuggestions()
                setValue(typedRef.current)
                return
              }
              setEditing(false)
              setValue(shownValue(tab))
              void api.invoke('ui:focus-page')
            }
          }}
        />
        {tab && tab.zoom !== 100 && !editing && (
          <button
            type="button"
            className="zoom-pill"
            title={`Zoom ${tab.zoom}%. Click to reset (${mod}0)`}
            aria-label={`Zoom ${tab.zoom} percent, reset`}
            onClick={() => void api.invoke('tabs:zoom', { tabId: tab.id, step: 0 })}
          >
            {tab.zoom}%
          </button>
        )}
        {bookmarked !== null && (
          <button
            type="button"
            className={`icon-btn address-star ${bookmarked ? 'on' : ''}`}
            aria-pressed={bookmarked}
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
            title={`${bookmarked ? 'Remove bookmark' : 'Bookmark this page'} (${mod}D)`}
            onClick={onToggleBookmark}
          >
            <IconStar filled={bookmarked} />
          </button>
        )}
        {tab?.loading && <span className="address-progress" aria-hidden="true" />}
        {open && (
          <ul className="address-suggestions" id="address-suggestions" role="listbox">
            {suggestions.map((sug, i) => (
              <li
                key={sug.id}
                id={`suggestion-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'active' : ''}
                // Keep focus in the input so the click isn't lost to a blur.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(sug.url)}
              >
                <span className="suggestion-title">{sug.title || bareUrl(sug.url)}</span>
                <span className="suggestion-url">{bareUrl(sug.url)}</span>
              </li>
            ))}
          </ul>
        )}
      </form>
      {downloads && downloads.length > 0 && (
        <button
          className="icon-btn downloads-button"
          aria-label="Downloads"
          title={`Downloads (${api.platform === 'darwin' ? '⌥⌘L' : 'Ctrl+J'})`}
          onClick={onOpenDownloads}
        >
          <IconDownload />
          {progress !== null && (
            <span
              className="ring"
              aria-hidden="true"
              style={{
                background: `conic-gradient(var(--accent) ${Math.round(progress * 360)}deg, transparent 0)`,
                mask: 'radial-gradient(circle, transparent 58%, #000 60%)'
              }}
            />
          )}
        </button>
      )}
      {incognito && (
        <span
          className="incognito-badge"
          title="Incognito: no history, cookies cleared when the window closes"
        >
          Incognito
        </span>
      )}
      {statusPill}
      <button
        className={`icon-btn ${panelOpen ? 'pressed' : ''}`}
        aria-pressed={panelOpen}
        aria-label={`Toggle AI panel (${mod}⇧A)`}
        title={`AI panel (${mod}⇧A)`}
        onClick={onTogglePanel}
      >
        <IconSidebar />
      </button>
      <button
        className="icon-btn"
        aria-label="History and downloads"
        title={`History & downloads (${api.platform === 'darwin' ? '⌘Y' : 'Ctrl+H'})`}
        onClick={onOpenLibrary}
      >
        <IconHistory />
      </button>
      <button className="icon-btn" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
        <IconSettings />
      </button>
      <button
        className="icon-btn"
        aria-label="Menu"
        title="Menu: windows, incognito, bookmarks, history, passwords…"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          void api.invoke('ui:app-menu', { x: r.right - 220, y: r.bottom + 4 })
        }}
      >
        <IconMore />
      </button>
    </div>
  )
}
