import { EventEmitter } from 'node:events'
import { z } from 'zod'
import {
  CONTEXT_SIZE_MAX,
  CONTEXT_SIZE_MIN,
  DEFAULT_SETTINGS,
  SIDE_PANEL_MAX,
  SIDE_PANEL_MIN
} from '@shared/defaults'
import type { Settings } from '@shared/types'
import type { AppDatabase } from './db'
import {
  MAX_SEARCH_SOURCES,
  MIN_SEARCH_SOURCES,
  SEARCH_ANSWER_MODE_IDS,
  migrateSearchAnswerModeId
} from '@shared/searchModes'

export const SettingsSchema = z.object({
  onboardingComplete: z.boolean(),
  tourComplete: z.boolean(),
  acceptedLicenses: z.array(z.enum(['llama3.2', 'llama3.1', 'apache-2.0', 'mit'])),
  theme: z.enum(['system', 'light', 'dark']),
  searchEngine: z.enum(['duckduckgo', 'google', 'bing', 'brave']),
  provider: z.enum(['llamacpp', 'mock']),
  models: z.object({
    fast: z.string().max(200).nullable(),
    embed: z.string().max(200).nullable(),
    // Added later: settings saved before speech existed have no key, which means "none".
    speech: z.string().max(200).nullable().default(null)
  }),
  contextSize: z.number().int().min(CONTEXT_SIZE_MIN).max(CONTEXT_SIZE_MAX),
  idleUnloadMinutes: z.number().int().min(0).max(240),
  gpu: z.enum(['auto', 'off']),
  summaryLanguage: z.string().max(40),
  speechLanguage: z.string().max(8),
  useRetrieval: z.boolean(),
  searchAnswerMode: z.enum(SEARCH_ANSWER_MODE_IDS),
  searchSources: z.number().int().min(MIN_SEARCH_SOURCES).max(MAX_SEARCH_SOURCES).nullable(),
  adBlocking: z.boolean(),
  searchSuggestions: z.boolean(),
  startup: z.enum(['restore', 'newtab']),
  sidePanelWidth: z.number().int().min(SIDE_PANEL_MIN).max(SIDE_PANEL_MAX),
  bookmarksBar: z.boolean(),
  historyIndex: z.boolean()
}) satisfies z.ZodType<Settings, unknown>

export const SettingsPatchSchema = SettingsSchema.partial()

export class SettingsStore extends EventEmitter<{ change: [Settings, Partial<Settings>] }> {
  private current: Settings

  constructor(private readonly db: AppDatabase) {
    super()
    this.current = this.load()
  }

  private load(): Settings {
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...this.db.getAllSettings() }
    merged.searchAnswerMode = migrateSearchAnswerModeId(merged.searchAnswerMode)
    // Validate key by key so one bad value never resets everything.
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      const field = SettingsSchema.shape[key]
      const parsed = field.safeParse(merged[key])
      out[key] = parsed.success ? parsed.data : DEFAULT_SETTINGS[key]
    }
    return out as unknown as Settings
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    const parsed = SettingsPatchSchema.parse(patch)
    const next = SettingsSchema.parse({ ...this.current, ...parsed })
    this.current = next
    this.db.setSettings(parsed as Record<string, unknown>)
    this.emit('change', next, parsed)
    return next
  }
}
