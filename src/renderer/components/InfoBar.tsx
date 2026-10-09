import { useState } from 'react'
import type { InfoBarRequest, InfoBarResponse } from '@shared/types'
import { api } from '../lib/api'
import { IconLock, IconWarning } from './Icons'

function respond(res: InfoBarResponse): void {
  void api.invoke('infobar:respond', res)
}

/** One prompt in the strip above the page. */
function InfoBarItem({ req }: { req: InfoBarRequest }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const site = req.origin.replace(/^https?:\/\//, '') || 'This page'

  if (req.kind === 'login') {
    return (
      <form
        className="info-bar"
        aria-label="Sign in"
        onSubmit={(e) => {
          e.preventDefault()
          respond({ id: req.id, allow: true, username, password })
        }}
      >
        <IconLock />
        <span className="info-text">
          {req.isProxy ? 'The proxy' : site} asks you to sign in
          {req.realm ? ` (“${req.realm}”)` : ''}. Your details are not saved.
        </span>
        <input
          aria-label="Username"
          placeholder="Username"
          autoFocus
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          aria-label="Password"
          placeholder="Password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" type="submit">
          Sign in
        </button>
        <button className="btn" type="button" onClick={() => respond({ id: req.id, allow: false })}>
          Cancel
        </button>
      </form>
    )
  }

  if (req.kind === 'save-password') {
    const text = req.update
      ? `Update the saved password for ${req.username || 'this account'} on ${site}?`
      : `Save the password for ${req.username || 'this account'} on ${site}?`
    return (
      <div className="info-bar" role="alertdialog" aria-label={text}>
        <IconWarning />
        <span className="info-text">
          {text} <span className="hint">Encrypted with your system keychain.</span>
        </span>
        <button className="btn primary" onClick={() => respond({ id: req.id, allow: true })}>
          {req.update ? 'Update' : 'Save'}
        </button>
        <button className="btn" onClick={() => respond({ id: req.id, allow: false })}>
          Not now
        </button>
        {!req.update && (
          <button
            className="btn subtle"
            onClick={() => respond({ id: req.id, allow: false, never: true })}
          >
            Never for this site
          </button>
        )}
      </div>
    )
  }

  const [text, allowLabel, denyLabel] =
    req.kind === 'permission'
      ? [`${site} wants to ${req.label}.`, 'Allow', 'Block']
      : req.kind === 'external'
        ? [`${site} wants to open ${req.app}.`, 'Open', 'Cancel']
        : [`${site} isn't responding.`, 'Reload page', 'Wait']

  return (
    <div className="info-bar" role="alertdialog" aria-label={text}>
      <IconWarning />
      <span className="info-text">{text}</span>
      <button className="btn primary" onClick={() => respond({ id: req.id, allow: true })}>
        {allowLabel}
      </button>
      <button className="btn" onClick={() => respond({ id: req.id, allow: false })}>
        {denyLabel}
      </button>
    </div>
  )
}

/** Prompts for the visible tab (and ones not tied to a tab, e.g. from a sign-in popup). */
export function InfoBars({ list, tabId }: { list: InfoBarRequest[]; tabId: number | null }) {
  const shown = list.filter((r) => r.tabId === null || r.tabId === tabId)
  if (shown.length === 0) return null
  return (
    <div className="info-bars">
      {shown.map((r) => (
        <InfoBarItem key={r.id} req={r} />
      ))}
    </div>
  )
}
