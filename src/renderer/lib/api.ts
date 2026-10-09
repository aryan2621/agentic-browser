import { useEffect, useRef, useState } from 'react'
import type { EventChannel, EventMap } from '@shared/ipc'
import type {
  Bookmark,
  DownloadInfo,
  InfoBarRequest,
  LlmStatus,
  ModelEntry,
  Settings,
  TabInfo
} from '@shared/types'

export const api = window.api

/** Subscribe to a main-process event for the lifetime of the component. */
export function useIpcEvent<C extends EventChannel>(
  channel: C,
  handler: (payload: EventMap[C]) => void
): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => api.on(channel, (p) => ref.current(p)), [channel])
}

export function useTabs(): TabInfo[] {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  useEffect(() => {
    void api.invoke('tabs:list').then(setTabs)
  }, [])
  useIpcEvent('tabs:updated', setTabs)
  return tabs
}

export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
  }, [])
  useIpcEvent('settings:updated', setSettings)
  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettings(await api.invoke('settings:update', patch))
  }
  return [settings, update]
}

export function useLlmStatus(): LlmStatus | null {
  const [status, setStatus] = useState<LlmStatus | null>(null)
  useEffect(() => {
    void api.invoke('llm:status').then(setStatus)
  }, [])
  useIpcEvent('llm:status', setStatus)
  return status
}

export function useModels(): ModelEntry[] {
  const [models, setModels] = useState<ModelEntry[]>([])
  useEffect(() => {
    void api.invoke('models:list').then(setModels)
  }, [])
  useIpcEvent('models:updated', setModels)
  return models
}

/** Downloads of this session; null until the first list arrives. */
export function useDownloads(): DownloadInfo[] | null {
  const [list, setList] = useState<DownloadInfo[] | null>(null)
  useEffect(() => {
    void api.invoke('downloads:list').then(setList)
  }, [])
  useIpcEvent('downloads:updated', setList)
  return list
}

/** Bookmarks, oldest first; null until the first list arrives. */
export function useBookmarks(): Bookmark[] | null {
  const [list, setList] = useState<Bookmark[] | null>(null)
  useEffect(() => {
    void api.invoke('bookmarks:list').then(setList)
  }, [])
  useIpcEvent('bookmarks:updated', setList)
  return list
}

/** Open prompts (permissions, sign-in, ...) for all tabs. */
export function useInfoBars(): InfoBarRequest[] {
  const [list, setList] = useState<InfoBarRequest[]>([])
  useEffect(() => {
    void api.invoke('infobar:list').then(setList)
  }, [])
  useIpcEvent('infobars:updated', setList)
  return list
}

export function openInNewTab(url: string): void {
  void api.invoke('tabs:create', { url, activate: true })
}
