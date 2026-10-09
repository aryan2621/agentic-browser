import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeImage, WebContentsView, type BrowserWindow, type NativeImage } from 'electron'

/**
 * `--screenshots=<dir>`: walk through the main UI states and save a PNG of each, for reviewing the
 * layout (clutter, overlap, both themes) without clicking through by hand. Development tool only.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Capture the window including its child browser views (a plain capture only has the UI). */
async function captureWindow(win: BrowserWindow): Promise<NativeImage> {
  const base = await win.webContents.capturePage()
  const scale = base.getSize().width / win.getContentBounds().width
  const size = base.getSize()
  const canvas = Buffer.from(base.toBitmap())
  for (const child of win.contentView.children) {
    if (!(child instanceof WebContentsView) || !child.getVisible()) continue
    if (child.webContents === win.webContents) continue
    const b = child.getBounds()
    if (b.width <= 0 || b.height <= 0) continue
    const img = (await child.webContents.capturePage()).resize({
      width: Math.round(b.width * scale),
      height: Math.round(b.height * scale)
    })
    const bmp = img.toBitmap()
    const w = img.getSize().width
    const h = img.getSize().height
    const ox = Math.round(b.x * scale)
    const oy = Math.round(b.y * scale)
    for (let y = 0; y < h && oy + y < size.height; y++) {
      const rowLen = Math.min(w, size.width - ox) * 4
      if (rowLen <= 0) break
      bmp.copy(canvas, ((oy + y) * size.width + ox) * 4, y * w * 4, y * w * 4 + rowLen)
    }
  }
  return nativeImage.createFromBitmap(canvas, { width: size.width, height: size.height })
}

interface Ui {
  /** Run JS in the UI renderer. */
  js: <T = unknown>(code: string) => Promise<T>
  waitFor: (code: string, timeoutMs?: number) => Promise<boolean>
  shot: (name: string) => Promise<void>
}

function makeUi(win: BrowserWindow, dir: string): Ui {
  const js = <T>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true) as Promise<T>
  return {
    js,
    waitFor: async (code, timeoutMs = 60_000) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        if (await js<boolean>(`!!(${code})`).catch(() => false)) return true
        await sleep(250)
      }
      return false
    },
    shot: async (name) => {
      await sleep(400)
      const img = await captureWindow(win)
      await writeFile(join(dir, `${name}.png`), img.toPNG())
      process.stdout.write(`[screenshots] ${name}.png\n`)
    }
  }
}

/** Helpers injected into the UI page: click by text/label, type into React inputs. */
const HELPERS = `
window.__ab = {
  byText(sel, text) { return [...document.querySelectorAll(sel)].find(e => (e.textContent || '').trim().startsWith(text)) },
  click(sel, text) { const e = text ? this.byText(sel, text) : document.querySelector(sel); if (e) e.click(); return !!e },
  type(sel, value) {
    const e = document.querySelector(sel); if (!e) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value').set;
    setter.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); return true
  },
  submit(sel) { const f = document.querySelector(sel); if (f) f.requestSubmit(); return !!f }
};
true
`

export async function runScreenshots(
  win: BrowserWindow,
  dir: string,
  steps: { openPage: (url: string) => void; setTheme: (theme: 'light' | 'dark') => void }
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const ui = makeUi(win, dir)
  await ui.waitFor('document.querySelector(".toolbar")')
  await ui.js(HELPERS)

  for (const theme of ['light', 'dark'] as const) {
    steps.setTheme(theme)
    await sleep(600)
    const t = (name: string): string => `${theme}-${name}`

    // ---- browse mode: page + summary panel
    await ui.js(`__ab.click('.mode-switch button', 'Browse')`)
    steps.openPage('https://en.wikipedia.org/wiki/Lion')
    await ui.waitFor(
      `(document.querySelector('.tab.active .tab-title')?.textContent || '').includes('Lion')`
    )
    await sleep(2500)
    await ui.js(`__ab.click('.panel-tab', 'Summary')`)
    await ui.shot(t('01-browse-summary-idle'))
    await ui.js(`__ab.click('[data-testid=summarize]')`)
    await ui.waitFor(`document.querySelector('.output-actions')`, 240_000)
    await ui.shot(t('02-browse-summary-done'))

    // ---- chat
    await ui.js(`__ab.click('.panel-tab', 'Chat')`)
    await sleep(300)
    await ui.shot(t('03-browse-chat-empty'))
    await ui.js(`__ab.type('.chat-input textarea', 'How long do lions live?')`)
    await ui.js(
      `(() => { const b = [...document.querySelectorAll('.chat-input button')].pop(); b && b.click() })()`
    )
    await ui.waitFor(
      `document.querySelectorAll('.msg.assistant').length > 0 && !document.querySelector('.chat-input .btn.danger')`,
      240_000
    )
    await ui.shot(t('04-browse-chat-answer'))

    // ---- history
    await ui.js(`__ab.click('.panel-tab', 'History')`)
    await ui.shot(t('05-browse-history'))

    // ---- search mode
    await ui.js(`__ab.click('.mode-switch button', 'Search')`)
    await sleep(300)
    await ui.shot(t('06-search-landing'))
    await ui.js(`__ab.type('.composer textarea', 'what is a lion')`)
    await ui.js(`__ab.submit('.composer')`)
    await ui.waitFor(
      `document.querySelector('.search-answer-actions .btn')?.textContent === 'Regenerate'`,
      300_000
    )
    await ui.shot(t('07-search-summary'))
    await ui.js(`__ab.click('.search-tab', 'Results')`)
    await ui.shot(t('08-search-results'))
    for (const [i, label] of ['Images', 'Videos', 'News', 'Maps'].entries()) {
      await ui.js(`__ab.click('.search-tab', '${label}')`)
      await sleep(4500)
      await ui.shot(t(`${String(9 + i).padStart(2, '0')}-search-${label.toLowerCase()}`))
    }
    await ui.js(`__ab.click('.search-tab', 'Summary')`)

    // ---- settings
    await ui.js(`__ab.click('.mode-switch button', 'Browse')`)
    await ui.js(`__ab.click('button[aria-label=Settings]')`)
    await sleep(500)
    await ui.shot(t('13-settings'))
    await ui.js(`__ab.click('.settings-nav button', 'Privacy')`)
    await ui.shot(t('14-settings-privacy'))
    await ui.js(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await ui.js(`__ab.click('[aria-label="Close settings"]')`)
    await sleep(300)
  }

  // ---- narrow window: the panel must still fit without wrapping into a mess
  steps.setTheme('light')
  win.setSize(900, 700)
  await sleep(800)
  await ui.js(`__ab.click('.panel-tab', 'Summary')`)
  await ui.shot('light-15-narrow-window')
}
