import { randomUUID } from 'node:crypto'
import type { InfoBarRequest, InfoBarResponse, TabId } from '@shared/types'

type NewRequest = InfoBarRequest extends infer R
  ? R extends InfoBarRequest
    ? Omit<R, 'id'>
    : never
  : never

/** The user's answer; `explicit` is false when it timed out or the tab went away. */
export type InfoBarAnswer = InfoBarResponse & { explicit: boolean }

interface Pending {
  request: InfoBarRequest
  resolve: (res: InfoBarAnswer) => void
  timer: NodeJS.Timeout | null
}

/**
 * Prompts shown in the strip above a page (permissions, HTTP sign-in, external apps, a page
 * that stopped responding). Each request resolves once: when the user answers, the tab
 * closes or navigates away, or the timeout passes (which counts as "Block").
 */
export class InfoBarService {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly publish: (list: InfoBarRequest[]) => void) {}

  request(req: NewRequest, timeoutMs = 60_000): Promise<InfoBarAnswer> {
    const id = randomUUID()
    const request = { ...req, id } as InfoBarRequest
    return new Promise((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => this.respond({ id, allow: false }, false), timeoutMs)
          : null
      this.pending.set(id, { request, resolve, timer })
      this.emit()
    })
  }

  respond(res: InfoBarResponse, explicit = true): void {
    const p = this.pending.get(res.id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    this.pending.delete(res.id)
    p.resolve({ ...res, explicit })
    this.emit()
  }

  /** Dismiss (deny) every prompt for a tab, e.g. when it closes or leaves the page. */
  dismissTab(tabId: TabId, kind?: InfoBarRequest['kind']): void {
    for (const p of [...this.pending.values()]) {
      if (p.request.tabId === tabId && (!kind || p.request.kind === kind))
        this.respond({ id: p.request.id, allow: false }, false)
    }
  }

  list(): InfoBarRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  private emit(): void {
    this.publish(this.list())
  }
}
