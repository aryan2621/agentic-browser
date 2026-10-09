import type { LlmErrorInfo } from '@shared/types'
import { api } from '../lib/api'
import { IconWarning } from './Icons'

interface Props {
  error: LlmErrorInfo
  onRetry?: () => void
  onOpenSettings: (section: string) => void
}

const TITLES: Record<LlmErrorInfo['code'], string> = {
  NO_MODEL: 'No local model yet',
  MODEL_MISSING: 'Model file missing',
  MODEL_CORRUPT: 'Model file is damaged',
  MODEL_LOAD_FAILED: "This model can't be loaded",
  CONTEXT_TOO_SMALL: 'Too much text for the model',
  OUT_OF_MEMORY: 'Not enough memory',
  WORKER_CRASHED: 'The local model stopped',
  ABORTED: 'Stopped',
  GENERATION_FAILED: 'Something went wrong'
}

export function ErrorBox({ error, onRetry, onOpenSettings }: Props) {
  const reduceContext = async (): Promise<void> => {
    const s = await api.invoke('settings:get')
    await api.invoke('settings:update', {
      contextSize: Math.max(2048, Math.floor(s.contextSize / 2))
    })
    await api.invoke('llm:restart')
    onRetry?.()
  }
  return (
    <div className="error-box" role="alert">
      <div className="error-title">
        <IconWarning /> {TITLES[error.code]}
      </div>
      <p className="error-message">{error.message}</p>
      <div className="row gap">
        {error.actions.includes('retry') && onRetry && (
          <button className="btn" onClick={onRetry}>
            Try again
          </button>
        )}
        {error.actions.includes('reduce-context') && (
          <button className="btn" onClick={() => void reduceContext()}>
            Use smaller context
          </button>
        )}
        {(error.actions.includes('open-models') ||
          error.actions.includes('use-smaller-model') ||
          error.actions.includes('redownload')) && (
          <button className="btn primary" onClick={() => onOpenSettings('models')}>
            {error.actions.includes('redownload')
              ? 'Manage models'
              : error.code === 'NO_MODEL'
                ? 'Get a model'
                : 'Choose a model'}
          </button>
        )}
      </div>
    </div>
  )
}
