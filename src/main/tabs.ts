import {
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  nativeTheme,
  session as electronSession,
  type Session,
  type WebContents
} from 'electron'
import { EventEmitter } from 'node:events'
import { isWebUrl, normalizeAddressInput, type SearchEngine } from '@shared/url'
import type {
  ContentBounds,
  FindResult,
  LibraryPage,
  SelectionAction,
  TabId,
  TabInfo
} from '@shared/types'

export const BROWSING_PARTITION = 'persist:browsing'

/** Schemes handed to another app (after the user agrees), instead of being loaded in a tab. */
export const EXTERNAL_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'facetime:', 'facetime-audio:'])

/** Chrome's zoom steps. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const MAX_CLOSED = 25
const MAX_SOURCE_CHARS = 1_500_000

interface Tab {
  id: TabId
  view: WebContentsView
  favicon: string | null
  /** The address that failed to load or crashed; Reload retries it. */
  failedUrl: string | null
  /** Restored from the last session but not loaded until first shown. */
  lazy: { url: string; title: string } | null
  /** Main-frame navigation in progress (shown in the address bar until it commits). */
  pendingUrl: string | null
  audible: boolean
  /** An AI tab's question. Its page view stays blank and hidden; the UI draws the AI result. */
  ai: string | null
  /** A built-in page (History / Downloads) shown by the UI instead of a web page. */
  page: LibraryPage | null
}

export interface SessionTab {
  url: string
  title: string
  /** Set for an AI tab (its question); `url` is then empty. */
  ai?: string
}

export interface LoginRequest {
  tabId: TabId
  origin: string
  realm: string
  isProxy: boolean
  callback: (username?: string, password?: string) => void
}

interface TabManagerEvents {
  changed: [TabInfo[]]
  /** Main-frame navigation committed (for history). */
  navigated: [{ tabId: TabId; url: string; title: string }]
  'title-updated': [{ tabId: TabId; url: string; title: string }]
  selection: [SelectionAction]
  compare: [{ tabId: TabId; tabIds: TabId[] }]
  /** A tab's page view was created (for per-page features like saved passwords). */
  created: [{ tabId: TabId; webContents: WebContents }]
  /** A tab was closed (any path: button, shortcut, "close other tabs", ...). */
  closed: [TabId]
  /** The user closed the last tab: the browser should close. */
  empty: []
  'find-result': [FindResult]
  /** A page asked to open a mailto:/tel:/... link. */
  external: [{ tabId: TabId; url: string }]
  unresponsive: [{ tabId: TabId; responsive: boolean }]
  login: [LoginRequest]
  /** "Save Image As…": download this URL through a save dialog. */
  'save-as': [{ tabId: TabId; url: string }]
}

let sessionConfigured = false

/** Strip "Electron/x" and the app token so sites serve their normal Chrome experience. */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\sElectron\/\S+/, '')
    .replace(/\sagentic-browser\/\S+/i, '')
    .replace(/\sAgentic Browser\/\S+/i, '')
}

/** The web-page session. Permission prompts are installed by permissions.ts. */
export function browsingSession(): Session {
  const ses = electronSession.fromPartition(BROWSING_PARTITION)
  if (!sessionConfigured) {
    sessionConfigured = true
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
  }
  return ses
}

let sourceSessionConfigured = false

/**
 * The session Search reads its source pages with. In memory only (no `persist:` prefix) and it
 * never sends cookies, so a source fetch can't carry the user's logins or be tracked
 * across searches. No ad blocker here: a fetch downloads only the page's HTML, never its ads.
 */
export function sourceFetchSession(): Session {
  const ses = electronSession.fromPartition('search-fetch')
  if (!sourceSessionConfigured) {
    sourceSessionConfigured = true
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = { ...details.requestHeaders }
      delete headers.Cookie
      delete headers.cookie
      cb({ requestHeaders: headers })
    })
  }
  return ses
}

function viewBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#202124' : '#ffffff'
}

