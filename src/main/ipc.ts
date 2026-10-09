import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from '@shared/ipc'
import { MAX_CHAT_TABS } from '@shared/defaults'
import { SettingsPatchSchema } from './settings'
import { MAX_SPEECH_BYTES } from './speech/service'
import { MAX_SEARCH_SOURCES, MIN_SEARCH_SOURCES, SEARCH_ANSWER_MODE_IDS } from '@shared/searchModes'

const tabId = z.number().int().nonnegative()
const bounds = z.object({
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
  width: z.number().finite().min(0).max(100_000),
  height: z.number().finite().min(0).max(100_000)
})
const webResult = z.object({
  title: z.string().max(500),
  url: z
    .string()
    .url()
    .max(4096)
    .regex(/^https?:/i),
  snippet: z.string().max(2000)
})
const empty = z.undefined().or(z.null()).optional()

/** Runtime schema for every invoke channel's payload. */
export const INVOKE_SCHEMAS = {
  'tabs:list': empty,
  'tabs:create': z.object({
    url: z.string().max(8192).optional(),
    activate: z.boolean().optional(),
    focusAddress: z.boolean().optional()
  }),
  'tabs:ask-ai': z.object({ tabId, query: z.string().trim().min(1).max(500) }),
  'tabs:close': z.object({ tabId }),
  'tabs:activate': z.object({ tabId }),
  'tabs:open-page': z.object({
    page: z.enum(['history', 'bookmarks', 'downloads', 'settings']),
    tabId: tabId.optional()
  }),
  'tabs:navigate': z.object({ tabId, input: z.string().max(8192) }),
  'tabs:back': z.object({ tabId }),
  'tabs:forward': z.object({ tabId }),
  'tabs:reload': z.object({ tabId }),
  'tabs:stop': z.object({ tabId }),
  'tabs:move': z.object({ tabId, toIndex: z.number().int().min(0).max(10_000) }),
  'tabs:context-menu': z.object({ tabId }),
  'tabs:mute': z.object({ tabId }),
  'tabs:zoom': z.object({ tabId, step: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }),
  'tabs:snapshot': z.object({ tabId }),
  'ui:content-bounds': z.object({ bounds, visible: z.boolean() }),
  'ui:focus-page': empty,
  'ui:app-menu': z.object({
    x: z.number().finite().min(0).max(100_000),
    y: z.number().finite().min(0).max(100_000)
  }),
  'app:new-window': z.object({ incognito: z.boolean() }),
  'ui:window-info': empty,
  'find:start': z.object({
    tabId,
    text: z.string().max(1000),
    forward: z.boolean(),
    findNext: z.boolean()
  }),
  'find:stop': z.object({ tabId, keepSelection: z.boolean() }),
  'downloads:list': empty,
  'downloads:cancel': z.object({ id: z.string().uuid() }),
  'downloads:pause': z.object({ id: z.string().uuid() }),
  'downloads:resume': z.object({ id: z.string().uuid() }),
  'downloads:open': z.object({ id: z.string().uuid() }),
  'downloads:show': z.object({ id: z.string().uuid() }),
  'downloads:clear': empty,
  'infobar:list': empty,
  'infobar:respond': z.object({
    id: z.string().uuid(),
    allow: z.boolean(),
    username: z.string().max(1000).optional(),
    password: z.string().max(1000).optional(),
    never: z.boolean().optional()
  }),
  'passwords:list': empty,
  'passwords:delete': z.object({ origin: z.string().max(500), username: z.string().max(500) }),
  'permissions:list': empty,
  'permissions:clear': z.object({ origin: z.string().max(500).optional() }),
  'search:results': z.object({ tabId, query: z.string().trim().min(1).max(500) }),
  'speech:mic-access': empty,
  'speech:warmup': empty,
  'speech:transcribe': z.object({
    pcm16: z
      .instanceof(ArrayBuffer)
      .refine((b) => b.byteLength > 0 && b.byteLength <= MAX_SPEECH_BYTES, 'Recording too long')
  }),
  'search:answer': z.object({
    query: z.string().trim().min(1).max(500),
    results: z.array(webResult).max(20),
    mode: z.enum(SEARCH_ANSWER_MODE_IDS),
    sources: z.number().int().min(MIN_SEARCH_SOURCES).max(MAX_SEARCH_SOURCES).optional(),
    followUp: z
      .object({
        thread: z
          .array(z.object({ question: z.string().max(4000), answer: z.string().max(20_000) }))
          .max(20),
        question: z.string().trim().min(1).max(1000)
      })
      .optional()
  }),
  'search:suggest': z.object({ query: z.string().max(200) }),
  'search:images': z.object({ results: z.array(webResult).max(20) }),
  'settings:get': empty,
  'settings:update': SettingsPatchSchema,
  'llm:status': empty,
  'llm:hardware': empty,
  'llm:unload': empty,
  'llm:restart': empty,
  'models:list': empty,
  'models:download': z.object({ modelId: z.string().min(1).max(200) }),
  'models:pause': z.object({ modelId: z.string().min(1).max(200) }),
  'models:cancel': z.object({ modelId: z.string().min(1).max(200) }),
  'models:delete': z.object({ modelId: z.string().min(1).max(200) }),
  'models:import': empty,
  'models:open-folder': empty,
  'models:disk': empty,
  'summary:start': z.object({
    tabId,
    mode: z.enum(['summary', 'detailed']),
    focus: z.string().max(1000).optional(),
    selectionOnly: z.boolean().optional(),
    selectionText: z.string().max(100_000).optional(),
    regenerate: z.boolean().optional()
  }),
  'stream:cancel': z.object({ streamId: z.string().uuid() }),
  'chat:send': z.object({
    tabId,
    message: z.string().trim().min(1).max(4000),
    includeSelection: z.boolean(),
    tabIds: z.array(tabId).max(MAX_CHAT_TABS).optional()
  }),
  'agent:start': z.object({
    tabId,
    goal: z.string().trim().min(1).max(1000),
    prior: z.array(z.string().max(1000)).max(60).optional()
  }),
  'agent:stop': z.object({ runId: z.string().uuid() }),
  'chat:history': z.object({ tabId }),
  'chat:clear': z.object({ tabId }),
  'history:list': z.object({
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    offset: z.number().int().min(0).optional()
  }),
  'history:clear': empty,
  'bookmarks:list': empty,
  'history:ask': z.object({ question: z.string().trim().min(1).max(1000) }),
  'history:index-info': empty,
  'history:index-clear': empty,
  'bookmarks:toggle': z.object({
    url: z
      .string()
      .url()
      .max(4096)
      .refine((u) => /^https?:/i.test(u)),
    title: z.string().max(1000)
  }),
  'bookmarks:delete': z.object({ id: z.number().int().nonnegative() }),
  'bookmarks:rename': z.object({
    id: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(300)
  }),
  'history:suggest': z.object({ query: z.string().max(500) }),
  'history:delete': z.object({ id: z.number().int().nonnegative() }),
  'browsing-data:clear': empty,
  'clipboard:write': z.object({ text: z.string().max(1_000_000) }),
  'file:export-markdown': z.object({
    suggestedName: z.string().max(200),
    content: z.string().max(5_000_000)
  })
} satisfies Record<InvokeChannel, z.ZodType>

