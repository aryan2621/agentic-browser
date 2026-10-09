import { WebContentsView } from 'electron'
import type { WebResult } from '@shared/types'
import type { SearchProvider } from './search'
import { browsingSession } from './tabs'
import { EXTRACT_WORLD_ID } from './extract'

const MAX_RESULTS = 10
const TIMEOUT_MS = 15_000

/** Runs in the results page (isolated world): read the organic results, skipping ads. */
const READ_RESULTS = `
(() => Array.from(document.querySelectorAll('article[data-testid=result]')).map((a) => {
  const link = a.querySelector('a[data-testid=result-title-a]');
  const snippet = a.querySelector('[data-result=snippet]');
  return {
    title: link ? link.innerText.trim() : '',
    url: link ? link.href : '',
    snippet: snippet ? snippet.innerText.replace(/\\s+/g, ' ').trim() : ''
  };
}))()
`

/** Runs in the results page: is this DuckDuckGo's "are you a human" check instead of results? */
const IS_CHALLENGE = `
(() => Boolean(document.querySelector('.anomaly-modal__title, form#challenge-form')) ||
  /bots use DuckDuckGo too|select all squares containing/i.test(document.body ? document.body.innerText : ''))()
`

/** The page shows results for this query (not the previous search still on screen). */
function showsQuery(url: string, query: string): boolean {
  try {
    const q = new URL(url).searchParams.get('q') ?? ''
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
    return norm(q) === norm(query)
  } catch {
    return false
  }
}

/**
 * DuckDuckGo results read from its normal page in a hidden browser view. Its no-JavaScript
 * endpoint challenges automated requests, while the real page in the browsing session behaves like
 * any user's search. Searches run one at a time in a single reused view.
 */
export class DuckDuckGoBrowserSearch implements SearchProvider {
  readonly name = 'DuckDuckGo'
  private view: WebContentsView | null = null
  private queue: Promise<unknown> = Promise.resolve()

  search(query: string, signal?: AbortSignal): Promise<WebResult[]> {
    const run = this.queue.then(() => this.run(query, signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async run(query: string, signal?: AbortSignal): Promise<WebResult[]> {
    this.view ??= new WebContentsView({
      webPreferences: {
        session: browsingSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    const wc = this.view.webContents
    if (signal?.aborted) throw new Error('Stopped.')
    void wc
      .loadURL(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`)
      .catch(() => undefined)
    const start = Date.now()
    let results: WebResult[] = []
    let stableTicks = 0
    while (Date.now() - start < TIMEOUT_MS) {
      if (signal?.aborted) throw new Error('Stopped.')
      await new Promise((r) => setTimeout(r, 300))
      // Until the new page has committed, the previous search's results are still on screen.
      if (!showsQuery(wc.getURL(), query)) continue
      if (wc.isLoading() && Date.now() - start < 3000) continue
      if (await this.isChallenge(wc)) {
        throw new Error(
          'DuckDuckGo wants to check that you are a person. Open duckduckgo.com in a tab, complete its check, then search again.'
        )
      }
      const found = await this.read(wc)
      // Results render progressively; wait until the count stops growing.
      if (found.length > 0 && found.length === results.length) stableTicks++
      else stableTicks = 0
      results = found
      if (results.length >= MAX_RESULTS || stableTicks >= 2) break
    }
    if (results.length === 0) throw new Error('No results found (or the search page did not load).')
    return results.slice(0, MAX_RESULTS)
  }

  private async isChallenge(wc: WebContentsView['webContents']): Promise<boolean> {
    try {
      return Boolean(
        await wc.executeJavaScriptInIsolatedWorld(EXTRACT_WORLD_ID, [{ code: IS_CHALLENGE }], false)
      )
    } catch {
      return false
    }
  }

  private async read(wc: WebContentsView['webContents']): Promise<WebResult[]> {
    try {
      const raw = (await wc.executeJavaScriptInIsolatedWorld(
        EXTRACT_WORLD_ID,
        [{ code: READ_RESULTS }],
        false
      )) as WebResult[] | null
      const seen = new Set<string>()
      return (raw ?? []).filter((r) => {
        if (!r.title || !/^https?:\/\//.test(r.url) || seen.has(r.url)) return false
        if (new URL(r.url).hostname.endsWith('duckduckgo.com')) return false // ads/redirects
        seen.add(r.url)
        return true
      })
    } catch {
      return []
    }
  }
}