const PAGE_PREFS: Electron.WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  safeDialogs: true,
  // macOS uses the native spellchecker; elsewhere Chromium would download Hunspell
  // dictionaries from Google's CDN, which breaks the "no hidden network calls" promise.
  spellcheck: process.platform === 'darwin'
}

export class TabManager extends EventEmitter<TabManagerEvents> {
  private readonly tabs = new Map<TabId, Tab>()
  private order: TabId[] = []
  private activeId: TabId | null = null
  private bounds: ContentBounds = { x: 0, y: 0, width: 0, height: 0 }
  private boundsVisible = false
  private emitTimer: NodeJS.Timeout | null = null
  private readonly closedTabs: Array<{ url: string; index: number; ai?: string }> = []
  /** Tab whose video/page is in HTML full screen (fills the whole window). */
  private fullscreenTab: TabId | null = null
  private wasFullScreen = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly searchEngine: () => SearchEngine,
    /** The pages' session: the shared browsing session, or an incognito window's own. */
    private readonly session: Session = browsingSession()
  ) {
    super()
    win.on('resize', () => {
      if (this.fullscreenTab !== null) this.layout()
    })
    nativeTheme.on('updated', () => {
      for (const tab of this.tabs.values()) tab.view.setBackgroundColor(viewBackground())
    })
  }

  // ---------------------------------------------------------------- queries

  list(): TabInfo[] {
    return this.order.map((id) => this.info(this.tabs.get(id)!))
  }

  private info(tab: Tab): TabInfo {
    const wc = tab.view.webContents
    if (tab.page !== null) {
      return {
        id: tab.id,
        title: PAGE_TITLES[tab.page],
        url: 'about:blank',
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        active: tab.id === this.activeId,
        audible: false,
        muted: false,
        zoom: 100,
        failed: false,
        ai: null,
        page: tab.page
      }
    }
    if (tab.ai !== null) {
      return {
        id: tab.id,
        title: tab.ai,
        url: 'about:blank',
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        active: tab.id === this.activeId,
        audible: false,
        muted: false,
        zoom: 100,
        failed: false,
        ai: tab.ai,
        page: null
      }
    }
    if (tab.lazy) {
      return {
        id: tab.id,
        title: tab.lazy.title || tab.lazy.url,
        url: tab.lazy.url,
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        active: tab.id === this.activeId,
        audible: false,
        muted: false,
        zoom: 100,
        failed: false,
        ai: null,
        page: null
      }
    }
    const current = wc.getURL() || 'about:blank'
    const url = tab.failedUrl ?? (wc.isLoading() && tab.pendingUrl ? tab.pendingUrl : current)
    const title = wc.getTitle()
    return {
      id: tab.id,
      title: tab.failedUrl
        ? title || tab.failedUrl
        : title && title !== current
          ? title
          : url === 'about:blank'
            ? 'New Tab'
            : url,
      url,
      favicon: tab.failedUrl ? null : tab.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      active: tab.id === this.activeId,
      audible: tab.audible,
      muted: wc.isAudioMuted(),
      zoom: Math.round(wc.getZoomFactor() * 100),
      failed: tab.failedUrl !== null,
      ai: null,
      page: null
    }
  }

  get activeTabId(): TabId | null {
    return this.activeId
  }

  get count(): number {
    return this.order.length
  }

  has(id: TabId): boolean {
    return this.tabs.has(id)
  }

  webContents(id: TabId): WebContents {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`No tab with id ${id}`)
    return tab.view.webContents
  }

  /** The tab's info, or null if it no longer exists. */
  get(id: TabId): TabInfo | null {
    const tab = this.tabs.get(id)
    return tab ? this.info(tab) : null
  }

  /**
   * Load a tab restored lazily from the last session (without showing it) and wait until its
   * page has finished loading, so its text can be read. Gives up waiting after `timeoutMs`.
   */
  async ensureLoaded(id: TabId, timeoutMs = 15_000): Promise<void> {
    const tab = this.tabs.get(id)
    if (!tab || tab.ai !== null || tab.page !== null) return
    const wc = tab.view.webContents
    if (tab.lazy) this.loadUrl(id, tab.lazy.url)
    if (!wc.isLoading() && wc.getURL()) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        wc.off('did-stop-loading', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      wc.on('did-stop-loading', done)
    })
  }

  /** Show History or Downloads: switch to an open one, else open it in a new tab. */
  openPage(page: LibraryPage): void {
    const existing = this.order.find((id) => this.tabs.get(id)?.page === page)
    if (existing !== undefined) this.activate(existing)
    else this.create('about:blank', true, { page })
  }

  /** Switch a History tab to Downloads or back. */
  setPage(id: TabId, page: LibraryPage): void {
    const tab = this.tabs.get(id)
    if (!tab || tab.page === null) return
    tab.page = page
    this.scheduleEmit()
  }

  /** An AI tab (no web page). */
  isAi(id: TabId): boolean {
    return (this.tabs.get(id)?.ai ?? null) !== null
  }

  findByWebContents(wc: WebContents): TabId | null {
    for (const tab of this.tabs.values()) if (tab.view.webContents === wc) return tab.id
    return null
  }

  /** Tabs to reopen next launch: web tabs by address, AI tabs by question. */
  sessionTabs(): { tabs: SessionTab[]; active: number } {
    const out: SessionTab[] = []
    let active = 0
    for (const id of this.order) {
      const info = this.info(this.tabs.get(id)!)
      if (info.ai !== null) {
        if (id === this.activeId) active = out.length
        out.push({ url: '', title: info.ai, ai: info.ai })
        continue
      }
      if (!isWebUrl(info.url)) continue
      if (id === this.activeId) active = out.length
      out.push({ url: info.url, title: info.title })
    }
    return { tabs: out, active }
  }

  // ---------------------------------------------------------------- mutations

  create(
    url = 'about:blank',
    activate = true,
    opts: { lazyTitle?: string; ai?: string; page?: LibraryPage } = {}
  ): TabId {
    const view = new WebContentsView({
      webPreferences: { ...PAGE_PREFS, session: this.session }
    })
    view.setBackgroundColor(viewBackground())
    const id = view.webContents.id
    const lazy = opts.lazyTitle !== undefined && url !== 'about:blank'
    const tab: Tab = {
      id,
      view,
      favicon: null,
      failedUrl: null,
      lazy: lazy ? { url, title: opts.lazyTitle ?? '' } : null,
      pendingUrl: null,
      audible: false,
      ai: opts.ai ?? null,
      page: opts.page ?? null
    }
    this.tabs.set(id, tab)
    const activeIdx = this.activeId === null ? -1 : this.order.indexOf(this.activeId)
    if (activeIdx >= 0 && url !== 'about:blank' && !lazy) this.order.splice(activeIdx + 1, 0, id)
    else this.order.push(id)
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.wire(tab)
    this.emit('created', { tabId: id, webContents: view.webContents })
    if (url !== 'about:blank' && !lazy) this.loadUrl(id, url)
    if (activate) this.activate(id)
    else this.scheduleEmit()
    return id
  }

  /** Recreate the last session's tabs. Only the active one loads now; the rest load when shown. */
  restore(saved: SessionTab[], active: number): void {
    // An AI tab runs its search when the UI first shows it.
    const ids = saved.map((t, i) =>
      t.ai
        ? this.create('about:blank', false, { ai: t.ai })
        : this.create(t.url, false, i === active ? {} : { lazyTitle: t.title })
    )
    const target = ids[Math.min(Math.max(active, 0), ids.length - 1)]
    if (target !== undefined) this.activate(target)
  }

  close(id: TabId): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const idx = this.order.indexOf(id)
    const info = this.info(tab)
    if (info.ai !== null || isWebUrl(info.url)) {
      this.closedTabs.push({
        url: info.url,
        index: idx,
        ...(info.ai !== null ? { ai: info.ai } : {})
      })
      if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift()
    }
    if (this.fullscreenTab === id) this.leaveFullscreen()
    this.order = this.order.filter((t) => t !== id)
    this.tabs.delete(id)
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    this.emit('closed', id)
    if (this.order.length === 0) {
      this.activeId = null
      this.scheduleEmit()
      this.emit('empty')
      return
    }
    if (this.activeId === id) {
      const next = this.order[Math.min(idx, this.order.length - 1)]!
      this.activeId = null
      this.activate(next)
    } else {
      this.scheduleEmit()
    }
  }

  closeOthers(id: TabId): void {
    for (const other of [...this.order]) if (other !== id) this.close(other)
  }

  closeToRight(id: TabId): void {
    const idx = this.order.indexOf(id)
    if (idx < 0) return
    for (const other of this.order.slice(idx + 1)) this.close(other)
  }

  get canReopen(): boolean {
    return this.closedTabs.length > 0
  }

  reopenClosed(): void {
    const last = this.closedTabs.pop()
    if (!last) return
    const id = last.ai
      ? this.create('about:blank', true, { ai: last.ai })
      : this.create(last.url, true)
    this.move(id, last.index)
  }

  duplicate(id: TabId): void {
    const info = this.tabs.get(id) && this.info(this.tabs.get(id)!)
    if (!info) return
    if (info.ai !== null)
      this.move(this.create('about:blank', true, { ai: info.ai }), this.order.indexOf(id) + 1)
    else if (isWebUrl(info.url)) this.create(info.url, true)
  }

  /**
   * Make a blank tab (or an AI tab, for a new question) an AI tab answering `query`. A tab
   * showing a web page is left alone: its page would be lost.
   */
  askAi(id: TabId, query: string): void {
    const tab = this.tabs.get(id)
    if (!tab || (tab.ai === null && !this.isBlank(tab))) return
    tab.ai = query.trim()
    this.layout()
    this.scheduleEmit()
  }

  closeAll(): void {
    for (const id of [...this.order]) {
      const tab = this.tabs.get(id)
      if (!tab) continue
      this.win.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
    }
    this.tabs.clear()
    this.order = []
    this.activeId = null
  }

  activate(id: TabId, opts: { focus?: boolean } = {}): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (this.fullscreenTab !== null && this.fullscreenTab !== id) this.leaveFullscreen()
    this.activeId = id
    if (tab.lazy) {
      const { url } = tab.lazy
      tab.lazy = null
      this.loadUrl(id, url)
    }
    this.layout()
    this.scheduleEmit()
    // Keys go to the page, as in other browsers (blank and AI tabs focus the UI instead).
    if (
      opts.focus !== false &&
      this.boundsVisible &&
      !this.isBlank(tab) &&
      tab.ai === null &&
      tab.page === null
    ) {
      tab.view.webContents.focus()
    }
  }

  activateRelative(delta: number): void {
    if (this.activeId === null || this.order.length === 0) return
    const idx = this.order.indexOf(this.activeId)
    const next = this.order[(idx + delta + this.order.length) % this.order.length]!
    this.activate(next)
  }

  activateIndex(index: number): void {
    const id = index < 0 ? this.order[this.order.length - 1] : this.order[index]
    if (id !== undefined) this.activate(id)
  }

  /** Position of the active tab in the strip (-1 when there is none). */
  get activeIndex(): number {
    return this.activeId === null ? -1 : this.order.indexOf(this.activeId)
  }

  move(id: TabId, toIndex: number): void {
    const from = this.order.indexOf(id)
    if (from < 0) return
    this.order.splice(from, 1)
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id)
    this.scheduleEmit()
  }

  navigate(id: TabId, input: string): void {
    const url = normalizeAddressInput(input, this.searchEngine())
    if (!isWebUrl(url) && url !== 'about:blank') {
      const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0].toLowerCase() ?? ''
      if (EXTERNAL_SCHEMES.has(scheme)) this.emit('external', { tabId: id, url })
      else this.showErrorPage(id, url, 'This browser only opens web pages (http and https).')
      return
    }
    this.loadUrl(id, url)
    this.focusPage()
  }

  loadUrl(id: TabId, url: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    // Loading a page (e.g. a URL typed in an AI tab) makes it a web tab.
    tab.ai = null
    tab.page = null
    tab.lazy = null
    tab.failedUrl = null
    tab.pendingUrl = url === 'about:blank' ? null : url
    void tab.view.webContents.loadURL(url).catch(() => undefined) // Errors surface through did-fail-load.
    this.scheduleEmit()
  }

  back(id: TabId): void {
    const tab = this.tabs.get(id)
    const h = this.webContents(id).navigationHistory
    if (!tab || !h.canGoBack()) return
    tab.failedUrl = null
    h.goBack()
  }

  forward(id: TabId): void {
    const tab = this.tabs.get(id)
    const h = this.webContents(id).navigationHistory
    if (!tab || !h.canGoForward()) return
    tab.failedUrl = null
    h.goForward()
  }

  reload(id: TabId, ignoreCache = false): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    // An error or crash page reloads the address that failed, not the error page.
    if (tab.failedUrl) {
      this.loadUrl(id, tab.failedUrl)
      return
    }
    const wc = tab.view.webContents
    if (ignoreCache) wc.reloadIgnoringCache()
    else wc.reload()
  }

  stop(id: TabId): void {
    this.webContents(id).stop()
  }

  focusPage(): void {
    if (this.activeId === null) return
    this.tabs.get(this.activeId)?.view.webContents.focus()
  }

  // ---------------------------------------------------------------- page tools

  find(id: TabId, text: string, forward: boolean, findNext: boolean): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc) return
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.emit('find-result', { tabId: id, matches: 0, active: 0 })
      return
    }
    // Electron's `findNext: true` starts a new search session; false moves to the next match.
    wc.findInPage(text, { forward, findNext: !findNext })
  }

  stopFind(id: TabId, keepSelection: boolean): void {
    this.tabs
      .get(id)
      ?.view.webContents.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection')
  }

  /** step: +1 zoom in, -1 zoom out, 0 reset. Chromium keeps zoom per site. */
  zoom(id: TabId, step: -1 | 0 | 1): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc) return
    if (step === 0) {
      wc.setZoomFactor(1)
    } else {
      const cur = wc.getZoomFactor()
      const next =
        step > 0
          ? ZOOM_STEPS.find((z) => z > cur + 0.001)
          : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001)
      if (next !== undefined) wc.setZoomFactor(next)
    }
    this.scheduleEmit()
  }

  print(id: TabId): void {
    this.tabs.get(id)?.view.webContents.print({}, () => undefined)
  }

  toggleMute(id: TabId): void {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc) return
    wc.setAudioMuted(!wc.isAudioMuted())
    this.scheduleEmit()
  }

  /** Open the page's HTML as plain text in a new tab. */
  async viewSource(id: TabId): Promise<void> {
    const wc = this.tabs.get(id)?.view.webContents
    if (!wc || !isWebUrl(wc.getURL())) return
    let html = ''
    try {
      html = String(await wc.executeJavaScript('document.documentElement.outerHTML', true))
    } catch {
      return
    }
    if (html.length > MAX_SOURCE_CHARS)
      html = `${html.slice(0, MAX_SOURCE_CHARS)}\n\n<!-- Source truncated: page is too large. -->`
    const newId = this.create('about:blank', true)
    void this.webContents(newId)
      .loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => undefined)
  }

  // ---------------------------------------------------------------- layout

  setContentBounds(bounds: ContentBounds, visible: boolean): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.boundsVisible = visible
    this.layout()
  }

  private isBlank(tab: Tab): boolean {
    const url = tab.view.webContents.getURL()
    return (
      tab.ai === null &&
      tab.page === null &&
      !tab.lazy &&
      !tab.failedUrl &&
      (!url || url === 'about:blank') &&
      !tab.view.webContents.isLoading()
    )
  }

  private layout(): void {
    for (const tab of this.tabs.values()) {
      const isActive = tab.id === this.activeId
      if (this.fullscreenTab === tab.id && isActive) {
        const [width = 0, height = 0] = this.win.getContentSize()
        tab.view.setBounds({ x: 0, y: 0, width, height })
        tab.view.setVisible(true)
        continue
      }
      // Blank tabs show the renderer's New Tab page underneath instead of an empty white view.
      const show =
        isActive &&
        this.boundsVisible &&
        tab.ai === null &&
        tab.page === null &&
        !this.isBlank(tab) &&
        this.bounds.width > 0
      if (show) tab.view.setBounds(this.bounds)
      tab.view.setVisible(show)
    }
  }

  private leaveFullscreen(): void {
    if (this.fullscreenTab === null) return
    this.fullscreenTab = null
    if (!this.wasFullScreen && this.win.isFullScreen()) this.win.setFullScreen(false)
    this.layout()
  }

  // ---------------------------------------------------------------- events

  private scheduleEmit(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('changed', this.list())
    }, 16)
  }

  private showErrorPage(id: TabId, url: string, message: string, detail = ''): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.failedUrl = url
    tab.pendingUrl = null
    const reloadKey = process.platform === 'darwin' ? '⌘R' : 'Ctrl+R'
    const html = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(hostOf(url))}</title>
      <body style="font:15px system-ui;padding:48px;max-width:640px;margin:auto">
      <h2>${escapeHtml(message)}</h2><p style="word-break:break-all">${escapeHtml(url)}</p>
      ${detail ? `<p style="opacity:.6">${escapeHtml(detail)}</p>` : ''}
      <p style="opacity:.6">Press ${reloadKey} or the Reload button to try again.</p></body>`
    void tab.view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => undefined)
    this.scheduleEmit()
  }

  /** Handle a link to a non-web scheme. Returns true when it was dealt with. */
  private handleNonWeb(tab: Tab, url: string): boolean {
    if (isWebUrl(url) || url === 'about:blank') return false
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0].toLowerCase() ?? ''
    if (EXTERNAL_SCHEMES.has(scheme)) this.emit('external', { tabId: tab.id, url })
    return true
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    const update = (): void => {
      this.layout()
      this.scheduleEmit()
    }
    wc.setVisualZoomLevelLimits(1, 3).catch(() => undefined)
    // Esc stops a loading page (without taking Esc away from the page otherwise).
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && wc.isLoading()) wc.stop()
    })
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', () => {
      tab.pendingUrl = null
      update()
    })
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      if (isWebUrl(details.url)) {
        tab.pendingUrl = details.url
        this.scheduleEmit()
      }
    })
    wc.on('page-title-updated', (_e, title) => {
      this.scheduleEmit()
      this.emit('title-updated', { tabId: tab.id, url: wc.getURL(), title })
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons.find((f) => /^https?:|^data:image\//.test(f)) ?? null
      this.scheduleEmit()
    })
    wc.on('did-navigate', (_e, url) => {
      tab.favicon = null
      tab.pendingUrl = null
      // The error page itself is a data: URL; only a real page clears the failure.
      if (!url.startsWith('data:')) tab.failedUrl = null
      update()
      if (isWebUrl(url)) this.emit('navigated', { tabId: tab.id, url, title: wc.getTitle() })
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      update()
      if (isWebUrl(url)) this.emit('navigated', { tabId: tab.id, url, title: wc.getTitle() })
    })
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED (user stopped / replaced navigation)
      if (!isMainFrame || code === -3 || url.startsWith('data:')) return
      this.showErrorPage(tab.id, url, errorMessage(description), `${description} (${code})`)
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      const url = tab.failedUrl ?? wc.getURL()
      if (!isWebUrl(url)) return
      this.showErrorPage(
        tab.id,
        url,
        details.reason === 'oom' ? 'This page ran out of memory.' : 'This page crashed.',
        `Reason: ${details.reason}`
      )
    })
    wc.on('unresponsive', () => this.emit('unresponsive', { tabId: tab.id, responsive: false }))
    wc.on('responsive', () => this.emit('unresponsive', { tabId: tab.id, responsive: true }))
    wc.on('audio-state-changed', (e) => {
      tab.audible = e.audible
      this.scheduleEmit()
    })
    wc.on('zoom-changed', (_e, direction) => {
      if (this.tabs.has(tab.id)) this.zoom(tab.id, direction === 'in' ? 1 : -1)
    })
    wc.on('found-in-page', (_e, result) => {
      this.emit('find-result', {
        tabId: tab.id,
        matches: result.matches,
        active: result.activeMatchOrdinal
      })
    })
    wc.on('enter-html-full-screen', () => {
      if (this.fullscreenTab === null) this.wasFullScreen = this.win.isFullScreen()
      this.fullscreenTab = tab.id
      if (!this.win.isFullScreen()) this.win.setFullScreen(true)
      this.layout()
    })
    wc.on('leave-html-full-screen', () => {
      if (this.fullscreenTab === tab.id) this.leaveFullscreen()
    })
    wc.on('login', (event, details, authInfo, callback) => {
      event.preventDefault()
      this.emit('login', {
        tabId: tab.id,
        origin: hostOf(details.url),
        realm: authInfo.realm,
        isProxy: authInfo.isProxy,
        callback
      })
    })

    // Popups (sign-in windows) open as real windows so window.opener keeps working;
    // links with target=_blank open as tabs.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (this.handleNonWeb(tab, url)) return { action: 'deny' }
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            autoHideMenuBar: true,
            backgroundColor: viewBackground(),
            webPreferences: { ...PAGE_PREFS, session: this.session }
          }
        }
      }
      if (isWebUrl(url)) this.create(url, disposition !== 'background-tab')
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child) => this.guardPopup(child))

    // Only web content may be loaded in tabs.
    wc.on('will-navigate', (event, url) => {
      if (this.handleNonWeb(tab, url)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (this.handleNonWeb(tab, url)) event.preventDefault()
    })

    wc.on('context-menu', (_e, params) => this.pageMenu(tab, params))
  }

  /** Popup windows get the same rules as tabs; their own links open as tabs. */
  private guardPopup(child: BrowserWindow): void {
    const wc = child.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) this.create(url, true)
      return { action: 'deny' }
    })
    const block = (event: Electron.Event, url: string): void => {
      if (!isWebUrl(url) && url !== 'about:blank') event.preventDefault()
    }
    wc.on('will-navigate', block)
    wc.on('will-redirect', block)
  }

  private pageMenu(tab: Tab, params: Electron.ContextMenuParams): void {
    const wc = tab.view.webContents
    const items: Electron.MenuItemConstructorOptions[] = []
    const section = (...next: Electron.MenuItemConstructorOptions[]): void => {
      if (next.length === 0) return
      if (items.length) items.push({ type: 'separator' })
      items.push(...next)
    }
    const selection = params.selectionText.trim()
    const flags = params.editFlags

    if (params.misspelledWord) {
      section(
        ...(params.dictionarySuggestions.length
          ? params.dictionarySuggestions.slice(0, 5).map((s) => ({
              label: s,
              click: () => wc.replaceMisspelling(s)
            }))
          : [{ label: 'No suggestions', enabled: false }]),
        {
          label: 'Add to Dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        }
      )
    }
    if (params.linkURL && isWebUrl(params.linkURL)) {
      section(
        { label: 'Open Link in New Tab', click: () => this.create(params.linkURL, false) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) }
      )
    } else if (params.linkURL.startsWith('mailto:')) {
      section({
        label: 'Copy Email Address',
        click: () => clipboard.writeText(decodeURIComponent(params.linkURL.slice(7).split('?')[0]!))
      })
    }
    if (params.mediaType === 'image' && isWebUrl(params.srcURL)) {
      section(
        { label: 'Open Image in New Tab', click: () => this.create(params.srcURL, false) },
        {
          label: 'Save Image As…',
          click: () => this.emit('save-as', { tabId: tab.id, url: params.srcURL })
        },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }
      )
    }
    if (params.isEditable) {
      section(
        { role: 'undo', enabled: flags.canUndo },
        { role: 'redo', enabled: flags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: flags.canCut },
        { role: 'copy', enabled: flags.canCopy },
        { role: 'paste', enabled: flags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: flags.canPaste },
        { role: 'selectAll', enabled: flags.canSelectAll }
      )
    } else if (selection) {
      section({ role: 'copy' })
    }
    if (selection) {
      section(
        {
          label: 'Summarize Selection',
          click: () => this.emit('selection', { kind: 'summarize', tabId: tab.id, text: selection })
        },
        {
          label: 'Ask AI About Selection',
          click: () => this.emit('selection', { kind: 'ask', tabId: tab.id, text: selection })
        }
      )
    }
    if (!params.isEditable && !params.linkURL && params.mediaType === 'none' && !selection) {
      section(
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => this.back(tab.id)
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => this.forward(tab.id)
        },
        { label: 'Reload', click: () => this.reload(tab.id) },
        { type: 'separator' },
        { label: 'Print…', click: () => this.print(tab.id) },
        { label: 'View Page Source', click: () => void this.viewSource(tab.id) }
      )
    }
    section({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }

  /** Right-click menu for a tab in the strip. */
  tabMenu(id: TabId): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const wc = tab.view.webContents
    const idx = this.order.indexOf(id)
    const web = tab.ai === null
    const isWeb = (t: Tab): boolean =>
      t.ai === null && /^https?:/.test(t.lazy?.url ?? t.view.webContents.getURL())
    const others = this.order
      .filter((o) => o !== id)
      .map((o) => this.tabs.get(o)!)
      .filter(isWeb)
    const compare = (ids: TabId[]): void => {
      this.activate(id)
      this.emit('compare', { tabId: id, tabIds: [id, ...ids].slice(0, 8) })
    }
    Menu.buildFromTemplate([
      { label: 'New Tab', click: () => this.create() },
      { type: 'separator' },
      { label: 'Reload', enabled: web, click: () => this.reload(id) },
      { label: 'Duplicate', click: () => this.duplicate(id) },
      {
        label: wc.isAudioMuted() ? 'Unmute Site' : 'Mute Site',
        enabled: web,
        click: () => this.toggleMute(id)
      },
      {
        label: 'Compare with AI',
        enabled: isWeb(tab) && others.length > 0,
        submenu: [
          { label: 'All Open Tabs', click: () => compare(others.map((t) => t.id)) },
          { type: 'separator' },
          ...others.slice(0, 20).map((t) => ({
            label: `With “${this.info(t).title.slice(0, 60)}”`,
            click: () => compare([t.id])
          }))
        ]
      },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.close(id) },
      {
        label: 'Close Other Tabs',
        enabled: this.order.length > 1,
        click: () => this.closeOthers(id)
      },
      {
        label: 'Close Tabs to the Right',
        enabled: idx >= 0 && idx < this.order.length - 1,
        click: () => this.closeToRight(id)
      },
      { type: 'separator' },
      { label: 'Reopen Closed Tab', enabled: this.canReopen, click: () => this.reopenClosed() }
    ]).popup({ window: this.win })
  }
}

const PAGE_TITLES: Record<LibraryPage, string> = {
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
  settings: 'Settings'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A short, plain-language headline for a Chromium network error. */
function errorMessage(description: string): string {
  if (description.startsWith('ERR_CERT') || description.includes('SSL'))
    return "This site's security certificate isn't trusted, so the connection was stopped."
  if (description === 'ERR_INTERNET_DISCONNECTED') return "You're offline."
  if (description === 'ERR_NAME_NOT_RESOLVED') return "This site's address couldn't be found."
  if (description === 'ERR_CONNECTION_REFUSED') return 'The site refused to connect.'
  if (description === 'ERR_CONNECTION_TIMED_OUT' || description === 'ERR_TIMED_OUT')
    return 'The site took too long to respond.'
  if (description === 'ERR_BLOCKED_BY_CLIENT') return 'This page was blocked by the ad blocker.'
  return "This page can't be loaded."
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}
