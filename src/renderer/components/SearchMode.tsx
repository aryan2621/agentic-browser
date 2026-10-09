import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmErrorInfo, StreamEvent, TabId, WebResult } from '@shared/types'
import { SEARCH_ANSWER_MODES, searchAnswerMode, type SearchAnswerModeId } from '@shared/searchModes'
import { SEARCH_VERTICALS } from '@shared/verticals'
import { api, useIpcEvent } from '../lib/api'
import { LinkHandlerContext, Markdown } from '../lib/markdown'
import { ErrorBox } from './ErrorBox'
import { IconCheck, IconCopy, IconExternal, IconReload } from './Icons'
import { AnswerSkeleton } from './Skeleton'

type ResultTab = 'summary' | 'results'

interface SearchImage {
  image: string
  pageUrl: string
  title: string
}

interface AnswerState {
  streamId: string | null
  status: 'idle' | 'running' | 'done' | 'error'
  text: string
  progress: string | null
  error: LlmErrorInfo | null
  tokensPerSecond: number | null
  truncated: boolean
}

const emptyAnswer: AnswerState = {
  streamId: null,
  status: 'idle',
  text: '',
  progress: null,
  error: null,
  tokensPerSecond: null,
  truncated: false
}

interface Props {
  /** The AI tab this result belongs to. */
  tabId: TabId
  /** The tab is on screen (it stays mounted while hidden so its result survives). */
  active: boolean
  /** Default result style from Settings → Search; preselects the style chip. */
  defaultMode: SearchAnswerModeId
  /** Sources to read from Settings → Search; null = each style's own number. */
  sourceCount: number | null
  /** The tab's question. A new one (or a new `reloadSignal`) runs the search again. */
  query: string
  reloadSignal: number
  onOpenUrl: (url: string) => void
  onOpenSettings: (section: string) => void
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Turn [1] / [2][3] / [1, 2] citations into links whose label is the number; the Markdown
 * renderer shows number-only links as small citation chips. A number with no matching source
 * stays plain text and is counted, so the UI can flag it.
 */
function linkCitations(text: string, sources: WebResult[]): { text: string; invalid: number } {
  let invalid = 0
  const link = (n: string): string => {
    const r = sources[Number(n) - 1]
    // Encode parentheses so URLs like Wikipedia's "Foo_(bar)" don't end the Markdown link early.
    if (r) return `[${n}](${r.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`
    invalid++
    return `[${n}]`
  }
  const linked = text.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g, (_m, list: string) =>
    list
      .split(',')
      .map((n) => link(n.trim()))
      .join('')
  )
  return { text: linked, invalid }
}

/** Apply one stream event to an answer. */
function nextAnswer(a: AnswerState, e: StreamEvent): AnswerState {
  switch (e.kind) {
    case 'start':
      return a
    case 'progress':
      return { ...a, progress: e.message || null }
    case 'token':
      return { ...a, text: a.text + e.text, progress: null }
    case 'done':
      return {
        ...a,
        status: 'done',
        text: e.text,
        progress: null,
        tokensPerSecond: e.tokensPerSecond,
        truncated: Boolean(e.truncated)
      }
    case 'error':
      return {
        ...a,
        status: e.error.code === 'ABORTED' ? 'done' : 'error',
        error: e.error.code === 'ABORTED' ? null : e.error,
        progress: null
      }
  }
}

interface FollowUp {
  question: string
  answer: AnswerState
}

const NOT_IN_SOURCES = /^\s*the sources don.t say/i

/** Single-select row of result styles. */
function StyleChips({
  value,
  onChange
}: {
  value: SearchAnswerModeId
  onChange: (mode: SearchAnswerModeId) => void
}) {
  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const n = SEARCH_ANSWER_MODES.length
    const next = SEARCH_ANSWER_MODES[(index + step + n) % n]
    if (next) onChange(next.id)
    const group = e.currentTarget.parentElement
    ;(group?.children[(index + step + n) % n] as HTMLElement | undefined)?.focus()
  }
  return (
    <div className="mode-chips" role="radiogroup" aria-label="Result style">
      {SEARCH_ANSWER_MODES.map((m, i) => (
        <button
          key={m.id}
          role="radio"
          aria-checked={value === m.id}
          tabIndex={value === m.id ? 0 : -1}
          className={`mode-chip ${value === m.id ? 'on' : ''}`}
          title={m.description}
          onClick={() => onChange(m.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {value === m.id && <IconCheck />}
          {m.label}
        </button>
      ))}
    </div>
  )
}

function SourcesSkeleton() {
  return (
    <ol className="source-links" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="skeleton-link">
          <span className="skeleton-line" style={{ width: '85%' }} />
          <span className="skeleton-line small" style={{ width: '40%' }} />
        </li>
      ))}
    </ol>
  )
}

