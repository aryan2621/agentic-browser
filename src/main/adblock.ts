import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from 'electron'
import { ElectronBlocker } from '@ghostery/adblocker-electron'

/**
 * Ad and tracker blocking for the browsing session (tabs, search mode). Uses the lists bundled
 * with the app (scripts/update-filters.mjs refreshes them; nothing is downloaded at runtime):
 * EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's lists. Three layers:
 * - network: requests to ad/tracker hosts are cancelled;
 * - cosmetic: leftover ad slots are hidden;
 * - scriptlets: small uBlock scripts neutralise ads that come from the site itself, such as
 *   YouTube video ads, which no host-based list can block.
 * The parsed engine is cached in userData for fast starts.
 */
export class AdBlocker {
  private blocker: ElectronBlocker | null = null
  private enabled = false
  private wanted = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly session: Session,
    private readonly listsDir: string,
    private readonly cacheFile: string,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Calls are serialized: a quick on/off/on while the lists load must not leave the session in
   * a state that differs from the last request.
   */
  setEnabled(on: boolean): Promise<void> {
    this.wanted = on
    const run = this.queue.then(() => this.apply())
    this.queue = run.catch(() => undefined)
    return run
  }

  private async apply(): Promise<void> {
    if (this.wanted && !this.blocker) this.blocker = await this.load()
    // Re-read after the load: a later call may have changed the wanted state meanwhile.
    const on = this.wanted
    if (on === this.enabled || !this.blocker) return
    if (on) this.blocker.enableBlockingInSession(this.session)
    else this.blocker.disableBlockingInSession(this.session)
    this.enabled = on
  }

  private async load(): Promise<ElectronBlocker> {
    const files = JSON.parse(await readFile(join(this.listsDir, 'lists.json'), 'utf8')) as string[]
    const lists = await Promise.all(files.map((f) => readFile(join(this.listsDir, f), 'utf8')))
    const resources = await readFile(join(this.listsDir, 'resources.json'), 'utf8')
    const text = lists.join('\n')
    const hash = createHash('sha256').update(text).update(resources).digest('hex').slice(0, 16)
    try {
      const cached = await readFile(this.cacheFile)
      if (cached.subarray(0, 16).toString('ascii') === hash) {
        return ElectronBlocker.deserialize(new Uint8Array(cached.subarray(16)))
      }
    } catch {
      /* no cache yet */
    }
    const started = Date.now()
    const blocker = ElectronBlocker.parse(text, {
      loadNetworkFilters: true,
      loadCosmeticFilters: true,
      loadExtendedSelectors: true,
      enableMutationObserver: true
    })
    // Scriptlets (e.g. YouTube ad removal) and redirect resources from uBlock Origin.
    blocker.updateResources(resources, hash)
    this.log(`Ad blocker: parsed filter lists in ${Date.now() - started} ms`)
    await writeFile(
      this.cacheFile,
      Buffer.concat([Buffer.from(hash, 'ascii'), Buffer.from(blocker.serialize())])
    ).catch(() => undefined)
    return blocker
  }
}
