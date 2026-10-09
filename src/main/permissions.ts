import { systemPreferences, type Session, type WebContents } from 'electron'
import type { TabId } from '@shared/types'
import type { AppDatabase } from './db'
import type { InfoBarService } from './infobars'

/** Granted without asking (as in Chrome). */
export const ALWAYS_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

/** Asked once per site; the answer is remembered. Everything else is denied. */
const ASK: Record<string, string> = {
  geolocation: 'know your location',
  notifications: 'show notifications',
  camera: 'use your camera',
  microphone: 'use your microphone',
  midi: 'use your MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard'
}

export const PERMISSION_LABELS: Record<string, string> = {
  geolocation: 'Location',
  notifications: 'Notifications',
  camera: 'Camera',
  microphone: 'Microphone',
  midi: 'MIDI devices',
  'clipboard-read': 'Clipboard'
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/** Electron's "media" permission split into the camera and microphone the user sees. */
function expand(permission: string, mediaTypes: string[] | undefined): string[] {
  if (permission !== 'media') return [permission]
  const out: string[] = []
  if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.includes('video')) out.push('camera')
  if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.includes('audio')) out.push('microphone')
  return out
}

/** macOS also asks the user once for the app itself; a "no" there blocks every site. */
async function osAllows(kinds: string[]): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  for (const kind of kinds) {
    if (kind !== 'camera' && kind !== 'microphone') continue
    if (systemPreferences.getMediaAccessStatus(kind) === 'granted') continue
    if (!(await systemPreferences.askForMediaAccess(kind))) return false
  }
  return true
}

/**
 * Site permission prompts for the web-page session: known permissions are asked in the
 * infobar and remembered per origin; anything unknown is denied.
 */
export function installPermissions(
  ses: Session,
  db: AppDatabase,
  infobars: InfoBarService,
  tabOf: (wc: WebContents) => TabId | null
): void {
  const inFlight = new Map<string, Promise<boolean>>()

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return callback(true)
    const kinds = expand(
      permission,
      'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
    )
    const origin = originOf(details.requestingUrl || wc.getURL())
    if (!origin || kinds.some((k) => !(k in ASK))) return callback(false)

    const stored = kinds.map((k) => db.getSitePermission(origin, k))
    if (stored.some((v) => v === false)) return callback(false)
    if (stored.every((v) => v === true)) {
      void osAllows(kinds).then(callback, () => callback(false))
      return
    }

    // One prompt per site and permission at a time; repeated requests share the answer.
    const key = `${origin}|${kinds.join('+')}`
    let answer = inFlight.get(key)
    if (!answer) {
      const label = kinds.map((k) => ASK[k]).join(' and ')
      answer = infobars
        .request({
          kind: 'permission',
          tabId: tabOf(wc),
          origin,
          permission: kinds.join('+'),
          label
        })
        .then(async (res) => {
          // A timeout or closed tab is not a decision; only explicit answers are remembered.
          if (res.explicit) for (const k of kinds) db.setSitePermission(origin, k, res.allow)
          return res.allow && (await osAllows(kinds))
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, answer)
    }
    void answer.then(callback, () => callback(false))
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return true
    const origin = originOf(requestingOrigin)
    if (!origin) return false
    const kinds =
      permission === 'media'
        ? [details.mediaType === 'video' ? 'camera' : 'microphone']
        : [permission]
    return kinds.every((k) => k in ASK && db.getSitePermission(origin, k) === true)
  })
}
