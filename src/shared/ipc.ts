import type {
  AgentEvent,
  SavedPassword,
  Bookmark,
  LibraryPage,
  CompareTabsAction,
  ChatMessage,
  ChatRequest,
  ContentBounds,
  DownloadInfo,
  FindResult,
  HardwareInfo,
  HistoryEntry,
  InfoBarRequest,
  InfoBarResponse,
  LlmStatus,
  ModelEntry,
  ModelRecommendation,
  SelectionAction,
  Settings,
  SitePermission,
  StreamEvent,
  SummaryRequest,
  TabId,
  TabInfo,
  UiCommand,
  WebResult
} from './types'
import type { SearchAnswerModeId } from './searchModes'

/** Request/response channels (renderer -> main via ipcRenderer.invoke). */
export interface InvokeMap {
  'tabs:list': { req: void; res: TabInfo[] }
  /** `focusAddress: false` leaves focus to the New Tab page (⌘K). */
  'tabs:create': { req: { url?: string; activate?: boolean; focusAddress?: boolean }; res: TabId }
  /** Turn the tab into an AI tab answering `query` (a blank tab or an AI tab). */
  'tabs:ask-ai': { req: { tabId: TabId; query: string }; res: void }
  'tabs:close': { req: { tabId: TabId }; res: void }
  'tabs:activate': { req: { tabId: TabId }; res: void }
  /** Open (or switch to) the History / Downloads tab, or switch an open one's section. */
  'tabs:open-page': { req: { page: LibraryPage; tabId?: TabId }; res: void }
  'tabs:navigate': { req: { tabId: TabId; input: string }; res: void }
  'tabs:back': { req: { tabId: TabId }; res: void }
  'tabs:forward': { req: { tabId: TabId }; res: void }
  'tabs:reload': { req: { tabId: TabId }; res: void }
  'tabs:stop': { req: { tabId: TabId }; res: void }
  'tabs:move': { req: { tabId: TabId; toIndex: number }; res: void }
  /** Right-click menu for a tab (shown natively by the main process). */
  'tabs:context-menu': { req: { tabId: TabId }; res: void }
  'tabs:mute': { req: { tabId: TabId }; res: void }
  /** step: 1 zoom in, -1 zoom out, 0 reset to 100%. */
  'tabs:zoom': { req: { tabId: TabId; step: -1 | 0 | 1 }; res: void }
  /** A picture of the page (data URL), shown while UI covers the page area. */
  'tabs:snapshot': { req: { tabId: TabId }; res: string | null }
  'ui:content-bounds': { req: { bounds: ContentBounds; visible: boolean }; res: void }
  'ui:focus-page': { req: void; res: void }
  /** The toolbar's ⋮ menu (a native menu at the given point). */
  'ui:app-menu': { req: { x: number; y: number }; res: void }
  /** Open a new browser window, or an incognito one. */
  'app:new-window': { req: { incognito: boolean }; res: void }
  /** About the calling window: incognito windows keep no history and show a badge. */
  'ui:window-info': { req: void; res: { incognito: boolean } }

  'find:start': {
    req: { tabId: TabId; text: string; forward: boolean; findNext: boolean }
    res: void
  }
  'find:stop': { req: { tabId: TabId; keepSelection: boolean }; res: void }

  'downloads:list': { req: void; res: DownloadInfo[] }
  'downloads:cancel': { req: { id: string }; res: void }
  'downloads:pause': { req: { id: string }; res: void }
  'downloads:resume': { req: { id: string }; res: void }
  'downloads:open': { req: { id: string }; res: void }
  'downloads:show': { req: { id: string }; res: void }
  'downloads:clear': { req: void; res: void }

  'infobar:list': { req: void; res: InfoBarRequest[] }
  'infobar:respond': { req: InfoBarResponse; res: void }
  /** Saved sign-ins (no passwords), and whether the OS keychain can encrypt them. */
  'passwords:list': { req: void; res: { available: boolean; list: SavedPassword[] } }
  'passwords:delete': { req: { origin: string; username: string }; res: void }
  'permissions:list': { req: void; res: SitePermission[] }
  'permissions:clear': { req: { origin?: string }; res: void }

  'settings:get': { req: void; res: Settings }
  'settings:update': { req: Partial<Settings>; res: Settings }

  'llm:status': { req: void; res: LlmStatus }
  'llm:hardware': {
    req: void
    res: { hardware: HardwareInfo; recommendation: ModelRecommendation }
  }
  'llm:unload': { req: void; res: void }
  'llm:restart': { req: void; res: void }

  'models:list': { req: void; res: ModelEntry[] }
  'models:download': { req: { modelId: string }; res: void }
  'models:pause': { req: { modelId: string }; res: void }
  'models:cancel': { req: { modelId: string }; res: void }
  'models:delete': { req: { modelId: string }; res: void }
  'models:import': { req: void; res: ModelEntry | null }
  'models:open-folder': { req: void; res: void }
  'models:disk': { req: void; res: { dir: string; freeBytes: number } }

  'summary:start': { req: SummaryRequest; res: { streamId: string } }
  'stream:cancel': { req: { streamId: string }; res: void }

  'speech:mic-access': { req: void; res: boolean }
  'speech:transcribe': { req: { pcm16: ArrayBuffer }; res: { text: string } }
  'speech:warmup': { req: void; res: void }

