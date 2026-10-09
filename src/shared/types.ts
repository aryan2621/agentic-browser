import type { SearchAnswerModeId } from './searchModes'

// Shared domain + IPC types. Imported by main, preload and renderer (types only at runtime boundaries).

export type TabId = number

export interface TabInfo {
  id: TabId
  title: string
  url: string
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  /** The page is playing sound. */
  audible: boolean
  muted: boolean
  /** Page zoom in percent (100 = default). */
  zoom: number
  /** The page failed to load or crashed; `url` is the address that failed. */
  failed: boolean
  /** An AI tab: the question it answers (shown instead of a web page). Null for web tabs. */
  ai: string | null
  /** A built-in History / Downloads page (shown by the UI). Null for web and AI tabs. */
  page: LibraryPage | null
}

export type LibraryPage = 'history' | 'bookmarks' | 'downloads'

export interface FindResult {
  tabId: TabId
  matches: number
  /** 1-based index of the highlighted match (0 when none). */
  active: number
}

/**
 * A prompt shown in the strip above the page: a site permission, an HTTP sign-in, opening an
 * external app, or a page that stopped responding.
 */
export type InfoBarRequest = {
  id: string
  tabId: TabId | null
  origin: string
} & (
  | { kind: 'permission'; permission: string; label: string }
  | { kind: 'login'; realm: string; isProxy: boolean }
  | { kind: 'external'; url: string; app: string }
  | { kind: 'unresponsive' }
  | { kind: 'save-password'; username: string; update: boolean }
)

/** A saved sign-in as the UI sees it (never the password). */
export interface SavedPassword {
  origin: string
  username: string
  updatedAt: number
}

export interface InfoBarResponse {
  id: string
  allow: boolean
  username?: string
  password?: string
  /** "Never for this site" (save-password prompts). */
  never?: boolean
}

export interface DownloadInfo {
  id: string
  filename: string
  url: string
  path: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  startedAt: number
}

export interface SitePermission {
  origin: string
  permission: string
  allow: boolean
}

export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

// ---------------------------------------------------------------- LLM

export type ModelRole = 'fast' | 'embed' | 'speech'

export type GpuBackend = 'metal' | 'cuda' | 'vulkan' | false

export interface HardwareInfo {
  totalRamBytes: number
  freeRamBytes: number
  cpuModel: string
  cpuCores: number
  platform: string
  arch: string
  gpu: GpuBackend
  gpuDeviceNames: string[]
  vramTotalBytes: number
  vramFreeBytes: number
  /** Unified memory (Apple Silicon) – VRAM is shared with RAM. */
  unifiedMemory: boolean
}

export interface ModelRecommendation {
  fast: string
  embed: string
  speech: string
  tier: 'insufficient' | 'small' | 'standard'
  reason: string
}

export type LicenseId = 'llama3.2' | 'llama3.1' | 'apache-2.0' | 'mit'

export interface CatalogModel {
  id: string
  name: string
  description: string
  roles: ModelRole[]
  url: string
  fileName: string
  sizeBytes: number
  sha256: string
  license: LicenseId
  /** Approximate RAM needed to run with an 8k context. */
  minRamBytes: number
  quantization: string
}

export type ModelDownloadState =
  | { kind: 'absent' }
  | {
      kind: 'downloading'
      receivedBytes: number
      totalBytes: number
      bytesPerSecond: number
      etaSeconds: number | null
    }
  | { kind: 'paused'; receivedBytes: number; totalBytes: number }
  | { kind: 'verifying'; totalBytes: number }
  | { kind: 'ready'; path: string; sizeBytes: number }
  | { kind: 'error'; message: string; receivedBytes: number }

export interface ModelEntry {
  id: string
  name: string
  description: string
  roles: ModelRole[]
  license: LicenseId | 'unknown'
  sizeBytes: number
  quantization: string
  imported: boolean
  /** RAM the catalog says it needs (null for imported files). */
  minRamBytes: number | null
  state: ModelDownloadState
}

export type ProviderState = 'idle' | 'loading' | 'ready' | 'generating' | 'error'

export interface LlmStatus {
  provider: 'llamacpp' | 'mock'
  state: ProviderState
  /** Model currently resident for text generation. */
  activeModel: string | null
  embedModelLoaded: boolean
  gpu: GpuBackend
  gpuLayers: number | null
  contextSize: number | null
  workerMemoryBytes: number | null
  vramUsedBytes: number | null
  lastTokensPerSecond: number | null
  error: LlmErrorInfo | null
}

export type LlmErrorCode =
  | 'NO_MODEL'
  | 'MODEL_MISSING'
  | 'MODEL_CORRUPT'
  | 'MODEL_LOAD_FAILED'
  | 'CONTEXT_TOO_SMALL'
  | 'OUT_OF_MEMORY'
  | 'WORKER_CRASHED'
  | 'ABORTED'
  | 'GENERATION_FAILED'

