import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_CHAT_TABS } from '@shared/defaults'
import type { TabId, TabInfo } from '@shared/types'
import { api, openInNewTab } from '../lib/api'
import { LinkHandlerContext, Markdown } from '../lib/markdown'
import type { AssistantStore } from '../lib/store'
import { Dropdown } from './Dropdown'
import { ErrorBox } from './ErrorBox'
import { MicButton } from './MicButton'
import { IconSend } from './Icons'

type Scope = 'this' | 'all' | 'pick'

const SCOPES: Array<{ value: Scope; label: string; description: string }> = [
  { value: 'this', label: 'This tab', description: 'Answer from the page you are viewing.' },
  {
    value: 'all',
    label: 'All open tabs',
    description: `Answer from every open web page (up to ${MAX_CHAT_TABS}).`
  },
  { value: 'pick', label: 'Pick tabs', description: 'Choose which open pages to answer from.' }
]

const encodeParens = (url: string): string => url.replace(/\(/g, '%28').replace(/\)/g, '%29')

/** Text put in the chat box (e.g. "Ask AI about selection"); `tabIds` also picks those tabs. */
export interface ChatDraft {
  text: string
  n: number
  tabIds?: TabId[]
}

/** The question "Compare with AI" (tab menu) asks. */
export const COMPARE_PROMPT =
  'Compare these tabs. Start with a short verdict, then a Markdown table comparing them on the points the tabs cover (write "—" where a tab says nothing), then the main differences as bullets.'

const isWebTab = (t: TabInfo): boolean => t.ai === null && /^https?:/.test(t.url)

interface Props {
  activeTab: TabInfo | null
  tabs: TabInfo[]
  store: AssistantStore
  draft: ChatDraft | null
  onOpenSettings: (section: string) => void
}

