import { useCallback, useState } from 'react'
import type { AgentEvent, TabId } from '@shared/types'
import { api, useIpcEvent } from './api'

export interface AgentRun {
  runId: string | null
  goal: string
  log: AgentEvent[]
  running: boolean
}

const idle: AgentRun = { runId: null, goal: '', log: [], running: false }

/** The agent's run lives at the app level so its log survives switching panel sections. */
export function useAgent() {
  const [run, setRun] = useState<AgentRun>(idle)

  useIpcEvent('agent', (e) => {
    setRun((r) => {
      if (r.runId !== e.runId) return r
      const ended = e.kind === 'done' || e.kind === 'stopped' || e.kind === 'error'
      return { ...r, log: [...r.log, e], running: !ended }
    })
  })

  /** Start a run; `resume` keeps the log and continues from its steps. */
  const launch = useCallback(async (tabId: TabId, goal: string, keep: AgentEvent[]) => {
    setRun({ runId: null, goal, log: keep, running: true })
    try {
      const prior = keep.filter((e) => e.kind === 'step').map((e) => e.text)
      const { runId } = await api.invoke('agent:start', {
        tabId,
        goal,
        ...(prior.length ? { prior } : {})
      })
      setRun((r) => ({ ...r, runId }))
    } catch (err) {
      setRun({
        runId: null,
        goal,
        running: false,
        log: [
          ...keep,
          { runId: '', kind: 'error', text: err instanceof Error ? err.message : String(err) }
        ]
      })
    }
  }, [])

  const start = useCallback((tabId: TabId, goal: string) => launch(tabId, goal, []), [launch])

  const resume = useCallback(
    (tabId: TabId) => {
      if (run.running || !run.goal) return
      void launch(tabId, run.goal, run.log)
    },
    [launch, run]
  )

  const stop = useCallback(() => {
    setRun((r) => {
      if (r.runId) void api.invoke('agent:stop', { runId: r.runId })
      return r
    })
  }, [])

  /** Forget the run: its goal and its whole log. */
  const clear = useCallback(() => setRun(idle), [])

  return { run, start, resume, stop, clear }
}

export type AgentStore = ReturnType<typeof useAgent>
