import type { LlmStatus, Settings, TabInfo } from '@shared/types'
import type { AgentStore } from '../lib/agent'
import type { AssistantStore } from '../lib/store'
import { mod } from '../lib/format'
import { AgentView } from './AgentView'
import { ChatView, type ChatDraft } from './ChatView'
import { IconClose } from './Icons'
import { ModelStatusBar } from './ModelStatusBar'
import { SummaryView } from './SummaryView'

export type PanelTab = 'summary' | 'chat' | 'agent'

const TABS: Array<{ id: PanelTab; label: string; shortcut: string }> = [
  { id: 'summary', label: 'Summary', shortcut: `${mod}⇧S` },
  { id: 'chat', label: 'Chat', shortcut: `${mod}⇧C` },
  { id: 'agent', label: 'Agent', shortcut: '' }
]

interface Props {
  width: number
  tab: PanelTab
  onTab: (t: PanelTab) => void
  activeTab: TabInfo | null
  /** Every open tab, for chat's "All open tabs" / "Pick tabs". */
  tabs: TabInfo[]
  store: AssistantStore
  agent: AgentStore
  status: LlmStatus | null
  settings: Settings | null
  chatDraft: ChatDraft | null
  onClose: () => void
  onOpenSettings: (section: string) => void
}

export function SidePanel({
  width,
  tab,
  onTab,
  activeTab,
  tabs,
  store,
  agent,
  status,
  settings,
  chatDraft,
  onClose,
  onOpenSettings
}: Props) {
  const noModel =
    settings !== null &&
    settings.provider !== 'mock' &&
    status?.provider !== 'mock' &&
    !settings.models.fast

  return (
    <aside className="side-panel" style={{ width }} aria-label="AI assistant">
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Assistant sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`panel-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              className={`panel-tab ${tab === t.id ? 'active' : ''}`}
              title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                const idx = TABS.findIndex((x) => x.id === tab)
                if (e.key === 'ArrowRight') onTab(TABS[(idx + 1) % TABS.length]!.id)
                if (e.key === 'ArrowLeft') onTab(TABS[(idx - 1 + TABS.length) % TABS.length]!.id)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" aria-label="Close AI panel" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div
        className="panel-body"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`panel-tab-${tab}`}
      >
        {noModel && (tab === 'summary' || tab === 'chat' || tab === 'agent') && (
          <div className="notice">
            No local model is installed.{' '}
            <button className="link" onClick={() => onOpenSettings('models')}>
              Download or import one
            </button>{' '}
            to use AI features.
          </div>
        )}
        {tab === 'summary' && (
          <SummaryView activeTab={activeTab} store={store} onOpenSettings={onOpenSettings} />
        )}
        {tab === 'chat' && (
          <ChatView
            activeTab={activeTab}
            tabs={tabs}
            store={store}
            draft={chatDraft}
            onOpenSettings={onOpenSettings}
          />
        )}
        {tab === 'agent' && <AgentView activeTab={activeTab} agent={agent} />}
      </div>
      <ModelStatusBar status={status} />
    </aside>
  )
}
