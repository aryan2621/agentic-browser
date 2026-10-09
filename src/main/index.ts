import { randomUUID } from 'node:crypto'
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EventChannel, EventMap } from '@shared/ipc'
import type { InvokeHandlers } from './ipc'
import type { LlmStatus, ModelRole, Settings, UiCommand } from '@shared/types'
import { AgentRunner } from './agent'
import { PasswordManager } from './passwords'
import { extractPage } from './extract'
import { AssistantService } from './assistant'
import { AdBlocker } from './adblock'
import { SpeechService } from './speech/service'
import { runScreenshots } from './devScreenshots'
import { AppDatabase } from './db'
import type { SearchProvider } from './search'
import { DuckDuckGoBrowserSearch } from './webSearch'
import { registerIpc, sendToRenderer } from './ipc'
import { recommendModels, systemInfo } from './llm/hardware'
import { LlamaCppProvider } from './llm/llamacpp'
import { MockProvider } from './llm/mock'
import { ModelManager, freeDiskBytes } from './llm/models'
import type { ModelSpec } from './llm/protocol'
import type { LLMProvider } from './llm/provider'
import { SettingsStore } from './settings'
import {
  TabManager,
  browsingSession,
  cleanUserAgent,
  sourceFetchSession,
  type SessionTab
} from './tabs'
import { InfoBarService } from './infobars'
import { ALWAYS_ALLOWED, installPermissions } from './permissions'
import { DownloadManager } from './downloads'

// ------------------------------------------------------------------ environment

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
/** The AB_* switches for scripted runs. A packaged app ignores them. */
const devEnv: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env
const forceMock = devEnv.AB_LLM_PROVIDER === 'mock'
if (devEnv.AB_USER_DATA) app.setPath('userData', devEnv.AB_USER_DATA)

