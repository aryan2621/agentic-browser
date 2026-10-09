import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import TurndownService from 'turndown'
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
import type { PageContent } from '@shared/types'

/** Isolated world id used for our injected scripts, so pages cannot tamper with them. */
export const EXTRACT_WORLD_ID = 1001

const MAX_HTML_BYTES = 6 * 1024 * 1024
const MIN_ARTICLE_CHARS = 250

interface RawPage {
  html: string
  text: string
  title: string
  lang: string
  contentType: string
  selection: string
}

/**
 * Runs in the page (isolated world). Waits until the page is "settled": load event fired,
 * no new network resources and no DOM mutations for a quiet period, or a timeout.
 * This handles SPAs that render after load.
 */
const SETTLE_AND_CAPTURE = (quietMs: number, timeoutMs: number, maxHtml: number): string => `
(async () => {
  const start = performance.now();
  if (document.readyState !== 'complete') {
    await new Promise((r) => { addEventListener('load', r, { once: true }); setTimeout(r, ${timeoutMs}); });
  }
  await new Promise((resolve) => {
    let last = performance.now();
    let resources = performance.getEntriesByType('resource').length;
    const obs = new MutationObserver(() => { last = performance.now(); });
    obs.observe(document, { subtree: true, childList: true, characterData: true });
    const tick = () => {
      const n = performance.getEntriesByType('resource').length;
      if (n !== resources) { resources = n; last = performance.now(); }
      const now = performance.now();
      if (now - last >= ${quietMs} || now - start >= ${timeoutMs}) { obs.disconnect(); resolve(); }
      else setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
  let html = document.documentElement ? document.documentElement.outerHTML : '';
  if (html.length > ${maxHtml}) html = html.slice(0, ${maxHtml});
  return {
    html,
    text: document.body ? document.body.innerText : '',
    title: document.title || '',
    lang: (document.documentElement && document.documentElement.lang) || '',
    contentType: document.contentType || '',
    selection: String(window.getSelection() || '')
  };
})()
`

export async function capturePage(
  wc: WebContents,
  opts: { quietMs?: number; timeoutMs?: number } = {}
): Promise<RawPage> {
  const code = SETTLE_AND_CAPTURE(opts.quietMs ?? 600, opts.timeoutMs ?? 8000, MAX_HTML_BYTES)
  const result = (await wc.executeJavaScriptInIsolatedWorld(
    EXTRACT_WORLD_ID,
    [{ code }],
    false
  )) as RawPage | null
  if (!result) throw new Error('Could not read the page.')
  return result
}

export async function getSelectionText(wc: WebContents): Promise<string> {
  try {
    const s = (await wc.executeJavaScriptInIsolatedWorld(EXTRACT_WORLD_ID, [
      { code: 'String(window.getSelection() || "")' }
    ])) as string
    return s.trim()
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ html -> markdown

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_'
  })
  td.remove([
    'script',
    'style',
    'noscript',
    'iframe',
    'form',
    'button',
    'svg',
    'canvas',
    'video',
    'audio'
  ] as never)
  // Images add tokens without helping summaries; keep meaningful alt text only.
  td.addRule('images', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (node as HTMLElement).getAttribute('alt')?.trim()
      return alt && alt.length > 3 ? `[Image: ${alt}]` : ''
    }
  })
  // Keep link text, drop URLs (they are expensive and not useful for summarisation).
  td.addRule('links', {
    filter: 'a',
    replacement: (content) => content
  })
  return td
}

const BOILERPLATE_LINE = [
  /^(share|tweet|pin it|email)( (this|on|via)\b.*)?$/i,
  /^(advertisement|sponsored( content)?|ad)$/i,
  /^(subscribe|sign up)( (now|today|to our newsletter|for our newsletter))?\.?$/i,
  /^(accept( all)? cookies|we use cookies.*|cookie (settings|policy))$/i,
  /^(skip to (main )?content|back to top|scroll to top)$/i,
  /^(read more|continue reading|show more|load more)$/i,
  /^(related (articles|posts|stories)|recommended( for you)?|you may also like)$/i,
  /^(all rights reserved\.?|©.*)$/i,
  /^\|?\s*(-+\s*\|\s*)+-*\s*$/ // empty table separators
]

