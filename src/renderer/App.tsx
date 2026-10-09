import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SIDE_PANEL_MAX, SIDE_PANEL_MIN } from '@shared/defaults'
import type {
  CompareTabsAction,
  LibraryPage as LibraryPageId,
  SelectionAction
} from '@shared/types'
import { useAgent } from './lib/agent'
import { COMPARE_PROMPT, type ChatDraft } from './components/ChatView'
import {
  api,
  useBookmarks,
  useDownloads,
  useInfoBars,
  useIpcEvent,
  useLlmStatus,
  useSettings,
  useTabs
} from './lib/api'
import { useAssistantStore } from './lib/store'
import { AddressBar } from './components/AddressBar'
import { SearchMode } from './components/SearchMode'
import { FindBar } from './components/FindBar'
import { InfoBars } from './components/InfoBar'
import { BookmarksBar } from './components/BookmarksBar'
import { LibraryPage } from './components/LibraryPage'
import { NewTabPage } from './components/NewTabPage'
import { OnboardingScreen } from './components/OnboardingScreen'
import { Settings } from './components/Settings'
import { SidePanel, type PanelTab } from './components/SidePanel'
import { TabStrip } from './components/TabStrip'
import { Tour } from './components/Tour'

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem('panelOpen') !== '0'
  } catch {
    return true
  }
}

