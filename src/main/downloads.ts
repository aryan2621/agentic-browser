import { app, shell, type DownloadItem, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { DownloadInfo } from '@shared/types'

interface Entry {
  info: DownloadInfo
  item: DownloadItem | null
}

/** A free file name in `dir`: "file.pdf", then "file (1).pdf", "file (2).pdf", ... */
function uniquePath(dir: string, name: string, taken: Set<string>): string {
  const safe =
    basename(name)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'download'
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? safe : `${stem} (${i})${ext}`)
    if (!existsSync(candidate) && !taken.has(candidate)) return candidate
  }
}

/**
 * Downloads from web pages: saved straight to the Downloads folder (like Chrome's default),
 * or through a save dialog for "Save Image As…". The list lasts for this session.
 */
export class DownloadManager {
  private readonly entries = new Map<string, Entry>()
  private readonly saveAs = new Set<string>()
  private emitTimer: NodeJS.Timeout | null = null

  constructor(
    ses: Session,
    private readonly publish: (list: DownloadInfo[]) => void,
    private readonly onStarted: () => void
  ) {
    this.attach(ses)
  }

  /** Also track downloads from another session (an incognito window's). */
  attach(ses: Session): void {
    ses.on('will-download', (_e, item) => this.track(item))
  }

  /** The next download of this URL shows a save dialog. */
  expectSaveAs(url: string): void {
    this.saveAs.add(url)
  }

  list(): DownloadInfo[] {
    return [...this.entries.values()].map((e) => e.info).sort((a, b) => b.startedAt - a.startedAt)
  }

  private track(item: DownloadItem): void {
    const url = item.getURL()
    const dir = app.getPath('downloads')
    if (this.saveAs.delete(url)) {
      item.setSaveDialogOptions({ defaultPath: join(dir, item.getFilename()) })
    } else {
      const taken = new Set([...this.entries.values()].map((e) => e.info.path))
      item.setSavePath(uniquePath(dir, item.getFilename(), taken))
    }
    const id = randomUUID()
    const entry: Entry = {
      item,
      info: {
        id,
        filename: basename(item.getSavePath() || item.getFilename()),
        url,
        path: item.getSavePath(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now()
      }
    }
    this.entries.set(id, entry)
    const refresh = (): void => {
      const path = item.getSavePath()
      entry.info = {
        ...entry.info,
        path,
        filename: path ? basename(path) : entry.info.filename,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state:
          item.getState() === 'progressing'
            ? item.isPaused()
              ? 'paused'
              : 'progressing'
            : item.getState()
      }
      this.schedule()
    }
    item.on('updated', refresh)
    item.once('done', () => {
      refresh()
      entry.item = null
      // A cancelled save dialog leaves an entry with no file; drop it.
      if (entry.info.state === 'cancelled' && !entry.info.path) this.entries.delete(id)
      this.schedule()
    })
    this.schedule()
    this.onStarted()
  }

  cancel(id: string): void {
    this.entries.get(id)?.item?.cancel()
  }

  pause(id: string): void {
    const item = this.entries.get(id)?.item
    if (item && !item.isPaused()) item.pause()
  }

  resume(id: string): void {
    const item = this.entries.get(id)?.item
    if (item?.canResume()) item.resume()
  }

  async open(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (e?.info.state === 'completed') await shell.openPath(e.info.path)
  }

  show(id: string): void {
    const e = this.entries.get(id)
    if (e?.info.path) shell.showItemInFolder(e.info.path)
  }

  /** Remove finished downloads from the list (files stay on disk). */
  clear(): void {
    for (const [id, e] of this.entries) if (!e.item) this.entries.delete(id)
    this.schedule()
  }

  private schedule(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.publish(this.list())
    }, 200)
  }
}
