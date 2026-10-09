import { useEffect, useRef, useState } from 'react'
import type { HistoryEntry, TabId } from '@shared/types'
import { looksLikeAddress } from '@shared/url'
import { api } from '../lib/api'
import { mod } from '../lib/format'
import { IconCheck, IconGlobe, IconSearch, IconSparkle } from './Icons'
import { MicButton } from './MicButton'

type Continue = 'browser' | 'ai'

/** A row under the search box: a visited page (opens it) or a search suggestion (runs it). */
type Suggestion = { kind: 'history'; title: string; url: string } | { kind: 'search'; text: string }

const EXAMPLES = [
  'What is a lion?',
  'How do heat pumps work?',
  'Best time to visit Japan',
  'Explain inflation simply'
]

function readChoice(): Continue {
  try {
    return localStorage.getItem('newTabContinue') === 'ai' ? 'ai' : 'browser'
  } catch {
    return 'browser'
  }
}

/**
 * The New Tab page. The search box continues in this same tab, either as a normal web page
 * (Browser) or as an AI result (AI). Addresses always open as web pages.
 */
export function NewTabPage({ tabId, aiSignal }: { tabId: TabId; aiSignal: number }) {
  const [q, setQ] = useState('')
  const [choice, setChoice] = useState<Continue>(readChoice)
  const [recent, setRecent] = useState<HistoryEntry[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(-1)
  const [focused, setFocused] = useState(false)
  const suggestSeq = useRef(0)
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(suggestTimer.current ?? undefined), [])

  /** History matches first (instant, local), then DuckDuckGo's suggestions below them. */
  const suggest = (text: string): void => {
    const seq = ++suggestSeq.current
    setSelected(-1)
    clearTimeout(suggestTimer.current ?? undefined)
    const t = text.trim()
    if (!t) {
      setSuggestions([])
      return
    }
    void api.invoke('history:suggest', { query: t }).then((list) => {
      if (seq !== suggestSeq.current) return
      const history: Suggestion[] = list
        .slice(0, 4)
        .map((h) => ({ kind: 'history', title: h.title || safeHost(h.url), url: h.url }))
      setSuggestions(history)
      // A short pause so every keystroke doesn't become a request.
      suggestTimer.current = setTimeout(() => {
        void api.invoke('search:suggest', { query: t }).then((found) => {
          if (seq !== suggestSeq.current) return
          const seen = new Set([t.toLowerCase()])
          const searches: Suggestion[] = found
            .filter((f) => !seen.has(f.toLowerCase()) && seen.add(f.toLowerCase()))
            .map((f) => ({ kind: 'search', text: f }))
          setSuggestions([...history, ...searches])
        })
      }, 150)
    })
  }

  const closeSuggestions = (): void => {
    suggestSeq.current++
    clearTimeout(suggestTimer.current ?? undefined)
    setSuggestions([])
    setSelected(-1)
  }

  useEffect(() => {
    void api.invoke('history:list', { limit: 40 }).then((list) => {
      const seen = new Set<string>()
      setRecent(
        list
          .filter((h) => {
            const host = safeHost(h.url)
            if (!host || seen.has(host)) return false
            seen.add(host)
            return true
          })
          .slice(0, 8)
      )
    })
  }, [tabId])

  // ⌘K: AI preselected and the box focused.
  useEffect(() => {
    if (aiSignal === 0) return
    setChoice('ai')
    inputRef.current?.focus()
  }, [aiSignal])

  const pick = (next: Continue): void => {
    setChoice(next)
    try {
      localStorage.setItem('newTabContinue', next)
    } catch {
      /* storage unavailable */
    }
    inputRef.current?.focus()
  }

  const go = (input: string): void => {
    const text = input.trim()
    if (!text) return
    closeSuggestions()
    if (choice === 'ai' && !looksLikeAddress(text))
      void api.invoke('tabs:ask-ai', { tabId, query: text })
    else void api.invoke('tabs:navigate', { tabId, input: text })
  }

  const ai = choice === 'ai'
  const open = focused && suggestions.length > 0

  const choose = (sug: Suggestion): void => {
    if (sug.kind === 'history') {
      closeSuggestions()
      void api.invoke('tabs:navigate', { tabId, input: sug.url })
    } else {
      setQ(sug.text)
      go(sug.text)
    }
  }

  return (
    <div className="newtab">
      <h1 className="newtab-title">
        <span className="brand-spark">
          <IconSparkle size={30} />
        </span>{' '}
        Where to next?
      </h1>
      <form
        className="newtab-search with-mic"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          const pick = selected >= 0 ? suggestions[selected] : undefined
          if (pick) choose(pick)
          else go(q)
        }}
      >
        <input
          ref={inputRef}
          aria-label={ai ? 'Ask AI' : 'Search or enter address'}
          placeholder={ai ? 'Ask anything, then press Enter' : 'Search the web or type a URL'}
          value={q}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="newtab-suggestions"
          aria-autocomplete="list"
          aria-activedescendant={selected >= 0 ? `newtab-suggestion-${selected}` : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setQ(e.target.value)
            suggest(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && open) {
              e.preventDefault()
              setSelected((i) => Math.min(i + 1, suggestions.length - 1))
            } else if (e.key === 'ArrowUp' && open) {
              e.preventDefault()
              setSelected((i) => Math.max(i - 1, -1))
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              closeSuggestions()
            }
          }}
        />
        {open && (
          <ul className="address-suggestions" id="newtab-suggestions" role="listbox">
            {suggestions.map((sug, i) => (
              <li
                key={sug.kind === 'history' ? `h:${sug.url}` : `s:${sug.text}`}
                id={`newtab-suggestion-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'active' : ''}
                // Keep focus in the input so the click isn't lost to a blur.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(sug)}
              >
                <span className="suggestion-icon" aria-hidden="true">
                  {sug.kind === 'history' ? <IconGlobe /> : ai ? <IconSparkle /> : <IconSearch />}
                </span>
                {sug.kind === 'history' ? (
                  <>
                    <span className="suggestion-title">{sug.title}</span>
                    <span className="suggestion-url">{safeHost(sug.url)}</span>
                  </>
                ) : (
                  <span className="suggestion-title">{sug.text}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <MicButton
          className="newtab-mic"
          onText={(t) => {
            setQ((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t))
            inputRef.current?.focus()
          }}
        />
      </form>
      <div className="mode-chips newtab-continue" role="radiogroup" aria-label="Continue in">
        {(['browser', 'ai'] as const).map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={choice === c}
            className={`mode-chip ${choice === c ? 'on' : ''}`}
            title={
              c === 'ai'
                ? `Your local AI reads the top results and answers in this tab (${mod}K)`
                : 'Open the search or site in this tab, with the AI side panel'
            }
            onClick={() => pick(c)}
          >
            {choice === c ? <IconCheck /> : c === 'ai' ? <IconSparkle /> : <IconGlobe />}
            {c === 'ai' ? 'AI' : 'Browser'}
          </button>
        ))}
      </div>
      {ai ? (
        <div className="search-examples" aria-label="Examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip-btn" onClick={() => go(ex)}>
              {ex}
            </button>
          ))}
        </div>
      ) : (
        <>
          {recent === null && (
            <ul className="newtab-recent" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <li key={i}>
                  <span className="skeleton-line" style={{ width: '80%' }} />
                  <span className="skeleton-line small" style={{ width: '50%' }} />
                </li>
              ))}
            </ul>
          )}
          {recent && recent.length > 0 && (
            <ul className="newtab-recent" aria-label="Recently visited">
              {recent.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => void api.invoke('tabs:navigate', { tabId, input: h.url })}
                    title={h.url}
                  >
                    <span className="newtab-recent-title">{h.title || safeHost(h.url)}</span>
                    <span className="newtab-recent-host">{safeHost(h.url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="newtab-private">
        {ai
          ? 'Your local model reads the top results and writes an answer with sources. Sources open in new tabs.'
          : 'Your AI runs locally. Pages you summarize never leave this computer.'}
      </p>
    </div>
  )
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
