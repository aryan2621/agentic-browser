import { useEffect, useMemo, useState } from 'react'
import type { HardwareInfo, LicenseId, ModelRecommendation, Settings } from '@shared/types'
import { modelFits } from '../lib/fit'
import { api, openInNewTab, useModels } from '../lib/api'
import { formatBytes, gpuLabel } from '../lib/format'
import { LICENSES } from './licenses'
import { ModelActions, ModelProgress } from './ModelList'

type Step = 'welcome' | 'hardware' | 'license' | 'download' | 'ready'

interface Props {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  onPeek: (peeking: boolean) => void
}

const STEPS: Step[] = ['welcome', 'hardware', 'license', 'download', 'ready']

export function OnboardingScreen({ settings, updateSettings, onPeek }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [hw, setHw] = useState<{
    hardware: HardwareInfo
    recommendation: ModelRecommendation
  } | null>(null)
  const [hwError, setHwError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [accepted, setAccepted] = useState(false)
  const [disk, setDisk] = useState<{ dir: string; freeBytes: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [peeking, setPeeking] = useState(false)
  const models = useModels()
  const catalog = models.filter((m) => !m.imported)

  useEffect(() => {
    if (step !== 'hardware' || hw) return
    api
      .invoke('llm:hardware')
      .then((res) => {
        setHw(res)
        setSelected(
          new Set([res.recommendation.fast, res.recommendation.embed, res.recommendation.speech])
        )
      })
      .catch((err: unknown) => setHwError(err instanceof Error ? err.message : String(err)))
  }, [step, hw])

  useEffect(() => {
    if (step === 'download') void api.invoke('models:disk').then(setDisk)
  }, [step])

  const chosen = catalog.filter((m) => selected.has(m.id))
  const licenses = useMemo(
    () => [...new Set(chosen.map((m) => m.license))].filter((l): l is LicenseId => l !== 'unknown'),
    [chosen]
  )
  const totalBytes = chosen
    .filter((m) => m.state.kind !== 'ready')
    .reduce((sum, m) => sum + m.sizeBytes, 0)
  const allReady = chosen.length > 0 && chosen.every((m) => m.state.kind === 'ready')
  const genReady = chosen.some((m) => m.state.kind === 'ready' && m.roles.includes('fast'))

  const peek = (url: string): void => {
    openInNewTab(url)
    setPeeking(true)
    onPeek(true)
  }

  const startDownloads = async (): Promise<void> => {
    await updateSettings({
      acceptedLicenses: [...new Set([...settings.acceptedLicenses, ...licenses])]
    })
    for (const m of chosen)
      if (m.state.kind !== 'ready') await api.invoke('models:download', { modelId: m.id })
    setStep('download')
  }

  /** Assign roles by intent; models that are still downloading are picked up once ready. */
  const assignAndFinish = async (): Promise<void> => {
    const rec = hw?.recommendation
    const pick = (id: string | undefined): string | null => (id && selected.has(id) ? id : null)
    const gen = chosen.filter((m) => m.roles.includes('fast'))
    const fast = pick(rec?.fast) ?? gen.find((m) => m.roles.includes('fast'))?.id ?? null
    const embed = pick(rec?.embed) ?? chosen.find((m) => m.roles.includes('embed'))?.id ?? null
    const speech = pick(rec?.speech) ?? chosen.find((m) => m.roles.includes('speech'))?.id ?? null
    await updateSettings({ models: { fast, embed, speech }, onboardingComplete: true })
  }

  const importModel = async (): Promise<void> => {
    setImportError(null)
    try {
      const entry = await api.invoke('models:import')
      if (!entry) return
      const isEmbed = entry.roles.includes('embed')
      await updateSettings({
        models: {
          fast: isEmbed ? settings.models.fast : entry.id,
          embed: isEmbed ? entry.id : settings.models.embed,
          speech: settings.models.speech
        },
        onboardingComplete: true
      })
    } catch (err) {
      setImportError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err)
      )
    }
  }

  if (peeking) {
    return (
      <div className="peek-bar" role="region" aria-label="Setup paused">
        Reading the license in a browser tab.
        <button
          className="btn primary"
          onClick={() => {
            setPeeking(false)
            onPeek(false)
          }}
        >
          Back to setup
        </button>
      </div>
    )
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding">
        <ol className="stepper" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={s === step ? 'current' : STEPS.indexOf(step) > i ? 'done' : ''}
              aria-current={s === step ? 'step' : undefined}
            >
              {['Welcome', 'Hardware', 'License', 'Download', 'Ready'][i]}
            </li>
          ))}
        </ol>

        {step === 'welcome' && (
          <section>
            <h1 id="onboarding-title">Welcome to Agentic Browser</h1>
            <p>A web browser with an AI assistant that runs entirely on your computer:</p>
            <ul className="features">
              <li>
                <strong>Summarize</strong> any page, streamed live
              </li>
              <li>
                <strong>Chat</strong> with the page you are reading
              </li>
              <li>
                <strong>Search with AI</strong>: answers written from the top results, with sources
              </li>
            </ul>
            <p className="privacy">
              The AI is an open model (Llama or Qwen) embedded in the app. No cloud, no account, no
              API key. Page content never leaves this machine. The only extra network traffic is the
              one-time model download from Hugging Face.
            </p>
            <div className="row gap end">
              <button
                className="btn subtle"
                onClick={() => void updateSettings({ onboardingComplete: true })}
              >
                Skip setup
              </button>
              <button className="btn primary" autoFocus onClick={() => setStep('hardware')}>
                Get started
              </button>
            </div>
          </section>
        )}

        {step === 'hardware' && (
          <section>
            <h1 id="onboarding-title">Your hardware</h1>
            {!hw && !hwError && <p className="progress-line">Checking memory and GPU…</p>}
            {hwError && (
              <p className="error-message">
                Could not detect the GPU ({hwError}). CPU inference will be used.
              </p>
            )}
            {hw && (
              <>
                <dl className="hw-grid">
                  <div>
                    <dt>Memory</dt>
                    <dd>{formatBytes(hw.hardware.totalRamBytes)}</dd>
                  </div>
                  <div>
                    <dt>Processor</dt>
                    <dd>
                      {hw.hardware.cpuModel} ({hw.hardware.cpuCores} cores)
                    </dd>
                  </div>
                  <div>
                    <dt>Acceleration</dt>
                    <dd>
                      {gpuLabel(hw.hardware.gpu)}
                      {hw.hardware.gpuDeviceNames.length > 0 &&
                        ` · ${hw.hardware.gpuDeviceNames.join(', ')}`}
                    </dd>
                  </div>
                  {hw.hardware.gpu !== false && (
                    <div>
                      <dt>{hw.hardware.unifiedMemory ? 'Unified memory for GPU' : 'VRAM'}</dt>
                      <dd>{formatBytes(hw.hardware.vramTotalBytes)}</dd>
                    </div>
                  )}
                </dl>
                <p className={`recommendation tier-${hw.recommendation.tier}`}>
                  {hw.recommendation.reason}
                </p>
                <fieldset className="model-choices">
                  <legend>Models to download</legend>
                  {catalog
                    .filter((m) => modelFits(m, hw.hardware))
                    .map((m) => {
                      const recommended = [
                        hw.recommendation.fast,
                        hw.recommendation.embed,
                        hw.recommendation.speech
                      ].includes(m.id)
                      return (
                        <label key={m.id} className="model-choice">
                          <input
                            type="checkbox"
                            checked={selected.has(m.id)}
                            onChange={(e) => {
                              const next = new Set(selected)
                              if (e.target.checked) next.add(m.id)
                              else next.delete(m.id)
                              setSelected(next)
                            }}
                          />
                          <span>
                            <strong>{m.name}</strong>{' '}
                            {recommended && <span className="badge">recommended</span>}
                            {m.state.kind === 'ready' && (
                              <span className="badge ok">installed</span>
                            )}
                            <br />
                            <span className="hint">
                              {m.description} {formatBytes(m.sizeBytes)} · {m.quantization}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                </fieldset>
              </>
            )}
            <div className="row gap space-between">
              <div className="row gap">
                <button className="btn subtle" onClick={() => void importModel()}>
                  Import a .gguf instead
                </button>
                <button
                  className="btn subtle"
                  onClick={() => void updateSettings({ onboardingComplete: true })}
                >
                  Skip for now
                </button>
              </div>
              <button
                className="btn primary"
                disabled={!hw && !hwError ? true : chosen.length === 0}
                onClick={() =>
                  setStep(licenses.some((l) => l !== 'apache-2.0') ? 'license' : 'download')
                }
              >
                Continue
              </button>
            </div>
            {importError && <p className="error-message">{importError}</p>}
          </section>
        )}

        {step === 'license' && (
          <section>
            <h1 id="onboarding-title">Model license</h1>
            <p>
              Llama models are provided by Meta under the Llama Community License. Please review and
              accept it before downloading.
            </p>
            {licenses.map((l) => (
              <div key={l} className="license-card">
                <h3>{LICENSES[l].name}</h3>
                <p>{LICENSES[l].summary}</p>
                <div className="row gap">
                  <button className="link" onClick={() => peek(LICENSES[l].url)}>
                    Read the full license
                  </button>
                  {LICENSES[l].aup && (
                    <button className="link" onClick={() => peek(LICENSES[l].aup!)}>
                      Acceptable Use Policy
                    </button>
                  )}
                </div>
              </div>
            ))}
            <label className="checkbox accept">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              I have read and accept the license terms and Acceptable Use Policy above.
            </label>
            <div className="row gap space-between">
              <button className="btn subtle" onClick={() => setStep('hardware')}>
                Back
              </button>
              <button
                className="btn primary"
                disabled={!accepted}
                onClick={() => void startDownloads()}
              >
                Accept and download
              </button>
            </div>
          </section>
        )}

        {step === 'download' && (
          <section>
            <h1 id="onboarding-title">Downloading models</h1>
            <p className="hint">
              Saved to <code>{disk?.dir ?? '…'}</code> · {formatBytes(totalBytes)} to download ·{' '}
              {formatBytes(disk?.freeBytes)} free. Files are verified with SHA-256.
            </p>
            {chosen.length > 0 && chosen.every((m) => m.state.kind === 'absent') && (
              <button className="btn primary" onClick={() => void startDownloads()}>
                Start download
              </button>
            )}
            <ul className="download-list">
              {chosen.map((m) => (
                <li key={m.id}>
                  <div className="row space-between">
                    <strong>{m.name}</strong>
                    {m.state.kind === 'ready' ? (
                      <span className="badge ok">ready</span>
                    ) : (
                      <ModelActions model={m} />
                    )}
                  </div>
                  <ModelProgress model={m} />
                </li>
              ))}
            </ul>
            <div className="row gap space-between">
              <button
                className="btn subtle"
                onClick={() => void assignAndFinish()}
                title="Downloads continue in the background"
              >
                Continue in background
              </button>
              <button className="btn primary" disabled={!allReady} onClick={() => setStep('ready')}>
                Continue
              </button>
            </div>
            {!genReady && (
              <p className="hint">
                You can start browsing now; AI features become available when the download finishes.
              </p>
            )}
          </section>
        )}

        {step === 'ready' && (
          <section>
            <h1 id="onboarding-title">You're all set</h1>
            <p>
              Models are installed and verified. They load on first use and unload automatically
              after {settings.idleUnloadMinutes} idle minutes to free memory.
            </p>
            <p className="hint">Built with Llama.</p>
            <div className="row gap end">
              <button className="btn primary" autoFocus onClick={() => void assignAndFinish()}>
                Start browsing
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