export type InvokeHandlers = {
  [C in InvokeChannel]: (
    payload: InvokeMap[C]['req']
  ) => Promise<InvokeMap[C]['res']> | InvokeMap[C]['res']
}

/**
 * Register all handlers. Every call is checked to come from the app's own UI frame
 * (not from a web page) and its payload is validated with zod before reaching the handler.
 */
export function registerIpc(
  windowOf: (senderId: number) => BrowserWindow | null,
  isTrustedUrl: (url: string) => boolean,
  handlers: InvokeHandlers,
  /** Called with the calling window just before (and null just after) a handler starts. */
  onCall: (win: BrowserWindow | null) => void
): void {
  const verify = (event: IpcMainInvokeEvent): BrowserWindow => {
    const frame = event.senderFrame
    const win = windowOf(event.sender.id)
    if (!win || !frame || frame !== win.webContents.mainFrame || !isTrustedUrl(frame.url)) {
      throw new Error('Blocked IPC from untrusted sender.')
    }
    return win
  }
  for (const channel of Object.keys(INVOKE_SCHEMAS) as InvokeChannel[]) {
    const schema = INVOKE_SCHEMAS[channel] as z.ZodType
    const handler = handlers[channel] as (payload: unknown) => unknown
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const win = verify(event)
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        throw new Error(
          `Invalid payload for ${channel}: ${parsed.error.issues.map((i) => i.message).join('; ')}`
        )
      }
      // The handler's synchronous start knows which window called (its tabs, its dialogs).
      onCall(win)
      try {
        return handler(parsed.data)
      } finally {
        onCall(null)
      }
    })
  }
}

export function sendToRenderer<C extends EventChannel>(
  win: BrowserWindow | null,
  channel: C,
  payload: EventMap[C]
): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}
