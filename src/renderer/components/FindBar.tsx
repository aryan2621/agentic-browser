import { useEffect, useRef, useState } from 'react'
import type { TabId } from '@shared/types'
import { api, useIpcEvent } from '../lib/api'
import { IconChevronDown, IconChevronUp, IconClose } from './Icons'

interface Props {
  tabId: TabId
  /** Increments when ⌘F is pressed again: refocus and select the text. */
  focusSignal: number
  /** ⌘G / ⇧⌘G from the menu: { n, forward } (n changes on each press). */
  step: { n: number; forward: boolean } | null
  onClose: () => void
}

/** Find in page: a strip above the page (never covered by it). */
export function FindBar({ tabId, focusSignal, step, onClose }: Props) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ matches: number; active: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useIpcEvent('find:result', (r) => {
    if (r.tabId === tabId) setResult({ matches: r.matches, active: r.active })
  })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  const find = (value: string, forward: boolean, findNext: boolean): void => {
    if (!value) setResult(null)
    void api.invoke('find:start', { tabId, text: value, forward, findNext })
  }

  const next = (forward: boolean): void => {
    if (text) find(text, forward, true)
  }

  const stepRef = useRef(step?.n)
  useEffect(() => {
    if (!step || step.n === stepRef.current) return
    stepRef.current = step.n
    next(step.forward)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const close = (): void => {
    void api.invoke('find:stop', { tabId, keepSelection: false })
    onClose()
    void api.invoke('ui:focus-page')
  }

  return (
    <div className="find-bar" role="search" aria-label="Find in page">
      <input
        ref={inputRef}
        aria-label="Find in page"
        placeholder="Find in page"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          find(e.target.value, true, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            next(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      <span className="find-count" role="status" aria-live="polite">
        {text && result
          ? result.matches
            ? `${result.active} of ${result.matches}`
            : 'No matches'
          : ''}
      </span>
      <button
        className="icon-btn"
        aria-label="Previous match"
        title="Previous (⇧Enter)"
        disabled={!result?.matches}
        onClick={() => next(false)}
      >
        <IconChevronUp />
      </button>
      <button
        className="icon-btn"
        aria-label="Next match"
        title="Next (Enter)"
        disabled={!result?.matches}
        onClick={() => next(true)}
      >
        <IconChevronDown />
      </button>
      <button className="icon-btn" aria-label="Close find bar" title="Close (Esc)" onClick={close}>
        <IconClose />
      </button>
    </div>
  )
}
