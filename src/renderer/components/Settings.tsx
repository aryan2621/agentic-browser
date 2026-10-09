import { useEffect, useRef, useState } from 'react'
import { CONTEXT_SIZE_MAX, CONTEXT_SIZE_MIN } from '@shared/defaults'
import type {
  SavedPassword,
  LicenseId,
  LlmStatus,
  ModelEntry,
  ModelRole,
  Settings as SettingsT,
  SitePermission
} from '@shared/types'
import { SEARCH_ENGINE_NAMES, type SearchEngine } from '@shared/url'
import { api, openInNewTab, useModels } from '../lib/api'
import { useBackdropClose } from '../lib/backdrop'
import { modelFits, useHardware } from '../lib/fit'
import { formatBytes, gpuLabel } from '../lib/format'
import { SEARCH_ANSWER_MODES } from '@shared/searchModes'
import { SPEECH_LANGUAGES } from '@shared/speechLanguages'
import { Dropdown } from './Dropdown'
import { IconClose } from './Icons'
import { LICENSES } from './licenses'
import { ModelActions, ModelProgress } from './ModelList'

/** Choices for Settings → Search → Sources to read (besides Automatic). */
const SOURCE_COUNTS = [3, 5, 8, 10]

const ENGINE_NOTES: Record<SearchEngine, string> = {
  duckduckgo: 'Private by default, no tracking.',
  google: 'Largest index.',
  bing: "Microsoft's search.",
  brave: 'Independent index, privacy-focused.'
}

const PERMISSION_NAMES: Record<string, string> = {
  geolocation: 'Location',
  notifications: 'Notifications',
  camera: 'Camera',
  microphone: 'Microphone',
  midi: 'MIDI devices',
  'clipboard-read': 'Clipboard'
}

