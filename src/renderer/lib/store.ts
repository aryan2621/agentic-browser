import { useCallback, useRef, useState } from 'react'
import type { ChatMessage, LlmErrorInfo, StreamEvent, SummaryMode, TabId } from '@shared/types'
import { api, useIpcEvent } from './api'

export interface SummaryState {
  streamId: string | null
  status: 'idle' | 'running' | 'done' | 'error'
  text: string
  progress: string | null
  cached: boolean
  error: LlmErrorInfo | null
  tokensPerSecond: number | null
  /** The summary hit its length limit. */
  truncated: boolean
  title: string | null
  url: string | null
  mode: SummaryMode
  selection: boolean
  /** The selected text this summary was made from, so Regenerate summarizes the same text. */
  selectionText: string | null
}

export interface ChatState {
  messages: ChatMessage[]
  streamId: string | null
  streamText: string
  progress: string | null
  error: LlmErrorInfo | null
}

const emptySummary = (mode: SummaryMode = 'summary'): SummaryState => ({
  streamId: null,
  status: 'idle',
  text: '',
  progress: null,
  cached: false,
  error: null,
  tokensPerSecond: null,
  truncated: false,
  title: null,
  url: null,
  mode,
  selection: false,
  selectionText: null
})

const emptyChat = (): ChatState => ({
  messages: [],
  streamId: null,
  streamText: '',
  progress: null,
  error: null
})

type StreamOwner = { kind: 'summary' | 'chat'; tabId: TabId }

