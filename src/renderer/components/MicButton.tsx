import { useDictation } from '../lib/dictation'
import { IconMic } from './Icons'

interface Props {
  /** Receives the transcribed text. */
  onText: (text: string) => void
  /** Where errors are shown: 'below' renders a small line under the button's row. */
  className?: string
}

/** Click to start talking, click again to stop; the text is transcribed locally with Whisper. */
export function MicButton({ onText, className = '' }: Props) {
  const { state, error, toggle, clearError } = useDictation(onText)
  const label =
    state === 'recording'
      ? 'Stop and transcribe'
      : state === 'transcribing'
        ? 'Transcribing…'
        : 'Dictate (speech to text)'
  return (
    <span className={`mic-wrap ${className}`}>
      <button
        type="button"
        className={`icon-btn mic-btn ${state}`}
        aria-label={label}
        aria-pressed={state === 'recording'}
        title={label}
        disabled={state === 'transcribing'}
        onClick={toggle}
      >
        {state === 'transcribing' ? (
          <span className="spinner small" aria-hidden="true" />
        ) : (
          <IconMic />
        )}
      </button>
      {error && (
        <span className="mic-error" role="alert" onClick={clearError} title="Dismiss">
          {error}
        </span>
      )}
    </span>
  )
}
