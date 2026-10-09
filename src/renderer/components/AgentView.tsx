import { useRef, useState } from 'react'
import type { TabInfo } from '@shared/types'
import type { AgentStore } from '../lib/agent'
import { Markdown } from '../lib/markdown'
import { IconSparkle } from './Icons'
import { MicButton } from './MicButton'

interface Props {
  activeTab: TabInfo | null
  agent: AgentStore
}

const EXAMPLES = [
  'Open wikipedia.org, search for "Electron (software)" and tell me who develops it',
  'Find the contact page on this site and tell me the email address',
  'Fill this form with: name Jane Doe, email jane@example.com'
]

/**
 * The local agent: it works in the current tab one visible step at a time. It never submits
 * forms and stops on sign-in or payment pages.
 */
export function AgentView({ activeTab, agent }: Props) {
  const [goal, setGoal] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { run } = agent
  const canRun = activeTab !== null && goal.trim() !== '' && !run.running

  const start = (): void => {
    if (!canRun || !activeTab) return
    void agent.start(activeTab.id, goal.trim())
  }

  return (
    <div className="agent-view">
      <div className="chat-input">
        <textarea
          ref={inputRef}
          aria-label="Task for the agent"
          placeholder="What should the agent do in this tab?"
          value={goal}
          rows={3}
          maxLength={1000}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              start()
            }
          }}
        />
        <div className="row gap space-between">
          <span className="hint">Never submits forms. Stops on sign-in and payment pages.</span>
          <div className="row gap">
            <MicButton
              onText={(t) => {
                setGoal((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t))
                inputRef.current?.focus()
              }}
            />
            {run.running ? (
              <button className="btn danger" onClick={agent.stop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" onClick={start} disabled={!canRun}>
                <IconSparkle /> Run
              </button>
            )}
          </div>
        </div>
      </div>

      {!run.running && run.log.length > 0 && (
        <div className="row gap agent-actions">
          {run.log[run.log.length - 1]?.kind !== 'done' && (
            <button
              className="btn"
              disabled={!activeTab}
              title="Continue the same task from where it stopped"
              onClick={() => activeTab && agent.resume(activeTab.id)}
            >
              Resume
            </button>
          )}
          <button
            className="btn subtle"
            title="Delete this task and its steps"
            onClick={() => {
              agent.clear()
              setGoal('')
            }}
          >
            {run.log[run.log.length - 1]?.kind === 'done' ? 'Clear' : 'Delete'}
          </button>
        </div>
      )}

      {run.log.length === 0 && !run.running ? (
        <div className="empty small">
          <p>Give the agent a simple task in this tab.</p>
          <ul className="agent-examples">
            {EXAMPLES.map((x) => (
              <li key={x}>
                <button className="link" onClick={() => setGoal(x)}>
                  {x}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol className="agent-log" aria-live="polite" aria-label="Agent steps">
          {run.log.map((e, i) => (
            <li key={i} className={`agent-line ${e.kind}`}>
              {e.kind === 'done' ? <Markdown text={e.text} /> : e.text}
            </li>
          ))}
          {run.running && <li className="agent-line status">Working…</li>}
        </ol>
      )}
    </div>
  )
}