export interface LlmErrorInfo {
  code: LlmErrorCode
  message: string
  /** Recovery actions the UI can offer. */
  actions: Array<'open-models' | 'retry' | 'reduce-context' | 'redownload' | 'use-smaller-model'>
}

// ---------------------------------------------------------------- Settings

export type SummaryMode = 'summary' | 'detailed'

export interface Settings {
  onboardingComplete: boolean
  tourComplete: boolean
  acceptedLicenses: LicenseId[]
  theme: 'system' | 'light' | 'dark'
  searchEngine: 'duckduckgo' | 'google' | 'bing' | 'brave'
  provider: 'llamacpp' | 'mock'
  models: { fast: string | null; embed: string | null; speech: string | null }
  contextSize: number
  idleUnloadMinutes: number
  gpu: 'auto' | 'off'
  summaryLanguage: string
  /** Voice input language (Whisper code); empty = detect automatically. */
  speechLanguage: string
  useRetrieval: boolean
  /** Default result style for Search mode's AI result (see shared/searchModes.ts). */
  searchAnswerMode: SearchAnswerModeId
  /** How many results an AI answer reads; null = each style's own number. */
  searchSources: number | null
  /** Block ads and trackers in web pages (bundled EasyList + EasyPrivacy). */
  adBlocking: boolean
  /** Also suggest DuckDuckGo searches while typing on the New Tab page (sends what you type). Off
   *  by default; history suggestions are always shown. */
  searchSuggestions: boolean
  /** On launch: reopen the previous session's tabs, or start with one new tab. */
  startup: 'restore' | 'newtab'
  sidePanelWidth: number
  /** Show the bookmarks bar under the toolbar (when there are bookmarks). */
  bookmarksBar: boolean
  /** Keep the text of visited pages (locally) so the AI can answer questions about history. */
  historyIndex: boolean
}

// ---------------------------------------------------------------- Summaries / chat

export interface PageContent {
  url: string
  title: string
  byline: string | null
  lang: string | null
  siteName: string | null
  markdown: string
  contentHash: string
  isPdf: boolean
  usedFallback: boolean
}

export interface SummaryRequest {
  tabId: TabId
  mode: SummaryMode
  /** Optional "Focus on…" text: what the summary should pay most attention to. */
  focus?: string
  selectionOnly?: boolean
  selectionText?: string
  regenerate?: boolean
}

export type StreamEvent =
  | { kind: 'start'; streamId: string; cached: boolean; title?: string; url?: string }
  | { kind: 'progress'; streamId: string; message: string }
  | { kind: 'token'; streamId: string; text: string }
  | {
      kind: 'done'
      streamId: string
      text: string
      tokensPerSecond: number | null
      cached: boolean
      /** The answer hit its length limit and may end mid-sentence. */
      truncated?: boolean
    }
  | { kind: 'error'; streamId: string; error: LlmErrorInfo }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  /** The tab whose side-panel chat this is (the conversation belongs to it). */
  tabId: TabId
  message: string
  includeSelection: boolean
  /** Answer from these web tabs instead of only `tabId`'s page (at most MAX_CHAT_TABS). */
  tabIds?: TabId[]
}

// ---------------------------------------------------------------- History

export interface Bookmark {
  id: number
  url: string
  title: string
  createdAt: number
}

export interface HistoryEntry {
  id: number
  url: string
  title: string
  visitedAt: number
}

// ---------------------------------------------------------------- UI commands (main -> renderer)

export type UiCommand =
  | 'focus-address'
  /** ⌘K: a new tab with AI preselected in its search box. */
  | 'new-ai-tab'
  /** ⌘R in an AI tab: run its search again. */
  | 'reload-ai'
  | 'toggle-panel'
  | 'open-settings'
  /** Settings → Passwords (from the ⋮ menu). */
  | 'settings-passwords'
  | 'panel-summary'
  | 'panel-chat'
  | 'panel-history'
  | 'panel-downloads'
  | 'find'
  | 'find-next'
  | 'find-previous'

/** One line of the agent's visible log. `done`, `stopped` and `error` end the run. */
export interface AgentEvent {
  runId: string
  kind: 'status' | 'step' | 'done' | 'stopped' | 'error'
  text: string
}

/** "Compare with AI": compare `tabIds` (the first is the clicked tab) in that tab's chat. */
export interface CompareTabsAction {
  tabId: TabId
  tabIds: TabId[]
}

export interface SelectionAction {
  kind: 'summarize' | 'ask'
  tabId: TabId
  text: string
}

// ---------------------------------------------------------------- Search mode

export interface WebResult {
  title: string
  url: string
  snippet: string
}