export default function App() {
  const tabs = useTabs()
  const [settings, updateSettings] = useSettings()
  const status = useLlmStatus()
  const store = useAssistantStore()
  const agent = useAgent()
  const activeTab = tabs.find((t) => t.active) ?? null
  const aiActive = activeTab?.ai != null
  const libraryPage = activeTab?.page ?? null
  // An AI tab or the History / Downloads page covers the web page area.
  const covering = aiActive || libraryPage !== null
  const blank = !activeTab || (!covering && activeTab.url === 'about:blank' && !activeTab.loading)

  const [panelOpen, setPanelOpen] = useState(readPanelOpen)
  const [panelTab, setPanelTab] = useState<PanelTab>('summary')
  const [panelWidth, setPanelWidth] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<false | string>(false)
  const [addressFocus, setAddressFocus] = useState(0)
  const [peeking, setPeeking] = useState(false)
  const [chatDraft, setChatDraft] = useState<ChatDraft | null>(null)
  // ⌘K: the New Tab page of this tab preselects AI.
  const [aiIntent, setAiIntent] = useState<{ tabId: number; n: number } | null>(null)
  // ⌘R in an AI tab re-runs that tab's search.
  const [aiReload, setAiReload] = useState<Record<number, number>>({})
  const reloadAi = useCallback((tabId: number) => {
    setAiReload((r) => ({ ...r, [tabId]: (r[tabId] ?? 0) + 1 }))
  }, [])
  // AI tabs are drawn once first shown, then stay mounted so their results survive tab switches.
  const [aiShown, setAiShown] = useState<Set<number>>(() => new Set())
  const contentRef = useRef<HTMLDivElement>(null)
  const downloads = useDownloads()
  const bookmarks = useBookmarks()
  const infobars = useInfoBars()
  // Find in page: open for one tab at a time; `focus` re-selects on ⌘F, `step` is ⌘G / ⇧⌘G.
  const [find, setFind] = useState<{ tabId: number; url: string; focus: number } | null>(null)
  const [findStep, setFindStep] = useState<{ n: number; forward: boolean } | null>(null)
  // Address suggestions cover the page: the page view hides and a picture of it shows instead.
  const [covered, setCovered] = useState(false)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const coverSeq = useRef(0)
  const activeIdRef = useRef<number | null>(null)

  const width = panelWidth ?? settings?.sidePanelWidth ?? 380
  const onboarding = settings !== null && !settings.onboardingComplete
  const touring = settings !== null && settings.onboardingComplete && !settings.tourComplete
  const overlay = (onboarding && !peeking) || touring || settingsOpen !== false || settings === null

  // Theme: follow OS unless overridden.
  useEffect(() => {
    if (!settings) return
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings])

  useEffect(() => {
    try {
      localStorage.setItem('panelOpen', panelOpen ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [panelOpen])

  // Keep the active WebContentsView exactly over the content area.
  const sendBounds = useCallback(() => {
    const el = contentRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    void api.invoke('ui:content-bounds', {
      bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
      visible: !overlay && !covering && !covered
    })
  }, [overlay, covering, covered])

  useLayoutEffect(() => {
    sendBounds()
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(sendBounds)
    ro.observe(el)
    window.addEventListener('resize', sendBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sendBounds)
    }
  }, [sendBounds, panelOpen, width, covering])

  const activeId = activeTab?.id ?? null
  useEffect(() => {
    setAiShown((shown) => {
      const live = new Set(tabs.filter((t) => t.ai !== null).map((t) => t.id))
      const next = new Set([...shown].filter((id) => live.has(id)))
      if (aiActive && activeId !== null) next.add(activeId)
      return next.size === shown.size && [...next].every((id) => shown.has(id)) ? shown : next
    })
  }, [tabs, aiActive, activeId])

  const newAiTab = useCallback(() => {
    // A blank active tab is reused; otherwise a new tab opens.
    if (blank && activeTab) {
      setAiIntent((i) => ({ tabId: activeTab.id, n: (i?.n ?? 0) + 1 }))
      return
    }
    void api
      .invoke('tabs:create', { focusAddress: false })
      .then((tabId) => setAiIntent((i) => ({ tabId, n: (i?.n ?? 0) + 1 })))
  }, [blank, activeTab])

  activeIdRef.current = activeId
  const aiActiveRef = useRef(covering)
  aiActiveRef.current = covering
  const onCover = useCallback((cover: boolean) => {
    const seq = ++coverSeq.current
    const id = activeIdRef.current
    if (!cover || id === null || aiActiveRef.current) {
      setCovered(false)
      setSnapshot(null)
      return
    }
    void api.invoke('tabs:snapshot', { tabId: id }).then((img) => {
      if (seq !== coverSeq.current) return
      setSnapshot(img)
      setCovered(true)
    })
  }, [])

  // The find bar belongs to one page: it closes when the tab or its address changes.
  useEffect(() => {
    if (find && (activeTab?.id !== find.tabId || activeTab.url !== find.url)) setFind(null)
  }, [find, activeTab])

  // Sources, results and images from an AI tab open as new web tabs.
  const openFromSearch = useCallback((url: string) => {
    void api.invoke('tabs:create', { url, activate: true })
  }, [])

  const openLibrary = (page: LibraryPageId): void => {
    void api.invoke('tabs:open-page', { page })
  }

  const openPanel = (tab: PanelTab): void => {
    setPanelOpen(true)
    setPanelTab(tab)
  }

  useIpcEvent('ui:command', (cmd) => {
    switch (cmd) {
      case 'focus-address':
        setAddressFocus((n) => n + 1)
        break
      case 'new-ai-tab':
        newAiTab()
        break
      case 'reload-ai':
        if (activeTab?.ai) reloadAi(activeTab.id)
        break
      case 'toggle-panel':
        setPanelOpen((o) => !o)
        break
      case 'open-settings':
        setSettingsOpen('general')
        break
      case 'settings-passwords':
        setSettingsOpen('passwords')
        break
      case 'panel-summary':
        openPanel('summary')
        break
      case 'panel-chat':
        openPanel('chat')
        break
      case 'panel-history':
        openLibrary('history')
        break
      case 'panel-downloads':
        openLibrary('downloads')
        break
      case 'find':
        if (!aiActive && activeTab && !blank)
          setFind((f) => ({ tabId: activeTab.id, url: activeTab.url, focus: (f?.focus ?? 0) + 1 }))
        break
      case 'find-next':
      case 'find-previous':
        if (!find && !aiActive && activeTab && !blank)
          setFind({ tabId: activeTab.id, url: activeTab.url, focus: 1 })
        setFindStep((st) => ({ n: (st?.n ?? 0) + 1, forward: cmd === 'find-next' }))
        break
    }
  })

  // "Compare with AI" (tab menu): the clicked tab's chat compares the chosen tabs.
  useIpcEvent('ui:compare-tabs', (c: CompareTabsAction) => {
    openPanel('chat')
    setChatDraft({ text: '', n: Date.now(), tabIds: c.tabIds })
    void store.sendChat(c.tabId, COMPARE_PROMPT, false, c.tabIds)
  })

  useIpcEvent('ui:selection', (sel: SelectionAction) => {
    if (sel.kind === 'summarize') {
      openPanel('summary')
      void store.startSummary(sel.tabId, 'summary', { selectionText: sel.text })
    } else {
      openPanel('chat')
      setChatDraft({ text: `About this selection: "${sel.text.slice(0, 300)}"\n`, n: Date.now() })
    }
  })

  // Panel resize.
  const dragging = useRef(false)
  const onResizeStart = (e: React.PointerEvent): void => {
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return
    const next = Math.round(
      Math.min(SIDE_PANEL_MAX, Math.max(SIDE_PANEL_MIN, window.innerWidth - e.clientX))
    )
    setPanelWidth(next)
  }
  const onResizeEnd = (): void => {
    if (!dragging.current) return
    dragging.current = false
    if (panelWidth) void updateSettings({ sidePanelWidth: panelWidth })
  }
  const onResizeKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const next = Math.min(
      SIDE_PANEL_MAX,
      Math.max(SIDE_PANEL_MIN, width + (e.key === 'ArrowLeft' ? 20 : -20))
    )
    setPanelWidth(next)
    void updateSettings({ sidePanelWidth: next })
  }

  return (
    <div className={`app ${api.platform === 'darwin' ? 'mac' : ''}`}>
      <TabStrip tabs={tabs} />
      <AddressBar
        tab={activeTab}
        onReloadAi={() => activeTab && reloadAi(activeTab.id)}
        focusSignal={addressFocus}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((o) => !o)}
        onOpenSettings={() => setSettingsOpen('general')}
        status={status}
        onCover={onCover}
        downloads={downloads}
        onOpenDownloads={() => openLibrary('downloads')}
        onOpenLibrary={() => openLibrary('history')}
        bookmarked={
          activeTab && !covering && /^https?:/.test(activeTab.url)
            ? (bookmarks?.some((b) => b.url === activeTab.url) ?? false)
            : null
        }
        onToggleBookmark={() =>
          activeTab &&
          void api.invoke('bookmarks:toggle', { url: activeTab.url, title: activeTab.title })
        }
      />
      {settings?.bookmarksBar && bookmarks && bookmarks.length > 0 && (
        <BookmarksBar
          list={bookmarks}
          activeTab={activeTab}
          onShowAll={() => openLibrary('bookmarks')}
        />
      )}
      {tabs
        .filter((t) => t.ai !== null && aiShown.has(t.id))
        .map((t) => (
          <SearchMode
            key={t.id}
            tabId={t.id}
            active={t.active}
            defaultMode={settings?.searchAnswerMode ?? 'quick'}
            sourceCount={settings?.searchSources ?? null}
            query={t.ai!}
            reloadSignal={aiReload[t.id] ?? 0}
            onOpenUrl={openFromSearch}
            onOpenSettings={(section) => setSettingsOpen(section)}
          />
        ))}
      {activeTab && libraryPage && (
        <LibraryPage
          tabId={activeTab.id}
          page={libraryPage}
          downloads={downloads}
          bookmarks={bookmarks}
        />
      )}
      <div className="main" hidden={covering}>
        <div className="content-column">
          {!overlay && <InfoBars list={infobars} tabId={activeTab?.id ?? null} />}
          {find && !overlay && activeTab?.id === find.tabId && (
            <FindBar
              tabId={find.tabId}
              focusSignal={find.focus}
              step={findStep}
              onClose={() => setFind(null)}
            />
          )}
          <div className="content" ref={contentRef} aria-label="Web page area">
            {blank && activeTab && !overlay && (
              <NewTabPage
                key={activeTab.id}
                tabId={activeTab.id}
                aiSignal={aiIntent?.tabId === activeTab.id ? aiIntent.n : 0}
              />
            )}
            {!blank && overlay && <div className="content-placeholder" />}
            {!blank && !overlay && covered && (
              <>
                <div className="content-placeholder" />
                {snapshot && <img className="content-snapshot" src={snapshot} alt="" />}
              </>
            )}
          </div>
        </div>
        {panelOpen && (
          <>
            <div
              className="resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize AI panel"
              aria-valuemin={SIDE_PANEL_MIN}
              aria-valuemax={SIDE_PANEL_MAX}
              aria-valuenow={width}
              tabIndex={0}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onKeyDown={onResizeKey}
            />
            <SidePanel
              width={width}
              tab={panelTab}
              onTab={setPanelTab}
              activeTab={activeTab}
              tabs={tabs}
              store={store}
              agent={agent}
              status={status}
              settings={settings}
              chatDraft={chatDraft}
              onClose={() => setPanelOpen(false)}
              onOpenSettings={(section) => setSettingsOpen(section)}
            />
          </>
        )}
      </div>
      {settings && onboarding && (
        <OnboardingScreen settings={settings} updateSettings={updateSettings} onPeek={setPeeking} />
      )}
      {settings && touring && <Tour onDone={() => void updateSettings({ tourComplete: true })} />}
      {settings && settingsOpen !== false && (
        <Settings
          settings={settings}
          updateSettings={updateSettings}
          status={status}
          initialSection={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