/** Site permissions you've answered, and "Clear browsing data" (with a confirm step). */
/** Saved sign-ins: site and username only; passwords never reach the UI. */
function PasswordSettings() {
  const [data, setData] = useState<{ available: boolean; list: SavedPassword[] } | null>(null)
  const load = (): void => {
    void api.invoke('passwords:list').then(setData)
  }
  useEffect(load, [])
  return (
    <>
      <h3>Saved passwords</h3>
      {data === null ? (
        <span className="skeleton-line" style={{ width: '60%' }} aria-hidden="true" />
      ) : !data.available ? (
        <p className="hint">This system has no secure keychain, so passwords can't be saved.</p>
      ) : data.list.length === 0 ? (
        <p className="hint">
          When you sign in to a site, the browser offers to save the password, encrypted with your
          system keychain. Saved sign-ins are filled in for you and appear here.
        </p>
      ) : (
        <ul className="site-permissions">
          {data.list.map((p) => (
            <li key={`${p.origin} ${p.username}`} className="row gap">
              <span className="grow">
                <strong>{p.origin.replace(/^https?:\/\//, '')}</strong>
                <span className="hint"> {p.username || '(no username)'}</span>
              </span>
              <button
                className="btn subtle"
                onClick={() =>
                  void api
                    .invoke('passwords:delete', { origin: p.origin, username: p.username })
                    .then(load)
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function BrowsingDataSettings() {
  const [perms, setPerms] = useState<SitePermission[] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = (): void => {
    void api.invoke('permissions:list').then(setPerms)
  }
  useEffect(load, [])

  const origins = [...new Set((perms ?? []).map((p) => p.origin))]
  return (
    <>
      <h3>Site permissions</h3>
      {perms === null ? (
        <span className="skeleton-line" style={{ width: '60%' }} aria-hidden="true" />
      ) : origins.length === 0 ? (
        <p className="hint">
          Sites ask before using your location, camera, microphone or notifications. Your answers
          appear here.
        </p>
      ) : (
        <ul className="site-permissions">
          {origins.map((origin) => (
            <li key={origin} className="row gap">
              <span className="grow">
                <strong>{origin.replace(/^https?:\/\//, '')}</strong>
                <span className="hint">
                  {' '}
                  {perms
                    .filter((p) => p.origin === origin)
                    .map(
                      (p) =>
                        `${PERMISSION_NAMES[p.permission] ?? p.permission}: ${p.allow ? 'Allowed' : 'Blocked'}`
                    )
                    .join(' · ')}
                </span>
              </span>
              <button
                className="btn subtle"
                onClick={() => void api.invoke('permissions:clear', { origin }).then(load)}
              >
                Reset
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Browsing data</h3>
      <p className="hint">
        Clears history, saved summaries, cookies and site data (you'll be signed out of sites), and
        the cache.
      </p>
      {confirm ? (
        <div className="row gap">
          <button
            className="btn danger"
            onClick={() => {
              setConfirm(false)
              void api
                .invoke('browsing-data:clear')
                .then(() => setNote('Browsing data cleared.'))
                .catch(() => setNote("Some data couldn't be cleared. Try again."))
            }}
          >
            Clear browsing data
          </button>
          <button className="btn subtle" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="btn"
          onClick={() => {
            setNote(null)
            setConfirm(true)
          }}
        >
          Clear browsing data…
        </button>
      )}
      {note && <p className="hint">{note}</p>}
    </>
  )
}

/** Browser settings first (pages, tabs, privacy), then the app's own (AI, models). */
const SECTIONS = [
  { id: 'general', label: 'General', group: 'Browser settings' },
  { id: 'library', label: 'Bookmarks & history', group: 'Browser settings' },
  { id: 'passwords', label: 'Passwords', group: 'Browser settings' },
  { id: 'windows', label: 'Windows & incognito', group: 'Browser settings' },
  { id: 'privacy', label: 'Privacy & security', group: 'Browser settings' },
  { id: 'assistant', label: 'AI & language', group: 'Application settings' },
  { id: 'search', label: 'AI search', group: 'Application settings' },
  { id: 'models', label: 'Models', group: 'Application settings' },
  { id: 'performance', label: 'Performance', group: 'Application settings' },
  { id: 'about', label: 'About', group: 'Application settings' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

interface Props {
  settings: SettingsT
  updateSettings: (patch: Partial<SettingsT>) => Promise<void>
  status: LlmStatus | null
  initialSection: string
  onClose: () => void
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
  hint
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
  hint?: string
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Math.round(Number(draft))
    if (!Number.isFinite(n)) return setDraft(String(value))
    const clamped = Math.min(max, Math.max(min, n))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        className="text-input narrow"
        min={min}
        max={max}
        step={step ?? 1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

function RoleSelect({
  role,
  label,
  models,
  settings,
  updateSettings
}: {
  role: ModelRole
  label: string
  models: ModelEntry[]
  settings: SettingsT
  updateSettings: Props['updateSettings']
}) {
  // Imported GGUF files can serve the text role; embeddings and speech need their own models.
  const options = models.filter(
    (m) => m.roles.includes(role) || (role === 'fast' && m.imported && !m.roles.includes('embed'))
  )
  const items = [
    { value: '', label: 'None', description: 'Turn this feature off.' },
    ...options.map((m) => ({
      value: m.id,
      label: m.name,
      description: `${formatBytes(m.sizeBytes)} · ${
        m.state.kind === 'ready' ? 'Installed' : 'Not downloaded yet: download it below'
      }`
    }))
  ]
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <Dropdown
        ariaLabel={label}
        className="dropdown-block"
        value={settings.models[role] ?? ''}
        options={items}
        onChange={(id) =>
          void updateSettings({ models: { ...settings.models, [role]: id || null } })
        }
      />
    </div>
  )
}

export function Settings({ settings, updateSettings, status, initialSection, onClose }: Props) {
  const [section, setSection] = useState<SectionId>(
    (SECTIONS.find((s) => s.id === initialSection)?.id ?? 'general') as SectionId
  )
  const models = useModels()
  const hw = useHardware()
  // Only offer catalog models this computer can run (installed ones always stay visible).
  const fittingModels = models.filter((m) => m.state.kind === 'ready' || modelFits(m, hw))
  const hiddenModels = models.length - fittingModels.length
  const [disk, setDisk] = useState<{ dir: string; freeBytes: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pendingLicense, setPendingLicense] = useState<{
    modelId: string
    license: LicenseId
  } | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])
  useEffect(() => {
    if (section === 'models') void api.invoke('models:disk').then(setDisk)
  }, [section, models])

  const download = (m: ModelEntry): void => {
    if (
      m.license !== 'unknown' &&
      m.license !== 'apache-2.0' &&
      !settings.acceptedLicenses.includes(m.license)
    ) {
      setPendingLicense({ modelId: m.id, license: m.license })
      return
    }
    void api.invoke('models:download', { modelId: m.id })
  }

  const importModel = async (): Promise<void> => {
    try {
      const entry = await api.invoke('models:import')
      if (entry) setMessage(`Imported ${entry.name}. Assign it to a role above.`)
    } catch (err) {
      setMessage(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err)
      )
    }
  }

  const backdrop = useBackdropClose(onClose)

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      {...backdrop}
    >
      <div className="settings">
        <header className="settings-header">
          <h1 id="settings-title">Settings</h1>
          <button ref={closeRef} className="icon-btn" aria-label="Close settings" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s, i) => (
              <div key={s.id} className="settings-nav-item">
                {SECTIONS[i - 1]?.group !== s.group && (
                  <span className="settings-nav-group">{s.group}</span>
                )}
                <button
                  className={section === s.id ? 'active' : ''}
                  aria-current={section === s.id ? 'page' : undefined}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </button>
              </div>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'general' && (
              <>
                <h2>General</h2>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">Theme</span>
                    <span className="hint">Light, dark, or match your computer.</span>
                  </div>
                  <Dropdown
                    ariaLabel="Theme"
                    align="right"
                    value={settings.theme}
                    onChange={(theme) => void updateSettings({ theme })}
                    options={[
                      {
                        value: 'system',
                        label: 'Follow system',
                        description: 'Switches with your OS appearance.'
                      },
                      { value: 'light', label: 'Light', description: 'Always light.' },
                      { value: 'dark', label: 'Dark', description: 'Always dark.' }
                    ]}
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">On startup</span>
                    <span className="hint">What opens when you launch the browser.</span>
                  </div>
                  <Dropdown
                    ariaLabel="On startup"
                    align="right"
                    value={settings.startup}
                    onChange={(startup) => void updateSettings({ startup })}
                    options={[
                      {
                        value: 'restore',
                        label: 'Continue where you left off',
                        description:
                          'Reopens your tabs. Closing the last tab starts fresh next time.'
                      },
                      { value: 'newtab', label: 'Open a new tab', description: 'Start empty.' }
                    ]}
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">Search engine</span>
                    <span className="hint">Used by the address bar for searches.</span>
                  </div>
                  <Dropdown
                    ariaLabel="Search engine"
                    align="right"
                    value={settings.searchEngine}
                    onChange={(searchEngine) => void updateSettings({ searchEngine })}
                    options={(Object.keys(SEARCH_ENGINE_NAMES) as SearchEngine[]).map((k) => ({
                      value: k,
                      label: SEARCH_ENGINE_NAMES[k],
                      description: ENGINE_NOTES[k]
                    }))}
                  />
                </div>
              </>
            )}

            {section === 'assistant' && (
              <>
                <h2>AI & language</h2>
                <label className="field">
                  <span className="field-label">Summary & chat language</span>
                  <input
                    className="text-input"
                    placeholder="Same as the page"
                    defaultValue={settings.summaryLanguage}
                    maxLength={40}
                    onBlur={(e) => void updateSettings({ summaryLanguage: e.target.value.trim() })}
                  />
                  <span className="hint">Leave empty to answer in the page's language.</span>
                </label>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">Voice input language</span>
                    <span className="hint">The language you speak into the mic.</span>
                  </div>
                  <Dropdown
                    ariaLabel="Voice input language"
                    align="right"
                    value={settings.speechLanguage}
                    onChange={(speechLanguage) => void updateSettings({ speechLanguage })}
                    options={[
                      {
                        value: '',
                        label: 'Detect automatically',
                        description: 'Works for most languages.'
                      },
                      ...SPEECH_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))
                    ]}
                  />
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.useRetrieval}
                    onChange={(e) => void updateSettings({ useRetrieval: e.target.checked })}
                  />
                  Use local embeddings to find relevant parts of long pages in chat
                </label>
                <button
                  className="btn subtle"
                  onClick={() => void updateSettings({ tourComplete: false })}
                >
                  Show the tour again
                </button>
              </>
            )}

            {section === 'library' && (
              <>
                <h2>Bookmarks & history</h2>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.bookmarksBar}
                    onChange={(e) => void updateSettings({ bookmarksBar: e.target.checked })}
                  />
                  Show the bookmarks bar under the toolbar
                </label>
                <div className="row gap">
                  {(['bookmarks', 'history', 'downloads'] as const).map((page) => (
                    <button
                      key={page}
                      className="btn"
                      onClick={() => {
                        onClose()
                        void api.invoke('tabs:open-page', { page })
                      }}
                    >
                      Open{' '}
                      {page === 'bookmarks'
                        ? 'Bookmarks'
                        : page === 'history'
                          ? 'History'
                          : 'Downloads'}
                    </button>
                  ))}
                </div>
                <h3>Ask AI about your history</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.historyIndex}
                    onChange={(e) => void updateSettings({ historyIndex: e.target.checked })}
                  />
                  Keep the text of pages I visit on this computer so the AI can answer questions
                  about them (newest 3,000 pages; nothing leaves this computer)
                </label>
                <button
                  className="btn subtle"
                  onClick={() => void api.invoke('history:index-clear')}
                >
                  Clear AI history index
                </button>
              </>
            )}

            {section === 'passwords' && (
              <>
                <h2>Passwords</h2>
                <PasswordSettings />
              </>
            )}

            {section === 'windows' && (
              <>
                <h2>Windows & incognito</h2>
                <p className="hint">
                  A new window has its own tabs. An incognito window keeps cookies and site data in
                  memory only and deletes them when it closes; it adds nothing to history, saves no
                  passwords and isn't restored on the next launch. Downloads and bookmarks you make
                  there are kept. The ad blocker is off in incognito windows.
                </p>
                <div className="row gap">
                  <button
                    className="btn"
                    onClick={() => void api.invoke('app:new-window', { incognito: false })}
                  >
                    New window
                  </button>
                  <button
                    className="btn"
                    onClick={() => void api.invoke('app:new-window', { incognito: true })}
                  >
                    New incognito window
                  </button>
                </div>
              </>
            )}

            {section === 'search' && (
              <>
                <h2>AI search</h2>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">Default result style</span>
                    <span className="hint">
                      The style selected first for each search. You can switch styles on the AI
                      result page.
                    </span>
                  </div>
                  <Dropdown
                    ariaLabel="Default result style"
                    align="right"
                    value={settings.searchAnswerMode}
                    onChange={(searchAnswerMode) => void updateSettings({ searchAnswerMode })}
                    options={SEARCH_ANSWER_MODES.map((m) => ({
                      value: m.id,
                      label: m.label,
                      description: `${m.description} Reads ${m.sources} sources.`
                    }))}
                  />
                </div>
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-title">Sources to read</span>
                    <span className="hint">
                      How many search results each AI answer reads. More is broader but slower.
                    </span>
                  </div>
                  <Dropdown
                    ariaLabel="Sources to read"
                    align="right"
                    value={
                      settings.searchSources === null ? 'auto' : String(settings.searchSources)
                    }
                    onChange={(v) =>
                      void updateSettings({ searchSources: v === 'auto' ? null : Number(v) })
                    }
                    options={[
                      {
                        value: 'auto',
                        label: 'Automatic',
                        description: `Each style's own number: ${SEARCH_ANSWER_MODES.map((m) => `${m.label} ${m.sources}`).join(', ')}.`
                      },
                      ...SOURCE_COUNTS.map((n) => ({
                        value: String(n),
                        label: `${n} sources`,
                        description: `Every style reads the top ${n} results.`
                      }))
                    ]}
                  />
                </div>
              </>
            )}

            {section === 'models' && (
              <>
                <h2>Models</h2>
                <RoleSelect
                  role="fast"
                  label="Summaries, chat & search answers"
                  models={fittingModels}
                  settings={settings}
                  updateSettings={updateSettings}
                />
                <RoleSelect
                  role="embed"
                  label="Embeddings (page retrieval)"
                  models={fittingModels}
                  settings={settings}
                  updateSettings={updateSettings}
                />
                <RoleSelect
                  role="speech"
                  label="Speech to text (mic)"
                  models={fittingModels}
                  settings={settings}
                  updateSettings={updateSettings}
                />
                <h3>Installed & available</h3>
                {hiddenModels > 0 && (
                  <p className="hint">
                    {hiddenModels} larger model{hiddenModels === 1 ? ' is' : 's are'} hidden because
                    they need more memory than this computer has (
                    {hw ? formatBytes(hw.totalRamBytes) : '?'} RAM).
                  </p>
                )}
                <ul className="model-list">
                  {fittingModels.map((m) => (
                    <li key={m.id}>
                      <div className="row space-between">
                        <div>
                          <strong>{m.name}</strong>{' '}
                          {m.state.kind === 'ready' && <span className="badge ok">ready</span>}
                          <div className="hint">
                            {m.description} · {formatBytes(m.sizeBytes)} · {m.quantization}
                            {m.license !== 'unknown' && ` · ${LICENSES[m.license].name}`}
                          </div>
                        </div>
                        {m.state.kind === 'absent' ? (
                          <button className="btn" onClick={() => download(m)}>
                            Download
                          </button>
                        ) : (
                          <ModelActions model={m} />
                        )}
                      </div>
                      <ModelProgress model={m} />
                      {pendingLicense?.modelId === m.id && (
                        <div className="license-card">
                          <p>{LICENSES[pendingLicense.license].summary}</p>
                          <div className="row gap">
                            <button
                              className="link"
                              onClick={() => openInNewTab(LICENSES[pendingLicense.license].url)}
                            >
                              Read license
                            </button>
                            <button
                              className="btn primary"
                              onClick={() => {
                                void updateSettings({
                                  acceptedLicenses: [
                                    ...settings.acceptedLicenses,
                                    pendingLicense.license
                                  ]
                                }).then(() => api.invoke('models:download', { modelId: m.id }))
                                setPendingLicense(null)
                              }}
                            >
                              Accept {LICENSES[pendingLicense.license].name} & download
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="row gap">
                  <button className="btn" onClick={() => void importModel()}>
                    Import .gguf file…
                  </button>
                  <button
                    className="btn subtle"
                    onClick={() => void api.invoke('models:open-folder')}
                  >
                    Open models folder
                  </button>
                </div>
                {message && <p className="hint">{message}</p>}
                {disk && (
                  <p className="hint">
                    Stored in <code>{disk.dir}</code> · {formatBytes(disk.freeBytes)} free
                  </p>
                )}
              </>
            )}

            {section === 'performance' && (
              <>
                <h2>Performance</h2>
                <NumberField
                  label="Context window (tokens)"
                  value={settings.contextSize}
                  min={CONTEXT_SIZE_MIN}
                  max={CONTEXT_SIZE_MAX}
                  step={1024}
                  hint="Larger windows read more text at once but use more memory. Automatically reduced if memory is insufficient."
                  onCommit={(v) => void updateSettings({ contextSize: v })}
                />
                <NumberField
                  label="Unload models after idle (minutes)"
                  value={settings.idleUnloadMinutes}
                  min={0}
                  max={240}
                  hint="0 keeps models loaded until you quit."
                  onCommit={(v) => void updateSettings({ idleUnloadMinutes: v })}
                />
                <div className="field">
                  <span className="field-label">GPU acceleration</span>
                  <Dropdown
                    ariaLabel="GPU acceleration"
                    className="dropdown-block"
                    value={settings.gpu}
                    onChange={(gpu) => void updateSettings({ gpu })}
                    options={[
                      {
                        value: 'auto',
                        label: 'Automatic',
                        description:
                          'Use Metal, CUDA or Vulkan when available; falls back to CPU if the GPU fails.'
                      },
                      {
                        value: 'off',
                        label: 'Off (CPU only)',
                        description: 'Slower, but avoids GPU driver problems.'
                      }
                    ]}
                  />
                </div>
                {status && (
                  <dl className="hw-grid">
                    <div>
                      <dt>Engine</dt>
                      <dd>{status.provider === 'mock' ? 'Mock' : 'llama.cpp (embedded)'}</dd>
                    </div>
                    <div>
                      <dt>Loaded model</dt>
                      <dd>{status.activeModel ?? 'none'}</dd>
                    </div>
                    <div>
                      <dt>Backend</dt>
                      <dd>{gpuLabel(status.gpu)}</dd>
                    </div>
                    <div>
                      <dt>Memory</dt>
                      <dd>
                        {formatBytes(status.workerMemoryBytes)}
                        {status.vramUsedBytes
                          ? ` RAM · ${formatBytes(status.vramUsedBytes)} VRAM`
                          : ''}
                      </dd>
                    </div>
                  </dl>
                )}
                <div className="row gap">
                  <button className="btn" onClick={() => void api.invoke('llm:unload')}>
                    Unload models now
                  </button>
                  <button className="btn subtle" onClick={() => void api.invoke('llm:restart')}>
                    Restart AI engine
                  </button>
                </div>
              </>
            )}

            {section === 'privacy' && (
              <>
                <h2>Privacy & security</h2>
                <p>
                  All AI processing happens on this computer. The app only connects to the sites you
                  visit and, when you ask, to Hugging Face to download models.
                </p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.adBlocking}
                    onChange={(e) => void updateSettings({ adBlocking: e.target.checked })}
                  />
                  Block ads and trackers (EasyList + EasyPrivacy, bundled with the app)
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={settings.searchSuggestions}
                    onChange={(e) => void updateSettings({ searchSuggestions: e.target.checked })}
                  />
                  Also suggest searches from DuckDuckGo while typing (sends what you type)
                </label>
                <BrowsingDataSettings />
              </>
            )}

            {section === 'about' && (
              <>
                <h2>About</h2>
                <p>
                  <strong>Agentic Browser</strong> — a browser with a local AI assistant.
                </p>
                <p className="built-with">Built with Llama</p>
                <p className="hint">
                  Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta
                  Platforms, Inc. All Rights Reserved. Llama 3.1 is licensed under the Llama 3.1
                  Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.
                </p>
                <ul className="link-list">
                  {(Object.keys(LICENSES) as LicenseId[]).map((l) => (
                    <li key={l}>
                      <button className="link" onClick={() => openInNewTab(LICENSES[l].url)}>
                        {LICENSES[l].name}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="hint">
                  Inference: llama.cpp via node-llama-cpp. Page cleanup: Mozilla Readability,
                  Turndown. PDF text: PDF.js.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