app.setName('Agentic Browser')
app.setAboutPanelOptions({
  applicationName: 'Agentic Browser',
  applicationVersion: app.getVersion(),
  credits: 'Built with Llama. Local inference by llama.cpp via node-llama-cpp.'
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/** `--self-test[=path/to/model.gguf]`: verify the inference stack (useful for packaged builds). */
const selfTestArg = (() => {
  const arg = process.argv.find((a) => a === '--self-test' || a.startsWith('--self-test='))
  if (!arg) return null
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : ''
})()

/** `--screenshots=<dir>`: capture every main UI state (devScreenshots.ts), then quit. Dev only. */
const screenshotsArg = (() => {
  if (app.isPackaged) return null
  const arg = process.argv.find((a) => a.startsWith('--screenshots='))
  return arg ? arg.slice('--screenshots='.length) : null
})()

async function runSelfTest(modelPath: string): Promise<void> {
  const out = (msg: string): void => {
    process.stdout.write(`[self-test] ${msg}\n`)
  }
  let code = 0
  try {
    const spec: ModelSpec | null = modelPath
      ? { id: 'self-test', path: modelPath, contextSize: 4096 }
      : resolveModel('fast')
    if (!spec) throw new Error('No model configured. Pass --self-test=/path/to/model.gguf')
    const p = new LlamaCppProvider(
      () => spec,
      { idleUnloadMs: 0, gpu: settings.get().gpu },
      (l, m) => out(`${l}: ${m}`)
    )
    const hw = systemInfo(await p.hardware())
    out(
      `backend=${String(hw.gpu)} devices=${hw.gpuDeviceNames.join(',') || '-'} ram=${Math.round(hw.totalRamBytes / 1024 ** 3)}GB`
    )
    const t0 = Date.now()
    let streamed = 0
    const res = await p.generate(
      {
        role: 'fast',
        temperature: 0.2,
        maxTokens: 40,
        messages: [{ role: 'user', content: 'Reply with one short sentence about the sea.' }]
      },
      { onToken: () => streamed++ }
    )
    out(
      `generate ok in ${Date.now() - t0}ms, ${streamed} chunks, ${res.tokensPerSecond?.toFixed(1)} tok/s: ${JSON.stringify(res.text)}`
    )
    // Reading speed: time to first token for a long prompt (what search answers wait on).
    const filler = Array.from(
      { length: 120 },
      (_, i) => `Paragraph ${i}: heat pumps move heat from outside air into a building.`
    ).join('\n')
    const [promptTokens = 0] = await p.countTokens([filler], 'fast')
    const t1 = Date.now()
    let firstTokenMs = 0
    await p.generate(
      {
        role: 'fast',
        temperature: 0.2,
        maxTokens: 16,
        messages: [{ role: 'user', content: `${filler}\n\nIn one sentence, what moves heat?` }]
      },
      {
        onToken: () => {
          if (!firstTokenMs) firstTokenMs = Date.now() - t1
        }
      }
    )
    out(
      `prompt ${promptTokens} tokens: first token after ${firstTokenMs} ms (${Math.round((promptTokens / Math.max(firstTokenMs, 1)) * 1000)} tok/s reading)`
    )
    const json = await p.generate({
      role: 'fast',
      temperature: 0.2,
      maxTokens: 80,
      messages: [{ role: 'user', content: 'Give the capital of France.' }],
      jsonSchema: {
        type: 'object',
        properties: { city: { type: 'string' }, country: { type: 'string' } },
        required: ['city', 'country']
      }
    })
    out(`grammar JSON ok: ${JSON.stringify(JSON.parse(json.text))}`)
    const [n] = await p.countTokens(['Hello world, this is a tokenizer test.'], 'fast')
    out(`tokenizer ok: ${n} tokens; status=${JSON.stringify(p.status())}`)
    await p.dispose()
    out('PASS')
  } catch (err) {
    code = 1
    out(`FAIL: ${err instanceof Error ? err.message : String(err)}`)
  }
  db.close()
  app.exit(code)
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[${level}] ${message}`
  if (level === 'error') console.error(line)
  else console.log(line)
}

// ------------------------------------------------------------------ app state

/** One browser window: its UI, its tabs and whether it is incognito. */
interface WindowCtx {
  win: BrowserWindow
  tabs: TabManager
  incognito: boolean
}
/** Open windows by their UI webContents id. */
const windows = new Map<number, WindowCtx>()
/** The window whose IPC call is running (synchronous part), and the last focused one. */
let ipcWindow: BrowserWindow | null = null
let lastFocused: WindowCtx | null = null
let incognitoCount = 0

function ctxOf(w: BrowserWindow | null | undefined): WindowCtx | undefined {
  return w && !w.isDestroyed() ? windows.get(w.webContents.id) : undefined
}

/** The window an action belongs to: the IPC caller, else the focused window, else the last one. */
function currentCtx(): WindowCtx | undefined {
  return (
    ctxOf(ipcWindow) ??
    ctxOf(BrowserWindow.getFocusedWindow()) ??
    (lastFocused && windows.has(lastFocused.win.webContents.id) ? lastFocused : undefined) ??
    [...windows.values()].at(-1)
  )
}

function currentWin(): BrowserWindow | null {
  return currentCtx()?.win ?? null
}

/** Send an event to every window (settings, models, streams, downloads, ...). */
function broadcast<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
  for (const c of windows.values()) sendToRenderer(c.win, channel, payload)
}

/** TabManager methods whose first number argument is not a tab id. */
const NOT_TAB_ID = new Set(['activateRelative', 'activateIndex', 'create', 'restore'])

/**
 * `tabs` routes every call to the right window's TabManager: a call about a tab goes to the window
 * that owns it (tab ids are unique across windows); anything else goes to the current window.
 */
const tabs = new Proxy({} as TabManager, {
  get(_t, prop: string) {
    const sample = (currentCtx() ?? [...windows.values()][0])?.tabs
    const value = sample ? (sample as unknown as Record<string, unknown>)[prop] : undefined
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => {
      const first = args[0]
      const owner =
        typeof first === 'number' && !NOT_TAB_ID.has(prop)
          ? [...windows.values()].find((c) => c.tabs.has(first))?.tabs
          : undefined
      const target = owner ?? currentCtx()?.tabs
      if (!target) throw new Error('No browser window is open.')
      const fn = (target as unknown as Record<string, unknown>)[prop] as (
        ...a: unknown[]
      ) => unknown
      return fn.apply(target, args)
    }
  }
})
let db: AppDatabase
let settings: SettingsStore
let models: ModelManager
let provider: LLMProvider
let unsubscribeStatus: (() => void) | null = null
let assistant: AssistantService
let agent: AgentRunner
let passwords: PasswordManager
let searchProvider: SearchProvider
let adBlocker: AdBlocker
let speech: SpeechService
let infobars: InfoBarService
/** Each AI tab's running web search: its next search (or closing the tab) stops it. */
const searchAborts = new Map<number, AbortController>()
let downloads: DownloadManager
/** The user closed the last tab: next launch starts fresh instead of restoring. */
let sessionCleared = false
let sessionTimer: NodeJS.Timeout | null = null
/** Set once quitting starts: the tabs are going away and must not overwrite the saved session. */
let sessionFrozen = false

const SESSION_KEY = 'session'

function saveSession(): void {
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = null
  if (windows.size === 0 || !db || sessionFrozen) return
  try {
    // Every normal window's tabs, restored into one window next launch. Incognito is never saved.
    const all: SessionTab[] = []
    let active = 0
    for (const c of windows.values()) {
      if (c.incognito) continue
      const part = c.tabs.sessionTabs()
      if (c === currentCtx()) active = all.length + part.active
      all.push(...part.tabs)
    }
    db.setSettings({
      [SESSION_KEY]: sessionCleared ? { tabs: [], active: 0 } : { tabs: all, active }
    })
  } catch (err) {
    log('warn', `Could not save the session: ${String(err)}`)
  }
}

function scheduleSessionSave(): void {
  if (sessionCleared || sessionTimer) return
  sessionTimer = setTimeout(saveSession, 1000)
}

function savedSession(): { tabs: SessionTab[]; active: number } | null {
  const v = db.getSetting(SESSION_KEY) as { tabs?: unknown; active?: unknown } | undefined
  if (!v || !Array.isArray(v.tabs)) return null
  const isAi = (t: SessionTab): boolean => typeof t.ai === 'string' && t.ai.trim().length > 0
  const list = v.tabs
    .filter(
      (t): t is SessionTab =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as SessionTab).url === 'string' &&
        (isAi(t as SessionTab) || /^https?:/i.test((t as SessionTab).url))
    )
    .slice(0, 100)
    .map((t) =>
      isAi(t)
        ? { url: '', title: t.ai!.slice(0, 500), ai: t.ai!.slice(0, 500) }
        : { url: t.url, title: typeof t.title === 'string' ? t.title.slice(0, 300) : '' }
    )
  return list.length ? { tabs: list, active: typeof v.active === 'number' ? v.active : 0 } : null
}

/** Window title: the page title (or an AI tab's question) like other browsers. */
function updateTitle(ctx: WindowCtx): void {
  const { win } = ctx
  if (win.isDestroyed()) return
  const tab = ctx.tabs.list().find((t) => t.active)
  const title = tab?.ai
    ? `${tab.ai} - AI`
    : tab && tab.url !== 'about:blank'
      ? tab.title
      : 'New Tab'
  win.setTitle(`${title} - ${ctx.incognito ? 'Incognito' : app.name}`)
}

function effectiveProvider(s: Settings): 'llamacpp' | 'mock' {
  return forceMock ? 'mock' : s.provider
}

function resolveModel(role: ModelRole): ModelSpec | null {
  const s = settings.get()
  const ids: Array<string | null> =
    role === 'embed' ? [s.models.embed] : role === 'speech' ? [s.models.speech] : [s.models.fast]
  for (const id of ids) {
    if (!id) continue
    const path = models.resolvePath(id)
    if (path) return { id, path, contextSize: role === 'embed' ? 2048 : s.contextSize }
  }
  return null
}

function createProvider(): LLMProvider {
  const s = settings.get()
  if (effectiveProvider(s) === 'mock') return new MockProvider({ tokenDelayMs: 12 })
  return new LlamaCppProvider(
    resolveModel,
    { idleUnloadMs: s.idleUnloadMinutes * 60_000, gpu: s.gpu },
    log
  )
}

function installProvider(next: LLMProvider): void {
  unsubscribeStatus?.()
  provider = next
  unsubscribeStatus = provider.onStatus((status: LlmStatus) => broadcast('llm:status', status))
  broadcast('llm:status', provider.status())
}

// ------------------------------------------------------------------ window

function rendererUrl(): string {
  return isDev
    ? process.env.ELECTRON_RENDERER_URL!
    : pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
}

function isTrustedUiUrl(url: string): boolean {
  if (isDev) return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL!).origin
  return url.split('#')[0]!.split('?')[0] === rendererUrl()
}

function sendCommand(cmd: UiCommand): void {
  sendToRenderer(currentWin(), 'ui:command', cmd)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  // Page commands act on the active web tab; an AI tab has no page, so they do nothing there.
  const withTab = (fn: (id: number) => void) => (): void => {
    const id = tabs.activeTabId
    if (id !== null && !tabs.isAi(id)) fn(id)
  }
  const reload = (ignoreCache: boolean) => (): void => {
    const id = tabs.activeTabId
    if (id === null) return
    if (tabs.isAi(id)) sendCommand('reload-ai')
    else tabs.reload(id, ignoreCache)
  }
  const hidden = (accelerator: string, click: () => void): MenuItemConstructorOptions => ({
    label: accelerator,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click
  })
  // ⌘1…⌘8 pick a tab by position, ⌘9 the last one.
  const tabNumbers: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'Last Tab' : `Tab ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => tabs.activateIndex(i === 8 ? -1 : i)
  }))
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => sendCommand('open-settings')
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            tabs.create()
            sendCommand('focus-address')
          }
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: 'New Incognito Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow({ incognito: true })
        },
        {
          label: 'New AI Tab',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendCommand('new-ai-tab')
        },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => tabs.reopenClosed()
        },
        {
          label: 'Open Location…',
          accelerator: 'CmdOrCtrl+L',
          click: () => sendCommand('focus-address')
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => tabs.activeTabId !== null && tabs.close(tabs.activeTabId)
        },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: withTab((id) => tabs.print(id)) },
        ...(isMac
          ? []
          : ([
              { type: 'separator' },
              {
                label: 'Settings',
                accelerator: 'Ctrl+,',
                click: () => sendCommand('open-settings')
              },
              { role: 'quit' }
            ] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: withTab(() => sendCommand('find')) },
        {
          label: 'Find Next',
          accelerator: isMac ? 'Cmd+G' : 'F3',
          click: withTab(() => sendCommand('find-next'))
        },
        {
          label: 'Find Previous',
          accelerator: isMac ? 'Cmd+Shift+G' : 'Shift+F3',
          click: withTab(() => sendCommand('find-previous'))
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reload(false) },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: reload(true) },
        hidden('F5', reload(false)),
        hidden('Ctrl+F5', reload(true)),
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: withTab((id) => tabs.zoom(id, 1))
        },
        hidden(
          'CmdOrCtrl+=',
          withTab((id) => tabs.zoom(id, 1))
        ),
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: withTab((id) => tabs.zoom(id, -1))
        },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: withTab((id) => tabs.zoom(id, 0))
        },
        { type: 'separator' },
        {
          label: 'Toggle AI Panel',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => sendCommand('toggle-panel')
        },
        {
          label: 'Summary',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendCommand('panel-summary')
        },
        { label: 'Chat', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendCommand('panel-chat') },
        {
          label: 'History',
          accelerator: isMac ? 'Cmd+Y' : 'Ctrl+H',
          click: () => sendCommand('panel-history')
        },
        {
          label: 'Downloads',
          accelerator: isMac ? 'Cmd+Alt+L' : 'Ctrl+J',
          click: () => sendCommand('panel-downloads')
        },
        {
          label: 'Bookmarks Bar',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => settings.update({ bookmarksBar: !settings.get().bookmarksBar })
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'View Page Source',
          accelerator: isMac ? 'Alt+Cmd+U' : 'Ctrl+U',
          click: withTab((id) => void tabs.viewSource(id))
        },
        {
          label: 'Developer Tools (Page)',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: withTab((id) => tabs.webContents(id).toggleDevTools())
        },
        ...(isDev
          ? ([
              {
                label: 'Developer Tools (UI)',
                click: () => currentWin()?.webContents.toggleDevTools()
              }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Page',
          accelerator: 'CmdOrCtrl+D',
          click: withTab((id) => {
            const info = tabs.get(id)
            if (!info || !/^https?:/.test(info.url)) return
            db.toggleBookmark(info.url, info.title)
            bookmarksChanged()
          })
        },
        {
          label: 'Show All Bookmarks',
          accelerator: isMac ? 'Cmd+Alt+B' : 'Ctrl+Shift+O',
          click: () => tabs.openPage('bookmarks')
        }
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withTab((id) => tabs.back(id)) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withTab((id) => tabs.forward(id)) },
        // ⌥←/→ move by word in text fields on macOS, so they are Back/Forward only elsewhere.
        ...(isMac
          ? []
          : [
              hidden(
                'Alt+Left',
                withTab((id) => tabs.back(id))
              ),
              hidden(
                'Alt+Right',
                withTab((id) => tabs.forward(id))
              )
            ]),
        { type: 'separator' },
        {
          label: 'Show All History',
          click: () => sendCommand('panel-history')
        }
      ]
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => tabs.activateRelative(1) },
        {
          label: 'Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => tabs.activateRelative(-1)
        },
        hidden(isMac ? 'Cmd+Alt+Right' : 'Ctrl+PageDown', () => tabs.activateRelative(1)),
        hidden(isMac ? 'Cmd+Alt+Left' : 'Ctrl+PageUp', () => tabs.activateRelative(-1)),
        ...(isMac
          ? [
              hidden('Cmd+Shift+]', () => tabs.activateRelative(1)),
              hidden('Cmd+Shift+[', () => tabs.activateRelative(-1))
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Duplicate Tab',
          click: () => tabs.activeTabId !== null && tabs.duplicate(tabs.activeTabId)
        },
        {
          label: 'Mute / Unmute Tab',
          click: withTab((id) => tabs.toggleMute(id))
        },
        { type: 'separator' },
        ...tabNumbers
      ]
    },
    // On Windows/Linux the standard Window menu adds "Close" on Ctrl+W, which is Close Tab here.
    isMac ? { role: 'windowMenu' } : { label: 'Window', submenu: [{ role: 'minimize' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** A private window's pages: in memory only, no ad-block lists, no saved permissions. */
function incognitoSession(): Electron.Session {
  const ses = session.fromPartition(`incognito-${++incognitoCount}`)
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
  // Harmless permissions (clipboard write, fullscreen, pointer lock) behave as in a normal window,
  // so the page looks like an ordinary browser; anything that would need a prompt is denied.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALWAYS_ALLOWED.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALWAYS_ALLOWED.has(permission))
  downloads.attach(ses)
  return ses
}

/**
 * Open a browser window. The first one restores the last session; later ones (⌘N) start with a
 * new tab. An incognito window has its own in-memory session and never touches history.
 */
function createWindow(opts: { incognito?: boolean; restore?: boolean } = {}): WindowCtx {
  const incognito = Boolean(opts.incognito)
  const s = settings.get()
  nativeTheme.themeSource = s.theme
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: 'Agentic Browser',
    backgroundColor: incognito || nativeTheme.shouldUseDarkColors ? '#16171a' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  // The UI window never navigates or opens windows on its own.
  w.webContents.on('will-navigate', (event, url) => {
    if (!(isDev && isTrustedUiUrl(url))) event.preventDefault()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const t = new TabManager(
    w,
    () => settings.get().searchEngine,
    incognito ? incognitoSession() : browsingSession()
  )
  const ctx: WindowCtx = { win: w, tabs: t, incognito }
  windows.set(w.webContents.id, ctx)
  lastFocused = ctx
  w.on('focus', () => {
    lastFocused = ctx
  })
  t.on('changed', (list) => {
    sendToRenderer(w, 'tabs:updated', list)
    updateTitle(ctx)
    if (!incognito) scheduleSessionSave()
  })
  t.on('closed', (tabId) => {
    searchAborts.get(tabId)?.abort()
    searchAborts.delete(tabId)
    assistant.onTabClosed(tabId)
    infobars.dismissTab(tabId)
  })
  // Closing a window's last tab closes the window; for the last window, the browser (and the
  // next launch starts with a new tab).
  t.on('empty', () => {
    if (windows.size > 1) {
      w.close()
      return
    }
    sessionCleared = true
    saveSession()
    app.quit()
  })
  t.on('created', ({ tabId, webContents }) => passwords.attach(tabId, webContents, incognito))
  t.on('find-result', (r) => sendToRenderer(w, 'find:result', r))
  t.on('save-as', ({ tabId, url }) => {
    downloads.expectSaveAs(url)
    if (tabs.has(tabId)) tabs.webContents(tabId).downloadURL(url)
  })
  t.on('external', ({ tabId, url }) => {
    const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
    const appName =
      scheme === 'mailto'
        ? 'your email app'
        : scheme === 'tel' || scheme.startsWith('facetime')
          ? 'your phone app'
          : scheme === 'sms'
            ? 'your messages app'
            : 'another app'
    const page = tabs.has(tabId) ? tabs.webContents(tabId).getURL() : ''
    let origin = ''
    try {
      origin = page ? new URL(page).host : ''
    } catch {
      /* ignore */
    }
    void infobars.request({ kind: 'external', tabId, origin, url, app: appName }).then((res) => {
      if (res.allow) void shell.openExternal(url).catch(() => undefined)
    })
  })
  t.on('unresponsive', ({ tabId, responsive }) => {
    if (responsive) {
      infobars.dismissTab(tabId, 'unresponsive')
      return
    }
    let origin = ''
    try {
      origin = new URL(tabs.webContents(tabId).getURL()).host
    } catch {
      /* ignore */
    }
    void infobars.request({ kind: 'unresponsive', tabId, origin }, 0).then((res) => {
      if (!res.allow || !tabs.has(tabId)) return
      // "Reload": the page's process is stuck, so restart it.
      const wc = tabs.webContents(tabId)
      wc.forcefullyCrashRenderer()
      wc.reload()
    })
  })
  t.on('login', ({ tabId, origin, realm, isProxy, callback }) => {
    void infobars.request({ kind: 'login', tabId, origin, realm, isProxy }, 0).then((res) => {
      if (res.allow && res.username !== undefined) callback(res.username, res.password ?? '')
      else callback()
    })
  })
  t.on('navigated', ({ tabId, url, title }) => {
    assistant.onTabNavigated(tabId, url)
    if (incognito) return
    db.addHistory(url, title)
    if (settings.get().historyIndex) scheduleHistoryIndex(tabId, url)
  })
  t.on('title-updated', ({ url, title }) => {
    if (!incognito && /^https?:/.test(url)) db.updateHistoryTitle(url, title)
  })
  t.on('selection', (sel) => sendToRenderer(w, 'ui:selection', sel))
  t.on('compare', (c) => sendToRenderer(w, 'ui:compare-tabs', c))

  // Back/forward mouse buttons (Windows, Linux) and three-finger swipes (macOS).
  w.on('app-command', (_e, cmd) => {
    const id = t.activeTabId
    if (id === null || t.isAi(id)) return
    if (cmd === 'browser-backward') t.back(id)
    else if (cmd === 'browser-forward') t.forward(id)
  })
  w.on('swipe', (_e, direction) => {
    const id = t.activeTabId
    if (id === null || t.isAi(id)) return
    if (direction === 'right') t.back(id)
    else if (direction === 'left') t.forward(id)
  })

  w.once('ready-to-show', () => w.show())
  const uiId = w.webContents.id
  // Remember the tabs before the last window (and its tabs) goes away.
  w.on('close', () => {
    if (windows.size === 1) {
      saveSession()
      sessionFrozen = true
    }
  })
  w.on('closed', () => {
    const closed = windows.get(uiId)
    windows.delete(uiId)
    if (closed) for (const tab of closed.tabs.list()) assistant.onTabClosed(tab.id)
    // Sign-in popups must not keep the app running without a browser window.
    if (windows.size === 0) app.quit()
    else if (!incognito) scheduleSessionSave()
  })
  void w.loadURL(rendererUrl())

  const saved = opts.restore && settings.get().startup === 'restore' ? savedSession() : null
  if (saved) t.restore(saved.tabs, saved.active)
  else t.create()
  return ctx
}

// ------------------------------------------------------------------ IPC handlers

function handlers(): InvokeHandlers {
  return {
    'tabs:list': () => tabs.list(),
    'tabs:create': ({ url, activate, focusAddress }) => {
      if (url) return navigateNew(url, activate ?? true)
      const id = tabs.create('about:blank', activate ?? true)
      if ((activate ?? true) && focusAddress !== false) sendCommand('focus-address')
      return id
    },
    'tabs:ask-ai': ({ tabId, query }) => tabs.askAi(tabId, query),
    'tabs:close': ({ tabId }) => tabs.close(tabId),
    'tabs:activate': ({ tabId }) => tabs.activate(tabId),
    'tabs:navigate': ({ tabId, input }) => tabs.navigate(tabId, input),
    'tabs:back': ({ tabId }) => tabs.back(tabId),
    'tabs:forward': ({ tabId }) => tabs.forward(tabId),
    'tabs:reload': ({ tabId }) => tabs.reload(tabId),
    'tabs:stop': ({ tabId }) => tabs.stop(tabId),
    'tabs:move': ({ tabId, toIndex }) => tabs.move(tabId, toIndex),
    'tabs:context-menu': ({ tabId }) => tabs.tabMenu(tabId),
    'tabs:open-page': ({ page, tabId }) =>
      tabId !== undefined ? tabs.setPage(tabId, page) : tabs.openPage(page),
    'tabs:mute': ({ tabId }) => tabs.toggleMute(tabId),
    'tabs:zoom': ({ tabId, step }) => tabs.zoom(tabId, step),
    'tabs:snapshot': async ({ tabId }) => {
      if (!tabs.has(tabId)) return null
      try {
        const img = await tabs.webContents(tabId).capturePage()
        return img.isEmpty() ? null : img.toDataURL()
      } catch {
        return null
      }
    },
    'ui:content-bounds': ({ bounds, visible }) => tabs.setContentBounds(bounds, visible),
    'ui:focus-page': () => tabs.focusPage(),
    'ui:app-menu': ({ x, y }) => showAppMenu(x, y),
    'app:new-window': ({ incognito }) => {
      createWindow({ incognito })
    },
    'ui:window-info': () => ({ incognito: currentCtx()?.incognito ?? false }),
    'find:start': ({ tabId, text, forward, findNext }) => {
      tabs.find(tabId, text, forward, findNext)
      // Finding can move keyboard focus into the page; keep typing in the find bar.
      currentWin()?.webContents.focus()
    },
    'find:stop': ({ tabId, keepSelection }) => tabs.stopFind(tabId, keepSelection),
    'downloads:list': () => downloads.list(),
    'downloads:cancel': ({ id }) => downloads.cancel(id),
    'downloads:pause': ({ id }) => downloads.pause(id),
    'downloads:resume': ({ id }) => downloads.resume(id),
    'downloads:open': ({ id }) => downloads.open(id),
    'downloads:show': ({ id }) => downloads.show(id),
    'downloads:clear': () => downloads.clear(),
    'infobar:list': () => infobars.list(),
    'infobar:respond': (res) => infobars.respond(res),
    'permissions:list': () => db.listSitePermissions(),
    'permissions:clear': ({ origin }) => db.clearSitePermissions(origin),
    'search:results': ({ tabId, query }) => {
      // A tab's new search replaces its previous one; other tabs' searches queue behind it.
      searchAborts.get(tabId)?.abort()
      const controller = new AbortController()
      searchAborts.set(tabId, controller)
      return searchProvider.search(query, controller.signal).finally(() => {
        if (searchAborts.get(tabId) === controller) searchAborts.delete(tabId)
      })
    },
    'search:answer': ({ query, results, mode, sources, followUp }) => ({
      streamId: assistant.startSearchAnswer(query, results, mode, sources, followUp)
    }),
    'search:images': ({ results }) => assistant.searchImages(results),
    'search:suggest': ({ query }) => searchSuggestions(query),

    'settings:get': () => settings.get(),
    'settings:update': (patch) => settings.update(patch),

    'llm:status': () => provider.status(),
    'llm:hardware': async () => {
      let gpu = null
      if (provider instanceof LlamaCppProvider) {
        try {
          gpu = await provider.hardware()
        } catch (err) {
          log('warn', `GPU detection failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const hardware = systemInfo(gpu)
      return { hardware, recommendation: recommendModels(hardware) }
    },
    'llm:unload': () => provider.unloadAll(),
    'llm:restart': () => provider.restart(),

    'models:list': () => models.list(),
    'models:download': ({ modelId }) => models.download(modelId),
    'models:pause': ({ modelId }) => models.pause(modelId),
    'models:cancel': ({ modelId }) => models.cancel(modelId),
    'models:delete': async ({ modelId }) => {
      await provider.unloadAll().catch(() => undefined)
      if (settings.get().models.speech === modelId) speech.unload()
      await models.remove(modelId)
    },
    'models:import': async () => {
      const win = currentWin()
      if (!win) return null
      const res = await dialog.showOpenDialog(win, {
        title: 'Import a GGUF model',
        properties: ['openFile'],
        filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
      })
      const file = res.filePaths[0]
      if (res.canceled || !file) return null
      return models.importFile(file)
    },
    'models:open-folder': async () => {
      await shell.openPath(models.dir)
    },
    'models:disk': async () => {
      return { dir: models.dir, freeBytes: await freeDiskBytes(models.dir) }
    },

    'summary:start': (req) => ({ streamId: assistant.startSummary(req) }),
    'stream:cancel': ({ streamId }) => assistant.cancel(streamId),
    'agent:start': ({ tabId, goal, prior }) => {
      const runId = randomUUID()
      agent.start(runId, tabId, goal, prior)
      return { runId }
    },
    'agent:stop': ({ runId }) => agent.stop(runId),
    'speech:mic-access': async () => {
      if (process.platform !== 'darwin') return true
      if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
      return systemPreferences.askForMediaAccess('microphone')
    },
    'speech:transcribe': async ({ pcm16 }) => ({ text: await speech.transcribe(pcm16) }),
    'speech:warmup': () => speech.warmup(),
    'chat:send': (req) => ({ streamId: assistant.startChat(req) }),
    'chat:history': ({ tabId }) => assistant.history(tabId),
    'chat:clear': ({ tabId }) => assistant.clear(tabId),

    'history:list': ({ query, limit, offset }) => db.listHistory(query, limit ?? 300, offset ?? 0),
    'bookmarks:list': () => db.listBookmarks(),
    'passwords:list': () => ({ available: passwords.available, list: passwords.list() }),
    'passwords:delete': ({ origin, username }) => passwords.delete(origin, username),
    'history:ask': ({ question }) => ({ streamId: assistant.startHistoryAnswer(question) }),
    'history:index-info': () => ({ pages: db.historyIndexSize() }),
    'history:index-clear': () => db.clearHistoryIndex(),
    'bookmarks:toggle': ({ url, title }) => {
      const on = db.toggleBookmark(url, title)
      bookmarksChanged()
      return on
    },
    'bookmarks:delete': ({ id }) => {
      db.deleteBookmark(id)
      bookmarksChanged()
    },
    'bookmarks:rename': ({ id, title }) => {
      db.renameBookmark(id, title)
      bookmarksChanged()
    },
    'history:clear': () => db.clearHistory(),
    'history:suggest': ({ query }) => db.suggestHistory(query, 6),
    'history:delete': ({ id }) => db.deleteHistory(id),
    'browsing-data:clear': async () => {
      db.clearBrowsingData()
      const ses = browsingSession()
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache()
    },

    'clipboard:write': ({ text }) => clipboard.writeText(text),
    'file:export-markdown': async ({ suggestedName, content }) => {
      const win = currentWin()
      if (!win) return false
      const safe = suggestedName.replace(/[^\w\- .]+/g, '_').slice(0, 80) || 'summary'
      const res = await dialog.showSaveDialog(win, {
        defaultPath: join(app.getPath('downloads'), `${safe}.md`),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, content, 'utf8')
      return true
    }
  }
}

/**
 * DuckDuckGo's autocomplete for the New Tab search box. Fetched without cookies; any failure or a
 * slow answer just means no suggestions.
 */
/** Pages kept in the AI history index, and how often one page is re-read. */
const HISTORY_INDEX_CAP = 3000
const HISTORY_REINDEX_MS = 6 * 60 * 60_000

/** Index a visited page's text for "Ask about your history" once it has finished loading. */
function scheduleHistoryIndex(tabId: number, url: string): void {
  if (!/^https?:/.test(url)) return
  const last = db.historyIndexedAt(url)
  if (last !== null && Date.now() - last < HISTORY_REINDEX_MS) return
  let wc: Electron.WebContents
  try {
    wc = tabs.webContents(tabId)
  } catch {
    return
  }
  const run = (): void => {
    setTimeout(() => {
      if (wc.isDestroyed() || wc.getURL() !== url || !settings.get().historyIndex) return
      void extractPage(wc)
        .then((page) => {
          const body = page.markdown.trim()
          if (body.length > 200)
            db.indexHistoryPage(url, page.title, body.slice(0, 20_000), HISTORY_INDEX_CAP)
        })
        .catch(() => undefined)
    }, 1500)
  }
  if (wc.isLoading()) wc.once('did-stop-loading', run)
  else run()
}

/** The toolbar's ⋮ menu: every browser feature, reachable without shortcuts. */
function showAppMenu(x: number, y: number): void {
  const ctx = currentCtx()
  if (!ctx) return
  const active = ctx.tabs.activeTabId
  const info = active !== null ? ctx.tabs.get(active) : null
  const web = info !== null && info.ai === null && info.page === null && /^https?:/.test(info.url)
  const marked = web && db.listBookmarks().some((b) => b.url === info!.url)
  const bar = settings.get().bookmarksBar
  Menu.buildFromTemplate([
    { label: 'New Tab', click: () => ctx.tabs.create() },
    { label: 'New AI Tab', click: () => sendCommand('new-ai-tab') },
    { label: 'New Window', click: () => createWindow() },
    { label: 'New Incognito Window', click: () => createWindow({ incognito: true }) },
    { type: 'separator' },
    {
      label: marked ? 'Remove Bookmark' : 'Bookmark This Page',
      enabled: web,
      click: () => {
        if (!info) return
        db.toggleBookmark(info.url, info.title)
        bookmarksChanged()
      }
    },
    { label: 'Bookmarks', click: () => ctx.tabs.openPage('bookmarks') },
    {
      label: bar ? 'Hide Bookmarks Bar' : 'Show Bookmarks Bar',
      click: () => settings.update({ bookmarksBar: !bar })
    },
    { type: 'separator' },
    { label: 'History', click: () => ctx.tabs.openPage('history') },
    { label: 'Downloads', click: () => ctx.tabs.openPage('downloads') },
    { label: 'Passwords', click: () => sendCommand('settings-passwords') },
    { type: 'separator' },
    {
      label: 'Find in Page…',
      enabled: web,
      click: () => sendCommand('find')
    },
    { label: 'Print…', enabled: web, click: () => active !== null && ctx.tabs.print(active) },
    {
      label: 'Zoom',
      enabled: web,
      submenu: [
        { label: 'Zoom In', click: () => active !== null && ctx.tabs.zoom(active, 1) },
        { label: 'Zoom Out', click: () => active !== null && ctx.tabs.zoom(active, -1) },
        { label: 'Actual Size', click: () => active !== null && ctx.tabs.zoom(active, 0) }
      ]
    },
    { type: 'separator' },
    { label: 'Settings', click: () => sendCommand('open-settings') }
  ]).popup({ window: ctx.win, x: Math.round(x), y: Math.round(y) })
}

function bookmarksChanged(): void {
  broadcast('bookmarks:updated', db.listBookmarks())
}

async function searchSuggestions(query: string): Promise<string[]> {
  const q = query.trim()
  if (!q || !settings.get().searchSuggestions) return []
  try {
    const res = await sourceFetchSession().fetch(
      `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
      { signal: AbortSignal.timeout(2500) }
    )
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    const list = Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]) : []
    return list
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.slice(0, 200))
      .slice(0, 6)
  } catch {
    return []
  }
}

/** Open a new tab at a URL coming from the UI (e.g. a source link in an answer). */
function navigateNew(input: string, activate: boolean): number {
  const id = tabs.create('about:blank', activate)
  tabs.navigate(id, input)
  return id
}

// ------------------------------------------------------------------ lifecycle

app.on('second-instance', () => {
  const win = currentWin()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('web-contents-created', (_e, contents) => {
  // Defense in depth: no webview tags anywhere.
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

void app.whenReady().then(async () => {
  // Workers and frames that don't use a session's user agent fall back to this one. With the
  // "Electron/…" token left in, scripts see a different browser than the request headers say,
  // and bot checks (e.g. Cloudflare) loop forever.
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback)
  // The UI session gets one permission: the microphone, for the app's own window (speech to
  // text). Web pages live in a separate session with its own, stricter rules.
  const isOwnUi = (wc: Electron.WebContents | null): boolean => wc !== null && windows.has(wc.id)
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      (details.mediaTypes ?? []).every((t) => t === 'audio')
    cb(audioOnly && isOwnUi(wc))
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === 'media' && isOwnUi(wc)
  )

  const userData = app.getPath('userData')
  db = new AppDatabase(join(userData, 'agentic-browser.db'))
  settings = new SettingsStore(db)
  // The mock model is dev-only now (AB_LLM_PROVIDER=mock). A value saved by the old Settings
  // switch would leave the app without real inference and no way to turn it off, so reset it.
  if (settings.get().provider === 'mock') settings.update({ provider: 'llamacpp' })
  if (devEnv.AB_SKIP_ONBOARDING === '1' && !settings.get().onboardingComplete) {
    settings.update({ onboardingComplete: true, tourComplete: true })
  }
  models = new ModelManager(join(userData, 'models'))
  await models.init()
  models.on('change', (list) => broadcast('models:updated', list))

  // AB_MODEL_PATH: use this GGUF for summaries, chat and search answers (scripted runs).
  if (devEnv.AB_MODEL_PATH) {
    const entry = await models.importFile(devEnv.AB_MODEL_PATH)
    settings.update({ models: { ...settings.get().models, fast: entry.id } })
  }

  installProvider(createProvider())

  if (selfTestArg !== null) {
    await runSelfTest(selfTestArg)
    return
  }

  searchProvider = new DuckDuckGoBrowserSearch()
  speech = new SpeechService(
    () => {
      const id = settings.get().models.speech
      return id ? models.resolvePath(id) : null
    },
    // Its own setting: the summary language must not force how speech is recognised.
    () => settings.get().speechLanguage,
    (m) => log('info', m)
  )

  adBlocker = new AdBlocker(
    browsingSession(),
    app.isPackaged
      ? join(process.resourcesPath, 'filters')
      : join(__dirname, '..', '..', 'resources', 'filters'), // out/main -> project root
    join(userData, 'adblock-engine.bin'),
    (m) => log('info', m)
  )
  await adBlocker
    .setEnabled(settings.get().adBlocking)
    .catch((err: unknown) => log('warn', `Ad blocker unavailable: ${String(err)}`))

  agent = new AgentRunner({
    provider: () => provider,
    webContents: (id) => tabs.webContents(id),
    navigate: (id, url) => tabs.loadUrl(id, url),
    // A click may start a navigation a moment later: give it time to begin, then wait for it.
    waitForLoad: async (id) => {
      await new Promise((r) => setTimeout(r, 700))
      await tabs.ensureLoaded(id)
      await new Promise((r) => setTimeout(r, 300))
    },
    emit: (event) => broadcast('agent', event)
  })
  assistant = new AssistantService({
    provider: () => provider,
    db,
    settings: () => settings.get(),
    webContents: (id) => tabs.webContents(id),
    tab: (id) => tabs.get(id),
    ensureLoaded: (id) => tabs.ensureLoaded(id),
    emit: (event) => broadcast('stream', event),
    onLlmError: (err) => log('warn', `LLM error ${err.code}: ${err.message}`),
    fetch: (url, init) => sourceFetchSession().fetch(url, init)
  })

  settings.on('change', (next, patch) => {
    if (patch.theme) nativeTheme.themeSource = next.theme
    if (patch.adBlocking !== undefined) {
      void adBlocker
        .setEnabled(next.adBlocking)
        .catch((err: unknown) => log('warn', `Ad blocker: ${String(err)}`))
    }
    if (patch.provider !== undefined && effectiveProvider(next) !== provider.kind) {
      const old = provider
      installProvider(createProvider())
      void old.dispose()
    } else if (
      (patch.idleUnloadMinutes !== undefined || patch.gpu !== undefined) &&
      provider instanceof LlamaCppProvider
    ) {
      provider.configure({ idleUnloadMs: next.idleUnloadMinutes * 60_000, gpu: next.gpu })
    }
    if (
      (patch.models !== undefined || patch.contextSize !== undefined) &&
      provider instanceof LlamaCppProvider
    ) {
      provider.clearError()
    }
    broadcast('settings:updated', next)
  })

  infobars = new InfoBarService((list) => broadcast('infobars:updated', list))
  passwords = new PasswordManager(db, infobars)
  // Must be installed before any page loads: without a handler Electron grants everything.
  installPermissions(browsingSession(), db, infobars, (wc) => {
    for (const c of windows.values()) {
      const id = c.tabs.findByWebContents(wc)
      if (id !== null) return id
    }
    return null
  })
  downloads = new DownloadManager(
    browsingSession(),
    (list) => broadcast('downloads:updated', list),
    () => sendCommand('panel-downloads')
  )

  buildMenu()
  createWindow({ restore: true })

  registerIpc(
    (id) => windows.get(id)?.win ?? null,
    isTrustedUiUrl,
    handlers(),
    (w) => {
      ipcWindow = w
    }
  )

  if (screenshotsArg !== null) {
    const first = currentWin()!
    first.webContents.once('did-finish-load', () => {
      void runScreenshots(first, screenshotsArg, {
        openPage: (url) => tabs.loadUrl(tabs.activeTabId ?? tabs.create(), url),
        setTheme: (theme) => settings.update({ theme })
      })
        .catch((err: unknown) => process.stdout.write(`[screenshots] failed: ${String(err)}\n`))
        .finally(() => app.quit())
    })
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  saveSession()
  sessionFrozen = true
  speech?.dispose()
  assistant?.cancelAll()
  agent?.stopAll()
  models?.pauseAll()
  // A stuck model worker must not keep the app from quitting.
  void Promise.race([
    Promise.resolve(provider?.dispose()),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
    .catch(() => undefined)
    .finally(() => {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
      app.exit(0)
    })
})
