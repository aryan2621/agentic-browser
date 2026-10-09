import type { Settings } from './types'

export type SearchEngine = Settings['searchEngine']

const SEARCH_ENGINES: Record<SearchEngine, { name: string; template: string }> = {
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' }
}

export const SEARCH_ENGINE_NAMES: Record<SearchEngine, string> = {
  duckduckgo: SEARCH_ENGINES.duckduckgo.name,
  google: SEARCH_ENGINES.google.name,
  bing: SEARCH_ENGINES.bing.name,
  brave: SEARCH_ENGINES.brave.name
}

export function searchUrl(engine: SearchEngine, query: string): string {
  return SEARCH_ENGINES[engine].template.replace('%s', encodeURIComponent(query.trim()))
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
// Hosts may use any script ("münchen.de", "例子.测试") or punycode TLDs ("xn--p1ai").
const HOST_LIKE_RE =
  /^(localhost|\[[0-9a-fA-F:]+\]|(\d{1,3}\.){3}\d{1,3}|([\p{L}\p{N}-]+\.)+(\p{L}{2,}|xn--[a-z0-9-]+))(:\d{1,5})?([/?#].*)?$/iu

/** Non-web schemes typed in the address bar are addresses (opened or explained), not searches. */
const ADDRESS_SCHEMES = new Set([
  'about:',
  'chrome:',
  'file:',
  'view-source:',
  'mailto:',
  'tel:',
  'sms:',
  'facetime:'
])

const PRIVATE_HOST_RE =
  /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^./:]+\.local\b)/i

/**
 * Turn address-bar input into a URL. Anything that does not look like a URL becomes a search.
 * Returns the URL to load.
 */
export function normalizeAddressInput(rawInput: string, engine: SearchEngine): string {
  const input = rawInput.trim()
  if (!input) return 'about:blank'
  if (input === 'about:blank') return input

  if (SCHEME_RE.test(input) && !/^[a-zA-Z0-9.-]+:\d+/.test(input)) {
    // Explicit scheme. Only web schemes are loadable from the address bar.
    try {
      const url = new URL(input)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
      if (ADDRESS_SCHEMES.has(url.protocol)) return input
    } catch {
      /* fall through to search */
    }
    return searchUrl(engine, input)
  }

  if (!/\s/.test(input) && HOST_LIKE_RE.test(input)) {
    const isLocal = PRIVATE_HOST_RE.test(input)
    try {
      return new URL(`${isLocal ? 'http' : 'https'}://${input}`).toString()
    } catch {
      return searchUrl(engine, input)
    }
  }
  return searchUrl(engine, input)
}

/** The input is an address (URL, host, scheme), not a search query. */
export function looksLikeAddress(input: string): boolean {
  const t = input.trim()
  return t.length > 0 && normalizeAddressInput(t, 'duckduckgo') !== searchUrl('duckduckgo', t)
}

/** Display form of a URL for the address bar. */
export function displayUrl(url: string): string {
  if (url === 'about:blank') return ''
  return url
}

export function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