export function SearchMode({
  tabId,
  active,
  defaultMode,
  sourceCount,
  query: tabQuery,
  reloadSignal,
  onOpenUrl,
  onOpenSettings
}: Props) {
  const [query, setQuery] = useState<string | null>(null)
  const [tab, setTab] = useState<ResultTab>('summary')
  const [results, setResults] = useState<WebResult[]>([])
  const [resultsStatus, setResultsStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [resultsError, setResultsError] = useState<string | null>(null)
  // One style is shown at a time; results already generated for this search are kept per style.
  const [activeMode, setActiveMode] = useState<SearchAnswerModeId>(defaultMode)
  const activeModeRef = useRef(activeMode)
  activeModeRef.current = activeMode
  const [answers, setAnswers] = useState<Partial<Record<SearchAnswerModeId, AnswerState>>>({})
  const [images, setImages] = useState<SearchImage[]>([])
  const [imagesStatus, setImagesStatus] = useState<'idle' | 'loading' | 'done'>('idle')
  const [copied, setCopied] = useState<SearchAnswerModeId | null>(null)
  const streamModes = useRef(new Map<string, SearchAnswerModeId>())
  // Follow-up questions about the same sources, newest last; cleared by a new search.
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [followInput, setFollowInput] = useState('')
  const followStreams = useRef(new Map<string, number>())
  const pending = useRef(0)
  const orphans = useRef<StreamEvent[]>([])
  const searchSeq = useRef(0)

  // A new default style picked in Settings preselects that chip.
  useEffect(() => {
    setActiveMode(defaultMode)
  }, [defaultMode])

  // A new "Sources to read" setting makes earlier answers stale. The shown answer regenerates
  // now; a hidden tab waits until it is shown, so tabs in the background don't all generate.
  const sourcesChangedRef = useRef<() => void>(() => undefined)
  const sourcesStale = useRef(false)
  const firstSourceCount = useRef(true)
  useEffect(() => {
    if (firstSourceCount.current) {
      firstSourceCount.current = false
      return
    }
    sourcesStale.current = true
    if (active) sourcesChangedRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new count triggers this
  }, [sourceCount])
  useEffect(() => {
    if (active && sourcesStale.current) sourcesChangedRef.current()
  }, [active])

  // Run the tab's question: on first show, when it changes, and on reload (⌘R).
  const runRef = useRef<(q: string) => Promise<void>>(async () => undefined)
  useEffect(() => {
    void runRef.current(tabQuery)
  }, [tabQuery, reloadSignal])

  // Closing the tab stops its answers.
  const stopRef = useRef<() => void>(() => undefined)
  useEffect(() => () => stopRef.current(), [])

  // ---- answer streams (one per style)
  const apply = useCallback((e: StreamEvent) => {
    const mode = streamModes.current.get(e.streamId)
    if (!mode) return
    setAnswers((all) => {
      const a = all[mode]
      if (!a || a.streamId !== e.streamId) return all
      const next = nextAnswer(a, e)
      return next === a ? all : { ...all, [mode]: next }
    })
  }, [])

  const applyFollowUp = useCallback((e: StreamEvent) => {
    const index = followStreams.current.get(e.streamId)
    if (index === undefined) return
    setFollowUps((list) =>
      list.map((f, i) =>
        i === index && f.answer.streamId === e.streamId
          ? { ...f, answer: nextAnswer(f.answer, e) }
          : f
      )
    )
  }, [])

  useIpcEvent('stream', (e) => {
    if (streamModes.current.has(e.streamId)) apply(e)
    else if (followStreams.current.has(e.streamId)) applyFollowUp(e)
    else if (pending.current > 0 && orphans.current.length < 4000) orphans.current.push(e)
  })

  const startAnswer = async (
    mode: SearchAnswerModeId,
    q: string,
    list: WebResult[]
  ): Promise<void> => {
    pending.current++
    setAnswers((all) => ({
      ...all,
      [mode]: { ...emptyAnswer, status: 'running', progress: 'Reading sources…' }
    }))
    try {
      const { streamId } = await api.invoke('search:answer', {
        query: q,
        results: list,
        mode,
        ...(sourceCount ? { sources: sourceCount } : {})
      })
      streamModes.current.set(streamId, mode)
      setAnswers((all) => ({ ...all, [mode]: { ...(all[mode] ?? emptyAnswer), streamId } }))
      const replay = orphans.current.filter((e) => e.streamId === streamId)
      orphans.current = orphans.current.filter((e) => e.streamId !== streamId)
      replay.forEach(apply)
    } catch (err) {
      setAnswers((all) => ({
        ...all,
        [mode]: {
          ...emptyAnswer,
          status: 'error',
          error: {
            code: 'GENERATION_FAILED',
            message: err instanceof Error ? err.message : String(err),
            actions: ['retry']
          }
        }
      }))
    } finally {
      pending.current--
      if (pending.current === 0) orphans.current = []
    }
  }

  const stopAll = (): void => {
    for (const a of Object.values(answers)) {
      if (a?.streamId && a.status === 'running')
        void api.invoke('stream:cancel', { streamId: a.streamId })
    }
    streamModes.current.clear()
    for (const f of followUps) {
      if (f.answer.streamId && f.answer.status === 'running')
        void api.invoke('stream:cancel', { streamId: f.answer.streamId })
    }
    followStreams.current.clear()
    setFollowUps([])
  }

  const loadImages = async (list: WebResult[], seq: number): Promise<void> => {
    setImagesStatus('loading')
    try {
      const found = await api.invoke('search:images', { results: list })
      if (seq === searchSeq.current) setImages(found)
    } catch {
      if (seq === searchSeq.current) setImages([])
    } finally {
      if (seq === searchSeq.current) setImagesStatus('done')
    }
  }

  /**
   * Show another style. A result already generated for this search is shown instantly;
   * otherwise it is generated. An unfinished result of the style being left is cancelled
   * and dropped (it would otherwise look complete), so it regenerates if picked again.
   */
  const selectMode = (mode: SearchAnswerModeId): void => {
    if (mode === activeMode) return
    const leaving = answers[activeMode]
    if (leaving?.status === 'running') {
      if (leaving.streamId) {
        streamModes.current.delete(leaving.streamId)
        void api.invoke('stream:cancel', { streamId: leaving.streamId })
      }
      setAnswers(({ [activeMode]: _dropped, ...rest }) => rest)
    }
    setActiveMode(mode)
    if (query !== null && resultsStatus === 'done' && !answers[mode])
      void startAnswer(mode, query, results)
  }

  /** Ask about the same sources; the earlier questions and answers go along as context. */
  const askFollowUp = async (): Promise<void> => {
    const question = followInput.trim()
    const main = answers[activeMode]
    if (!question || query === null || main?.status !== 'done' || !main.text) return
    if (followUps.some((f) => f.answer.status === 'running')) return
    setFollowInput('')
    const thread = [
      { question: query, answer: main.text },
      ...followUps
        .filter((f) => f.answer.status === 'done' && f.answer.text)
        .map((f) => ({ question: f.question, answer: f.answer.text }))
    ]
    const index = followUps.length
    setFollowUps((list) => [
      ...list,
      { question, answer: { ...emptyAnswer, status: 'running', progress: 'Reading sources…' } }
    ])
    const patch = (fn: (a: AnswerState) => AnswerState): void =>
      setFollowUps((list) => list.map((f, i) => (i === index ? { ...f, answer: fn(f.answer) } : f)))
    pending.current++
    try {
      const { streamId } = await api.invoke('search:answer', {
        query,
        results,
        mode: activeMode,
        ...(sourceCount ? { sources: sourceCount } : {}),
        followUp: { thread, question }
      })
      followStreams.current.set(streamId, index)
      patch((a) => ({ ...a, streamId }))
      const replay = orphans.current.filter((e) => e.streamId === streamId)
      orphans.current = orphans.current.filter((e) => e.streamId !== streamId)
      replay.forEach(applyFollowUp)
    } catch (err) {
      patch(() => ({
        ...emptyAnswer,
        status: 'error',
        error: {
          code: 'GENERATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          actions: ['retry']
        }
      }))
    } finally {
      pending.current--
      if (pending.current === 0) orphans.current = []
    }
  }

  const runSearch = async (raw: string): Promise<void> => {
    const q = raw.trim()
    if (!q) return
    const seq = ++searchSeq.current
    stopAll()
    setQuery(q)
    setResults([])
    setResultsError(null)
    setResultsStatus('loading')
    setImages([])
    setImagesStatus('loading')
    setAnswers({})
    try {
      const list = await api.invoke('search:results', { tabId, query: q })
      if (seq !== searchSeq.current) return
      setResults(list)
      setResultsStatus('done')
      void loadImages(list, seq)
      void startAnswer(activeModeRef.current, q, list)
    } catch (err) {
      if (seq !== searchSeq.current) return
      const message =
        err instanceof Error ? err.message.replace(/^Error invoking[^:]*:\s*/, '') : String(err)
      setResultsError(message)
      setResultsStatus('error')
      setAnswers({})
      setImagesStatus('done')
    }
  }

  /** Images / Videos / News / Maps open the engine's own page for the question in a new tab. */
  const openVertical = (id: string): void => {
    const v = SEARCH_VERTICALS.find((x) => x.id === id)
    if (v && query !== null) onOpenUrl(v.url(query))
  }

  const copy = async (mode: SearchAnswerModeId): Promise<void> => {
    const text = answers[mode]?.text
    if (!text) return
    const sources = results
      .slice(0, sourceCount ?? searchAnswerMode(mode).sources)
      .map((r, i) => `[${i + 1}] ${r.title} - ${r.url}`)
      .join('\n')
    await api.invoke('clipboard:write', { text: `${text}\n\nSources:\n${sources}` })
    setCopied(mode)
    setTimeout(() => setCopied(null), 1500)
  }

  const tabs: Array<{ id: ResultTab; label: string }> = [
    { id: 'summary', label: 'AI result' },
    { id: 'results', label: 'Results' }
  ]

  runRef.current = runSearch
  stopRef.current = stopAll
  sourcesChangedRef.current = () => {
    sourcesStale.current = false
    stopAll()
    setAnswers({})
    if (query !== null && resultsStatus === 'done') void startAnswer(activeMode, query, results)
  }

  if (query === null) return <div className="search-mode" hidden={!active} />

  // Sources: the ones the active style reads (or the count set in Settings).
  const cited = results.slice(0, sourceCount ?? searchAnswerMode(activeMode).sources)
  const answer = answers[activeMode]
  const activeDef = searchAnswerMode(activeMode)
  const linked = answer?.text ? linkCitations(answer.text, cited) : null

  return (
    <LinkHandlerContext.Provider value={onOpenUrl}>
      <div className="search-mode" hidden={!active}>
        <header className="search-header">
          <div className="search-tabs" role="tablist" aria-label="Result types">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`search-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="search-links" aria-label="Open in a new tab">
            {SEARCH_VERTICALS.map((v) => (
              <button
                key={v.id}
                className="search-tab"
                title={`Open ${v.label} for this search in a new tab`}
                onClick={() => openVertical(v.id)}
              >
                {v.label} <IconExternal />
              </button>
            ))}
          </div>
        </header>

        {tab === 'summary' && (
          <div className="search-body" role="tabpanel" aria-label="AI result">
            <article className="search-answer">
              <h2 className="search-query">{query}</h2>
              <StyleChips value={activeMode} onChange={selectMode} />
              <div className="answer-actions">
                {answer && answer.status !== 'running' && (
                  <button
                    className="icon-btn"
                    aria-label={`Regenerate ${activeDef.label}`}
                    title="Regenerate"
                    onClick={() => void startAnswer(activeMode, query, results)}
                  >
                    <IconReload />
                  </button>
                )}
                {answer?.status === 'done' && answer.tokensPerSecond !== null && (
                  <span className="hint">{answer.tokensPerSecond.toFixed(1)} tokens/sec</span>
                )}
                {answer?.status === 'done' && answer.text && (
                  <button
                    className="icon-btn"
                    aria-label={`Copy ${activeDef.label}`}
                    title="Copy"
                    onClick={() => void copy(activeMode)}
                  >
                    <IconCopy />
                  </button>
                )}
                {copied === activeMode && <span className="hint">Copied</span>}
              </div>
              {resultsStatus === 'error' && <div className="error-box">{resultsError}</div>}
              <section
                className="ai-result"
                aria-live="polite"
                aria-busy={!answer || answer.status === 'running'}
                aria-label={activeDef.label}
              >
                {(!answer || (answer.status === 'running' && !answer.text)) && (
                  <>
                    <span className="sr-only" role="status">
                      {answer?.progress ??
                        (resultsStatus === 'loading'
                          ? 'Searching the web…'
                          : 'Preparing the result…')}
                    </span>
                    <AnswerSkeleton />
                  </>
                )}
                {linked && <Markdown text={linked.text} />}
                {linked && linked.invalid > 0 && answer?.status === 'done' && (
                  <p className="hint citation-warning">Some citations didn't match a source.</p>
                )}
                {answer?.status === 'done' && answer.truncated && (
                  <p className="hint citation-warning">
                    The answer hit its length limit and may be cut short.
                  </p>
                )}
                {answer?.error && (
                  <ErrorBox
                    error={answer.error}
                    onRetry={() => void startAnswer(activeMode, query, results)}
                    onOpenSettings={onOpenSettings}
                  />
                )}
              </section>
              {followUps.map((f, i) => {
                const fl = f.answer.text ? linkCitations(f.answer.text, cited) : null
                return (
                  <section key={i} className="follow-up" aria-live="polite">
                    <h3 className="follow-question">{f.question}</h3>
                    {f.answer.status === 'running' && !f.answer.text && <AnswerSkeleton />}
                    {fl && <Markdown text={fl.text} />}
                    {f.answer.status === 'done' && NOT_IN_SOURCES.test(f.answer.text) && (
                      <button
                        className="btn subtle"
                        onClick={() => void api.invoke('tabs:ask-ai', { tabId, query: f.question })}
                      >
                        Search the web for this
                      </button>
                    )}
                    {f.answer.error && (
                      <ErrorBox error={f.answer.error} onOpenSettings={onOpenSettings} />
                    )}
                  </section>
                )
              })}
              {answer?.status === 'done' && answer.text && (
                <form
                  className="follow-up-box"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void askFollowUp()
                  }}
                >
                  <input
                    className="text-input grow"
                    aria-label="Ask a follow-up"
                    placeholder="Ask a follow-up about these sources…"
                    value={followInput}
                    maxLength={1000}
                    onChange={(e) => setFollowInput(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={
                      !followInput.trim() || followUps.some((f) => f.answer.status === 'running')
                    }
                  >
                    Ask
                  </button>
                </form>
              )}
            </article>
            <aside className="search-sources" aria-label="Sources and images">
              <h3>Sources</h3>
              {resultsStatus === 'loading' ? (
                <SourcesSkeleton />
              ) : (
                <ol className="source-links">
                  {cited.map((r) => (
                    <li key={r.url}>
                      <a
                        href={r.url}
                        title={r.url}
                        onClick={(e) => {
                          e.preventDefault()
                          onOpenUrl(r.url)
                        }}
                      >
                        {r.title}
                      </a>
                      <span className="source-host">{hostOf(r.url)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {(imagesStatus === 'loading' || images.length > 0) && (
                <section className="search-images" aria-label="Images">
                  <h3>Images</h3>
                  <div className="image-grid">
                    {imagesStatus === 'loading'
                      ? [0, 1, 2, 3].map((i) => (
                          <span key={i} className="image-thumb skeleton-line" />
                        ))
                      : images.slice(0, 6).map((img) => (
                          <button
                            key={img.image}
                            className="image-thumb"
                            title={img.title}
                            onClick={() => onOpenUrl(img.pageUrl)}
                          >
                            <img
                              src={img.image}
                              alt={img.title}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setImages((list) => list.filter((x) => x.image !== img.image))
                              }
                            />
                          </button>
                        ))}
                  </div>
                  <button className="link" onClick={() => openVertical('images')}>
                    More images →
                  </button>
                </section>
              )}
            </aside>
          </div>
        )}

        {tab === 'results' && (
          <div className="search-body single" role="tabpanel" aria-label="Results">
            {resultsStatus === 'loading' && <AnswerSkeleton />}
            {resultsStatus === 'error' && <div className="error-box">{resultsError}</div>}
            <ol className="result-list">
              {results.map((r) => (
                <li key={r.url} className="result-item">
                  <span className="result-host">{hostOf(r.url)}</span>
                  <a
                    className="result-title"
                    href={r.url}
                    onClick={(e) => {
                      e.preventDefault()
                      onOpenUrl(r.url)
                    }}
                  >
                    {r.title}
                  </a>
                  {r.snippet && <p className="result-snippet">{r.snippet}</p>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </LinkHandlerContext.Provider>
  )
}
