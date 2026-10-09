import { useState } from 'react'
import { useBackdropClose } from '../lib/backdrop'
import { mod } from '../lib/format'

const STEPS = [
  {
    title: '1. Browse as usual',
    body: `Type a URL or a search in the address bar (${mod}L). Tabs, back/forward and reload work like any browser.`
  },
  {
    title: '2. Summarize & chat',
    body: `Open the AI panel (${mod}⇧A) to summarize the page or ask questions about it. Select text and right-click to summarize just that part.`
  },
  {
    title: '3. Search with AI',
    body: `On a new tab, pick AI under the search box (or press ${mod}K) and ask anything. That tab becomes an AI result: your local model reads the top results and answers with sources. Sources open in new tabs.`
  }
]

export function Tour({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0)
  const step = STEPS[i]!
  const backdrop = useBackdropClose(onDone)
  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      {...backdrop}
    >
      <div className="tour">
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div className="row gap space-between">
          <span className="hint">
            {i + 1} / {STEPS.length}
          </span>
          <div className="row gap">
            <button className="btn subtle" onClick={onDone}>
              Skip
            </button>
            <button
              className="btn primary"
              autoFocus
              onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : onDone())}
            >
              {i < STEPS.length - 1 ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