/** Assistant state lives at the app level so streams survive panel/tab switches. */
export function useAssistantStore() {
  const [summaries, setSummaries] = useState<Record<TabId, SummaryState>>({})
  const [chats, setChats] = useState<Record<TabId, ChatState>>({})
  const owners = useRef(new Map<string, StreamOwner>())
  // Events can arrive before invoke() returns the stream id; buffer and replay them.
  const orphans = useRef(new Map<string, StreamEvent[]>())

  const patchSummary = useCallback((tabId: TabId, patch: Partial<SummaryState>) => {
    setSummaries((s) => ({ ...s, [tabId]: { ...(s[tabId] ?? emptySummary()), ...patch } }))
  }, [])
  /** Apply a patch only if `streamId` is still the tab's current summary (not a replaced one). */
  const patchSummaryStream = useCallback(
    (tabId: TabId, streamId: string, patch: Partial<SummaryState>) => {
      setSummaries((s) => {
        const cur = s[tabId]
        if (!cur || cur.streamId !== streamId) return s
        return { ...s, [tabId]: { ...cur, ...patch } }
      })
    },
    []
  )
  const patchChat = useCallback((tabId: TabId, fn: (c: ChatState) => Partial<ChatState>) => {
    setChats((s) => {
      const cur = s[tabId] ?? emptyChat()
      return { ...s, [tabId]: { ...cur, ...fn(cur) } }
    })
  }, [])

  const handleStream = (e: StreamEvent): void => {
    const owner = owners.current.get(e.streamId)
    if (!owner) {
      const list = orphans.current.get(e.streamId) ?? []
      if (list.length < 2000) list.push(e)
      orphans.current.set(e.streamId, list)
      if (orphans.current.size > 50) orphans.current.delete(orphans.current.keys().next().value!)
      return
    }
    if (owner.kind === 'summary') {
      switch (e.kind) {
        case 'start':
          patchSummaryStream(owner.tabId, e.streamId, {
            cached: e.cached,
            title: e.title ?? null,
            url: e.url ?? null,
            progress: e.cached ? null : 'Generating…'
          })
          break
        case 'progress':
          patchSummaryStream(owner.tabId, e.streamId, { progress: e.message })
          break
        case 'token':
          setSummaries((s) => {
            const cur = s[owner.tabId] ?? emptySummary()
            if (cur.streamId !== e.streamId) return s
            return { ...s, [owner.tabId]: { ...cur, text: cur.text + e.text, progress: null } }
          })
          break
        case 'done':
          patchSummaryStream(owner.tabId, e.streamId, {
            status: 'done',
            text: e.text,
            progress: null,
            cached: e.cached,
            tokensPerSecond: e.tokensPerSecond,
            truncated: Boolean(e.truncated)
          })
          owners.current.delete(e.streamId)
          break
        case 'error':
          patchSummaryStream(owner.tabId, e.streamId, {
            status: e.error.code === 'ABORTED' ? 'done' : 'error',
            error: e.error.code === 'ABORTED' ? null : e.error,
            progress: null
          })
          owners.current.delete(e.streamId)
          break
      }
    } else {
      switch (e.kind) {
        case 'start':
          patchChat(owner.tabId, () => ({ progress: null }))
          break
        case 'progress':
          patchChat(owner.tabId, () => ({ progress: e.message }))
          break
        case 'token':
          patchChat(owner.tabId, (c) =>
            c.streamId === e.streamId ? { streamText: c.streamText + e.text, progress: null } : {}
          )
          break
        case 'done':
          patchChat(owner.tabId, (c) => ({
            messages: [
              ...c.messages,
              {
                role: 'assistant',
                content: e.truncated ? `${e.text}\n\n_(answer cut short)_` : e.text
              }
            ],
            streamId: null,
            streamText: '',
            progress: null
          }))
          owners.current.delete(e.streamId)
          break
        case 'error':
          patchChat(owner.tabId, (c) => {
            // Partial answer is kept visible when the user pressed Stop.
            const keep = e.error.code === 'ABORTED' && c.streamText.trim()
            return {
              messages: keep
                ? [
                    ...c.messages,
                    { role: 'assistant', content: `${c.streamText.trim()}\n\n_(stopped)_` }
                  ]
                : c.messages,
              streamId: null,
              streamText: '',
              progress: null,
              error: e.error.code === 'ABORTED' ? null : e.error
            }
          })
          owners.current.delete(e.streamId)
          break
      }
    }
  }
  const handleStreamRef = useRef(handleStream)
  handleStreamRef.current = handleStream
  useIpcEvent('stream', (e) => handleStreamRef.current(e))

  const register = useCallback((streamId: string, owner: StreamOwner) => {
    owners.current.set(streamId, owner)
    const buffered = orphans.current.get(streamId)
    orphans.current.delete(streamId)
    for (const e of buffered ?? []) handleStreamRef.current(e)
  }, [])

  // ---------------------------------------------------------------- actions

  const startSummary = useCallback(
    async (
      tabId: TabId,
      mode: SummaryMode,
      opts: { focus?: string; regenerate?: boolean; selectionText?: string } = {}
    ) => {
      const selection = Boolean(opts.selectionText)
      setSummaries((s) => ({
        ...s,
        [tabId]: {
          ...emptySummary(mode),
          status: 'running',
          progress: 'Reading page…',
          selection,
          selectionText: opts.selectionText ?? null
        }
      }))
      try {
        const { streamId } = await api.invoke('summary:start', {
          tabId,
          mode,
          ...(opts.focus ? { focus: opts.focus } : {}),
          ...(opts.regenerate ? { regenerate: true } : {}),
          ...(selection ? { selectionOnly: true, selectionText: opts.selectionText } : {})
        })
        patchSummary(tabId, { streamId })
        register(streamId, { kind: 'summary', tabId })
      } catch (err) {
        patchSummary(tabId, {
          status: 'error',
          progress: null,
          error: {
            code: 'GENERATION_FAILED',
            message: err instanceof Error ? err.message : String(err),
            actions: ['retry']
          }
        })
      }
    },
    [patchSummary, register]
  )

  const loadChat = useCallback(
    async (tabId: TabId) => {
      const messages = await api.invoke('chat:history', { tabId })
      patchChat(tabId, (c) => (c.streamId ? {} : { messages }))
    },
    [patchChat]
  )

  const sendChat = useCallback(
    async (tabId: TabId, message: string, includeSelection: boolean, tabIds?: TabId[]) => {
      patchChat(tabId, (c) => ({
        messages: [...c.messages, { role: 'user', content: message }],
        streamText: '',
        error: null,
        progress: tabIds ? 'Reading tabs…' : 'Reading page…'
      }))
      try {
        const { streamId } = await api.invoke('chat:send', {
          tabId,
          message,
          includeSelection,
          ...(tabIds ? { tabIds } : {})
        })
        patchChat(tabId, () => ({ streamId }))
        register(streamId, { kind: 'chat', tabId })
      } catch (err) {
        patchChat(tabId, () => ({
          progress: null,
          error: {
            code: 'GENERATION_FAILED',
            message: err instanceof Error ? err.message : String(err),
            actions: ['retry']
          }
        }))
      }
    },
    [patchChat, register]
  )

  const clearChat = useCallback(
    async (tabId: TabId) => {
      await api.invoke('chat:clear', { tabId })
      patchChat(tabId, () => emptyChat())
    },
    [patchChat]
  )

  return {
    summaries,
    chats,
    startSummary,
    loadChat,
    sendChat,
    clearChat,
    emptySummary,
    emptyChat
  }
}

export type AssistantStore = ReturnType<typeof useAssistantStore>
