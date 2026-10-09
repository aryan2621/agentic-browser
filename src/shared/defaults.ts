import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  onboardingComplete: false,
  tourComplete: false,
  acceptedLicenses: [],
  theme: 'system',
  searchEngine: 'duckduckgo',
  provider: 'llamacpp',
  models: { fast: null, embed: null, speech: null },
  contextSize: 8192,
  idleUnloadMinutes: 10,
  gpu: 'auto',
  summaryLanguage: '',
  speechLanguage: '',
  useRetrieval: true,
  searchAnswerMode: 'quick',
  searchSources: null,
  adBlocking: true,
  searchSuggestions: false,
  startup: 'restore',
  sidePanelWidth: 380,
  bookmarksBar: true,
  historyIndex: false
}

export const SIDE_PANEL_MIN = 300
export const SIDE_PANEL_MAX = 720
export const CONTEXT_SIZE_MIN = 2048
export const CONTEXT_SIZE_MAX = 32768

/** Most tabs one chat answer reads, so each still gets a useful share of the context. */
export const MAX_CHAT_TABS = 8
