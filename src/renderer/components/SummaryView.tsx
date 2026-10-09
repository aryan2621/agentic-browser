import { useState } from 'react'
import type { SummaryMode, TabInfo } from '@shared/types'
import { api } from '../lib/api'
import { Markdown } from '../lib/markdown'
import type { AssistantStore } from '../lib/store'
import { Dropdown, type DropdownOption } from './Dropdown'
import { ErrorBox } from './ErrorBox'
import { AnswerSkeleton } from './Skeleton'
import { IconCopy, IconDownload, IconReload, IconSparkle } from './Icons'

const MODES: Array<DropdownOption<SummaryMode>> = [
  {
    value: 'summary',
    label: 'Summary',
    description: 'Short TL;DR, key points, notable facts and why it matters.'
  },
  { value: 'detailed', label: 'Detailed', description: 'A thorough summary of every section.' }
]

interface Props {
  activeTab: TabInfo | null
  store: AssistantStore
  onOpenSettings: (section: string) => void
}

export function SummaryView({ activeTab, store, onOpenSettings }: Props) {
  const [mode, setMode] = useState<SummaryMode>('summary')
  const [focus, setFocus] = useState('')
  const [copied, setCopied] = useState(false)
  const isWeb = activeTab !== null && /^https?:/.test(activeTab.url)
  const state = activeTab ? store.summaries[activeTab.id] : undefined
  const running = state?.status === 'running'

  if (!activeTab || !isWeb) {
    return (
      <div className="empty">
        <IconSparkle />
        <p>Open a web page, then summarize it here.</p>
        <p className="hint">Tip: select text on a page and right-click → “Summarize selection”.</p>
      </div>
    )
  }

  const run = (regenerate = false): void => {
    void store.startSummary(activeTab.id, mode, {
      focus: focus.trim() || undefined,
      regenerate,
      // Regenerating a selection summary re-summarizes the same selection, not the whole page.
      ...(regenerate && state?.selectionText ? { selectionText: state.selectionText } : {})
    })
  }
  const copy = async (): Promise<void> => {
    if (!state?.text) return
    await api.invoke('clipboard:write', { text: state.text })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const exportMd = (): void => {
    if (!state?.text) return
    const title = state.title ?? activeTab.title
    const content = `# ${title}\n\n<${state.url ?? activeTab.url}>\n\n${state.text}\n`
    void api.invoke('file:export-markdown', { suggestedName: `${title} - summary`, content })
  }

  return (
    <div className="summary-view">
      <div className="summary-controls">
        <Dropdown
          ariaLabel="Summary style"
          value={mode}
          options={MODES}
          onChange={setMode}
          className="summary-style"
        />
        <button
          className="btn primary grow"
          data-testid="summarize"
          onClick={() => run()}
          disabled={running}
        >
          <IconSparkle /> {running ? 'Summarizing…' : 'Summarize page'}
        </button>
      </div>
      <input
        className="text-input"
        aria-label="Focus on (optional)"
        placeholder="Focus on… (optional, e.g. prices and dates)"
        value={focus}
        maxLength={1000}
        onChange={(e) => setFocus(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !running && run()}
      />

      {state && state.status !== 'idle' && (
        <section className="output" aria-live="polite" aria-busy={running}>
          <div className="output-header">
            <div className="output-meta">
              {state.selection && <span className="badge">Selection</span>}
              {state.cached && (
                <span className="badge" title="Loaded from the local cache">
                  cached
                </span>
              )}
              {state.title && <span className="output-title">{state.title}</span>}
            </div>
            {state.status === 'done' && state.text && (
              <div className="output-actions">
                {copied && (
                  <span className="hint" role="status">
                    Copied
                  </span>
                )}
                <button
                  className="icon-btn"
                  aria-label="Regenerate"
                  title="Regenerate (ignore the cache)"
                  onClick={() => run(true)}
                >
                  <IconReload />
                </button>
                <button
                  className="icon-btn"
                  aria-label="Copy summary"
                  title="Copy"
                  onClick={() => void copy()}
                >
                  <IconCopy />
                </button>
                <button
                  className="icon-btn"
                  aria-label="Export as Markdown"
                  title="Export Markdown"
                  onClick={exportMd}
                >
                  <IconDownload />
                </button>
              </div>
            )}
          </div>
          {running && !state.text && (
            <>
              {/* Long pages report "Reading part 3 of 12…": a quiet caption above the skeleton. */}
              <span className="skeleton-caption" role="status">
                {state.progress ?? 'Preparing the summary…'}
              </span>
              <AnswerSkeleton />
            </>
          )}
          {state.text && (
            <div data-testid="summary-output">
              <Markdown text={state.text} />
              {running && <span className="cursor" aria-hidden="true" />}
            </div>
          )}
          {state.status === 'done' && state.truncated && (
            <p className="hint citation-warning">
              The summary hit its length limit and may be cut short.
            </p>
          )}
          {state.status === 'done' && state.tokensPerSecond !== null && (
            <div className="hint">{state.tokensPerSecond.toFixed(1)} tokens/sec</div>
          )}
          {state.error && (
            <ErrorBox error={state.error} onRetry={() => run()} onOpenSettings={onOpenSettings} />
          )}
        </section>
      )}
    </div>
  )
}