  /** A tab's new search stops its previous one; other tabs' searches are queued, not stopped. */
  'search:results': { req: { tabId: TabId; query: string }; res: WebResult[] }
  'search:answer': {
    /** `sources` overrides the style's default number of results to read. */
    req: {
      query: string
      results: WebResult[]
      mode: SearchAnswerModeId
      sources?: number
      /** Ask a follow-up about the same sources (earlier Q&A, newest last). */
      followUp?: { thread: Array<{ question: string; answer: string }>; question: string }
    }
    res: { streamId: string }
  }
  /** Search suggestions for what's typed (empty when switched off in Settings). */
  'search:suggest': { req: { query: string }; res: string[] }
  'search:images': {
    req: { results: WebResult[] }
    res: Array<{ image: string; pageUrl: string; title: string }>
  }

  'chat:send': { req: ChatRequest; res: { streamId: string } }
  /** Run the local agent on a tab; its log arrives as 'agent' events. */
  'agent:start': {
    req: { tabId: TabId; goal: string; prior?: string[] }
    res: { runId: string }
  }
  'agent:stop': { req: { runId: string }; res: void }
  'chat:history': { req: { tabId: TabId }; res: ChatMessage[] }
  'chat:clear': { req: { tabId: TabId }; res: void }

  'history:list': { req: { query?: string; limit?: number; offset?: number }; res: HistoryEntry[] }
  'history:clear': { req: void; res: void }
  'bookmarks:list': { req: void; res: Bookmark[] }
  /** Answer a question from the indexed history (streamed like other answers). */
  'history:ask': { req: { question: string }; res: { streamId: string } }
  'history:index-info': { req: void; res: { pages: number } }
  'history:index-clear': { req: void; res: void }
  /** Bookmark a page or remove its bookmark; returns whether it is now bookmarked. */
  'bookmarks:toggle': { req: { url: string; title: string }; res: boolean }
  'bookmarks:delete': { req: { id: number }; res: void }
  'bookmarks:rename': { req: { id: number; title: string }; res: void }
  'history:suggest': { req: { query: string }; res: HistoryEntry[] }
  'history:delete': { req: { id: number }; res: void }
  /** History, cached summaries, page embeddings, cookies, site storage and cache. */
  'browsing-data:clear': { req: void; res: void }

  'clipboard:write': { req: { text: string }; res: void }
  'file:export-markdown': { req: { suggestedName: string; content: string }; res: boolean }
}

/** Push events (main -> renderer). */
export interface EventMap {
  'tabs:updated': TabInfo[]
  'llm:status': LlmStatus
  'models:updated': ModelEntry[]
  stream: StreamEvent
  'ui:command': UiCommand
  'ui:selection': SelectionAction
  'ui:compare-tabs': CompareTabsAction
  agent: AgentEvent
  'settings:updated': Settings
  'find:result': FindResult
  'downloads:updated': DownloadInfo[]
  'bookmarks:updated': Bookmark[]
  'infobars:updated': InfoBarRequest[]
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS = [
  'tabs:list',
  'tabs:create',
  'tabs:ask-ai',
  'tabs:close',
  'tabs:activate',
  'tabs:open-page',
  'tabs:navigate',
  'tabs:back',
  'tabs:forward',
  'tabs:reload',
  'tabs:stop',
  'tabs:move',
  'tabs:context-menu',
  'tabs:mute',
  'tabs:zoom',
  'tabs:snapshot',
  'ui:content-bounds',
  'ui:focus-page',
  'ui:app-menu',
  'app:new-window',
  'ui:window-info',
  'find:start',
  'find:stop',
  'downloads:list',
  'downloads:cancel',
  'downloads:pause',
  'downloads:resume',
  'downloads:open',
  'downloads:show',
  'downloads:clear',
  'infobar:list',
  'infobar:respond',
  'passwords:list',
  'passwords:delete',
  'permissions:list',
  'permissions:clear',
  'search:results',
  'speech:mic-access',
  'speech:transcribe',
  'speech:warmup',
  'search:answer',
  'search:suggest',
  'search:images',
  'settings:get',
  'settings:update',
  'llm:status',
  'llm:hardware',
  'llm:unload',
  'llm:restart',
  'models:list',
  'models:download',
  'models:pause',
  'models:cancel',
  'models:delete',
  'models:import',
  'models:open-folder',
  'models:disk',
  'summary:start',
  'stream:cancel',
  'chat:send',
  'agent:start',
  'agent:stop',
  'chat:history',
  'chat:clear',
  'history:list',
  'history:clear',
  'bookmarks:list',
  'history:ask',
  'history:index-info',
  'history:index-clear',
  'bookmarks:toggle',
  'bookmarks:delete',
  'bookmarks:rename',
  'history:suggest',
  'history:delete',
  'browsing-data:clear',
  'clipboard:write',
  'file:export-markdown'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'tabs:updated',
  'llm:status',
  'models:updated',
  'stream',
  'ui:command',
  'ui:selection',
  'ui:compare-tabs',
  'agent',
  'settings:updated',
  'find:result',
  'downloads:updated',
  'bookmarks:updated',
  'infobars:updated'
] as const satisfies readonly EventChannel[]

/** The API exposed to the renderer as `window.api`. */
export interface RendererApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeMap[C]['req'] extends void ? [] : [InvokeMap[C]['req']]
  ): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
  platform: string
}