/** Remove common boilerplate lines, image-only lines and excess whitespace. */
export function stripBoilerplate(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '')
    const bare = line.replace(/^[#>*\-\s]+/, '').trim()
    if (bare && BOILERPLATE_LINE.some((re) => re.test(bare))) continue
    out.push(line)
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

export interface ProcessedHtml {
  title: string
  byline: string | null
  siteName: string | null
  lang: string | null
  markdown: string
  usedFallback: boolean
}

/**
 * Readability -> Turndown -> boilerplate stripping. Falls back to `innerText` when
 * Readability fails or yields too little content.
 */
export function htmlToMarkdown(
  html: string,
  url: string,
  fallbackText: string,
  fallbackTitle = ''
): ProcessedHtml {
  const virtualConsole = new VirtualConsole() // swallow CSS/script parse errors
  let article: ReturnType<Readability<string>['parse']> = null
  let docLang: string | null = null
  try {
    const dom = new JSDOM(html, { url, virtualConsole }) // scripts and subresources are NOT loaded
    docLang = dom.window.document.documentElement.lang || null
    article = new Readability(dom.window.document, { charThreshold: 300 }).parse()
    dom.window.close()
  } catch {
    article = null
  }

  if (article?.content && (article.textContent ?? '').trim().length >= MIN_ARTICLE_CHARS) {
    const markdown = stripBoilerplate(createTurndown().turndown(article.content))
    return {
      title: article.title || fallbackTitle,
      byline: article.byline ?? null,
      siteName: article.siteName ?? null,
      lang: article.lang || docLang,
      markdown,
      usedFallback: false
    }
  }
  return {
    title: article?.title || fallbackTitle,
    byline: null,
    siteName: null,
    lang: docLang,
    markdown: stripBoilerplate(fallbackText),
    usedFallback: true
  }
}

// ------------------------------------------------------------------ PDF

export async function pdfToMarkdown(
  data: Uint8Array,
  maxPages = 150
): Promise<{ title: string; markdown: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false })
  const doc = await task.promise
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as { Title?: string }
    const pages: string[] = []
    const n = Math.min(doc.numPages, maxPages)
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
      }
      pages.push(text.replace(/[ \t]+/g, ' ').trim())
      page.cleanup()
    }
    return { title: info.Title ?? '', markdown: pages.filter(Boolean).join('\n\n') }
  } finally {
    await task.destroy()
  }
}

function looksLikePdf(url: string, contentType: string): boolean {
  return contentType === 'application/pdf' || /\.pdf($|[?#])/i.test(url)
}

// ------------------------------------------------------------------ public API

/** Extract the current page of a tab as clean Markdown plus metadata. */
export async function extractPage(wc: WebContents): Promise<PageContent> {
  const url = wc.getURL()
  const raw = await capturePage(wc)

  if (looksLikePdf(url, raw.contentType)) {
    const res = await wc.session.fetch(url)
    if (!res.ok) throw new Error(`Could not download PDF (HTTP ${res.status}).`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const pdf = await pdfToMarkdown(bytes)
    const markdown = stripBoilerplate(pdf.markdown)
    return {
      url,
      title: pdf.title || raw.title || url.split('/').pop() || 'PDF document',
      byline: null,
      lang: null,
      siteName: null,
      markdown,
      contentHash: hashContent(markdown),
      isPdf: true,
      usedFallback: false
    }
  }

  const processed = htmlToMarkdown(raw.html, url, raw.text, raw.title)
  return {
    url,
    title: processed.title || raw.title || url,
    byline: processed.byline,
    lang: processed.lang || raw.lang || null,
    siteName: processed.siteName,
    markdown: processed.markdown,
    contentHash: hashContent(processed.markdown),
    isPdf: false,
    usedFallback: processed.usedFallback
  }
}