export function ChatView({ activeTab, tabs, store, draft, onOpenSettings }: Props) {
  const [input, setInput] = useState('')
  const [includeSelection, setIncludeSelection] = useState(false)
  const [scope, setScope] = useState<Scope>('this')
  const [picked, setPicked] = useState<Set<TabId>>(new Set())
  // The active tab first, then the others in tab-strip order.
  const webTabs = tabs.filter(isWebTab).sort((a, b) => Number(b.active) - Number(a.active))
  const pickedOpen = webTabs.filter((t) => picked.has(t.id))
  const chosen =
    scope === 'all' ? webTabs.slice(0, MAX_CHAT_TABS) : scope === 'pick' ? pickedOpen : []
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const tabId = activeTab?.id ?? null
  const chat = tabId !== null ? (store.chats[tabId] ?? store.emptyChat()) : store.emptyChat()
  const busy = chat.streamId !== null || chat.progress !== null
  const isWeb = activeTab !== null && /^https?:/.test(activeTab.url)
  const { loadChat } = store

  useEffect(() => {
    if (tabId !== null) void loadChat(tabId)
  }, [tabId, activeTab?.url, loadChat])

  useEffect(() => {
    if (!draft) return
    if (draft.tabIds) {
      setScope('pick')
      setPicked(new Set(draft.tabIds))
      return
    }
    setInput(draft.text)
    setIncludeSelection(true)
    inputRef.current?.focus()
  }, [draft])

  // A citation to an open tab switches to it; anything else opens in a new tab.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const openLink = useCallback((href: string) => {
    const tab = tabsRef.current.find((t) => t.url === href || encodeParens(t.url) === href)
    if (tab) void api.invoke('tabs:activate', { tabId: tab.id })
    else openInNewTab(href)
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [chat.messages.length, chat.streamText])

  if (!activeTab || !isWeb) {
    return (
      <div className="empty">
        <p>Open a web page to chat about it.</p>
      </div>
    )
  }

  const send = (): void => {
    const text = input.trim()
    if (!text || busy || (scope !== 'this' && chosen.length === 0)) return
    setInput('')
    void store.sendChat(
      activeTab.id,
      text,
      scope === 'this' && includeSelection,
      scope === 'this' ? undefined : chosen.map((t) => t.id)
    )
  }

  const togglePick = (id: TabId): void =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_CHAT_TABS) next.add(id)
      return next
    })

  const placeholder =
    scope === 'this'
      ? 'Ask about this page…'
      : chosen.length === 0
        ? 'Pick at least one tab…'
        : `Ask about ${chosen.length} ${chosen.length === 1 ? 'tab' : 'tabs'}…`

  return (
    <LinkHandlerContext.Provider value={openLink}>
      <div className="chat-view">
        <div className="chat-scope">
          <span className="hint">Use</span>
          <Dropdown ariaLabel="Answer from" value={scope} options={SCOPES} onChange={setScope} />
          {scope === 'all' && webTabs.length > MAX_CHAT_TABS && (
            <span className="hint">
              First {MAX_CHAT_TABS} of {webTabs.length}
            </span>
          )}
        </div>
        {scope === 'pick' && (
          <ul className="tab-picks" aria-label="Tabs to answer from">
            {webTabs.map((t) => (
              <li key={t.id}>
                <label className="checkbox" title={t.url}>
                  <input
                    type="checkbox"
                    checked={picked.has(t.id)}
                    disabled={!picked.has(t.id) && picked.size >= MAX_CHAT_TABS}
                    onChange={() => togglePick(t.id)}
                  />
                  <span className="tab-pick-title">{t.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="chat-list" ref={listRef} aria-live="polite">
          {chat.messages.length === 0 && !busy && (
            <div className="empty small">
              {scope === 'this' ? (
                <>
                  <p>Ask anything about “{activeTab.title}”.</p>
                  <p className="hint">
                    Answers use only this page and quote it. If the page doesn't say, the assistant
                    will tell you.
                  </p>
                </>
              ) : (
                <>
                  <p>Ask across your open tabs.</p>
                  <p className="hint">
                    Answers use only the chosen tabs and cite them as [1], [2]… Click a citation to
                    switch to that tab. If the tabs don't say, the assistant will tell you.
                  </p>
                </>
              )}
            </div>
          )}
          {chat.messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : <p>{m.content}</p>}
            </div>
          ))}
          {busy && (
            <div className="msg assistant">
              {chat.streamText ? (
                <>
                  <Markdown text={chat.streamText} />
                  <span className="cursor" aria-hidden="true" />
                </>
              ) : (
                <div className="progress-line">
                  <span className="typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {chat.progress ?? 'Thinking…'}
                </div>
              )}
            </div>
          )}
          {chat.error && <ErrorBox error={chat.error} onOpenSettings={onOpenSettings} />}
        </div>
        <div className="chat-input">
          <textarea
            ref={inputRef}
            aria-label={placeholder.replace('…', '')}
            placeholder={placeholder}
            value={input}
            rows={2}
            maxLength={4000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="row gap space-between">
            {scope === 'this' ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeSelection}
                  onChange={(e) => setIncludeSelection(e.target.checked)}
                />
                Include selected text
              </label>
            ) : (
              <span />
            )}
            <div className="row gap">
              <MicButton
                onText={(t) => {
                  setInput((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t))
                  inputRef.current?.focus()
                }}
              />
              {chat.messages.length > 0 && !busy && (
                <button className="btn subtle" onClick={() => void store.clearChat(activeTab.id)}>
                  Clear
                </button>
              )}
              {busy ? (
                <button
                  className="btn danger"
                  onClick={() =>
                    chat.streamId && void api.invoke('stream:cancel', { streamId: chat.streamId })
                  }
                >
                  Stop
                </button>
              ) : (
                <button
                  className="btn primary"
                  aria-label="Send"
                  onClick={send}
                  disabled={!input.trim() || (scope !== 'this' && chosen.length === 0)}
                >
                  <IconSend />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </LinkHandlerContext.Provider>
  )
}
