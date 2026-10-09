import { randomUUID } from 'node:crypto'
import { safeStorage, type WebContents } from 'electron'
import type { SavedPassword, TabId } from '@shared/types'
import type { AppDatabase } from './db'
import type { InfoBarService } from './infobars'

/**
 * Saves sign-ins and fills them in again. Passwords are encrypted with the OS keychain
 * (`safeStorage`: macOS Keychain, Windows DPAPI, Linux secret store) before they reach the
 * database, and are never sent to the UI.
 *
 * Pages get no preload, so a script in an isolated world (invisible to the page) notices a
 * submitted password and reports it through a console message tagged with a secret per-launch
 * nonce. The user always confirms in a prompt before anything is saved. Only https pages (and
 * localhost) take part, and incognito windows never save.
 */

/** Separate isolated world: the page's scripts can't read or fake this code. */
const PASSWORD_WORLD_ID = 1003

function captureScript(nonce: string): string {
  return `(() => {
  if (window.__abPwCapture) return
  window.__abPwCapture = true
  let last = ''
  const grab = () => {
    const pw = [...document.querySelectorAll('input[type=password]')].find((e) => e.value)
    if (!pw) return
    const scope = pw.form || document
    const inputs = [...scope.querySelectorAll('input')]
    let user = ''
    for (let i = inputs.indexOf(pw) - 1; i >= 0; i--) {
      const e = inputs[i]
      const t = (e.getAttribute('type') || 'text').toLowerCase()
      if (['text', 'email', 'tel'].includes(t) && e.value) { user = e.value; break }
    }
    const msg = JSON.stringify({ u: user.slice(0, 200), p: pw.value.slice(0, 500) })
    if (msg === last) return
    last = msg
    console.debug(${JSON.stringify(nonce)} + msg)
  }
  document.addEventListener('submit', grab, true)
  document.addEventListener('click', (e) => {
    const t = e.target
    if (t && t.closest && t.closest('button, input[type=submit], [role=button]')) grab()
  }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') grab() }, true)
})()`
}

function fillScript(username: string, password: string): string {
  return `(() => {
  const pw = document.querySelector('input[type=password]')
  if (!pw || pw.value) return false
  const set = (e, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v)
    e.dispatchEvent(new Event('input', { bubbles: true }))
    e.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const scope = pw.form || document
  const inputs = [...scope.querySelectorAll('input')]
  for (let i = inputs.indexOf(pw) - 1; i >= 0; i--) {
    const e = inputs[i]
    const t = (e.getAttribute('type') || 'text').toLowerCase()
    if (['text', 'email', 'tel'].includes(t)) { if (!e.value) set(e, ${JSON.stringify(username)}); break }
  }
  set(pw, ${JSON.stringify(password)})
  return true
})()`
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null
    return u.origin
  } catch {
    return null
  }
}

export class PasswordManager {
  private readonly nonce = `__ab_pw_${randomUUID()}__`
  /** One prompt per origin + user at a time. */
  private readonly asking = new Set<string>()

  constructor(
    private readonly db: AppDatabase,
    private readonly infobars: InfoBarService
  ) {}

  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  list(): SavedPassword[] {
    return this.db.listPasswords()
  }

  delete(origin: string, username: string): void {
    this.db.deletePassword(origin, username)
  }

  /** Watch a tab's pages: fill saved sign-ins and offer to save new ones. */
  attach(tabId: TabId, wc: WebContents, incognito: boolean): void {
    wc.on('dom-ready', () => {
      const origin = originOf(wc.getURL())
      if (!origin) return
      if (!incognito && this.available)
        void wc
          .executeJavaScriptInIsolatedWorld(PASSWORD_WORLD_ID, [
            { code: captureScript(this.nonce) }
          ])
          .catch(() => undefined)
      this.fill(wc, origin)
      // Sign-in forms rendered by scripts appear a moment later.
      setTimeout(() => {
        if (!wc.isDestroyed() && originOf(wc.getURL()) === origin) this.fill(wc, origin)
      }, 1500)
    })
    if (incognito) return
    wc.on('console-message', (...args: unknown[]) => {
      // Electron passes the details on the event object (older versions: as arguments).
      const ev = args[0] as { message?: string } | undefined
      const message = typeof ev?.message === 'string' ? ev.message : String(args[2] ?? '')
      if (!message.startsWith(this.nonce)) return
      const origin = originOf(wc.getURL())
      if (!origin) return
      try {
        const { u, p } = JSON.parse(message.slice(this.nonce.length)) as { u: string; p: string }
        if (typeof u === 'string' && typeof p === 'string' && p) this.offer(tabId, origin, u, p)
      } catch {
        /* not ours */
      }
    })
  }

  private fill(wc: WebContents, origin: string): void {
    if (!this.available) return
    const saved = this.db.getPasswords(origin)[0]
    if (!saved) return
    let password: string
    try {
      password = safeStorage.decryptString(saved.secret)
    } catch {
      return
    }
    void wc
      .executeJavaScriptInIsolatedWorld(PASSWORD_WORLD_ID, [
        { code: fillScript(saved.username, password) }
      ])
      .catch(() => undefined)
  }

  private offer(tabId: TabId, origin: string, username: string, password: string): void {
    if (!this.available || this.db.isPasswordNever(origin)) return
    const existing = this.db.getPasswords(origin).find((s) => s.username === username)
    if (existing) {
      try {
        if (safeStorage.decryptString(existing.secret) === password) return
      } catch {
        /* re-save below */
      }
    }
    const key = `${origin}\n${username}`
    if (this.asking.has(key)) return
    this.asking.add(key)
    void this.infobars
      .request({
        kind: 'save-password',
        tabId,
        origin: new URL(origin).host,
        username,
        update: existing !== undefined
      })
      .then((res) => {
        if (res.allow) {
          this.db.savePassword(origin, username, safeStorage.encryptString(password))
        } else if (res.never) {
          this.db.setPasswordNever(origin)
        }
      })
      .finally(() => this.asking.delete(key))
  }
}
