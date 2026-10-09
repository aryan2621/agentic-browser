import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type RendererApi
} from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

/**
 * Narrow, typed bridge. Only allow-listed channels are reachable; ipcRenderer itself is never
 * exposed. Every payload is validated again in the main process.
 */
const api: RendererApi = {
  invoke: ((channel: InvokeChannel, payload?: unknown) => {
    if (!invokeAllowed.has(channel))
      return Promise.reject(new Error(`Channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  }) as RendererApi['invoke'],
  on: ((channel: EventChannel, listener: (payload: unknown) => void) => {
    if (!eventAllowed.has(channel)) throw new Error(`Channel not allowed: ${channel}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }) as RendererApi['on'],
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
