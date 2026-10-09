import { useEffect, useRef, useState } from 'react'
import type { TabInfo } from '@shared/types'
import { api } from '../lib/api'
import { mod } from '../lib/format'
import {
  IconClose,
  IconGlobe,
  IconPlus,
  IconSparkle,
  IconSpeaker,
  IconSpeakerMuted,
  IconWarning
} from './Icons'

export function TabStrip({ tabs }: { tabs: TabInfo[] }) {
  const [dragId, setDragId] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const activate = (tabId: number): void => {
    void api.invoke('tabs:activate', { tabId })
  }

  // Keep the active tab visible when there are more tabs than fit.
  const activeId = tabs.find((t) => t.active)?.id ?? null
  useEffect(() => {
    if (activeId === null) return
    document
      .getElementById(`tab-${activeId}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const onKeyDown = (e: React.KeyboardEvent, index: number): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step || tabs.length === 0) return
    const t = tabs[(index + step + tabs.length) % tabs.length]
    if (t) {
      activate(t.id)
      document.getElementById(`tab-${t.id}`)?.focus()
    }
  }

  return (
    <div className="tabstrip">
      <div
        ref={listRef}
        className="tabs"
        role="tablist"
        aria-label="Open tabs"
        onWheel={(e) => {
          // A plain mouse wheel scrolls the tab row sideways.
          if (listRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX))
            listRef.current.scrollLeft += e.deltaY
        }}
      >
        {tabs.map((t, i) => {
          const active = t.active
          return (
            <div
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`tab ${active ? 'active' : ''} ${t.ai ? 'ai-tab' : ''} ${dragId === t.id ? 'dragging' : ''}`}
              title={t.ai ? `AI: ${t.ai}` : `${t.title}\n${t.url}`}
              draggable
              onDragStart={() => setDragId(t.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId !== null && dragId !== t.id)
                  void api.invoke('tabs:move', { tabId: dragId, toIndex: i })
                setDragId(null)
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  void api.invoke('tabs:close', { tabId: t.id })
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                void api.invoke('tabs:context-menu', { tabId: t.id })
              }}
              onClick={() => activate(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="tab-icon" aria-hidden="true">
                {t.ai ? (
                  <IconSparkle />
                ) : t.loading ? (
                  <span className="spinner" />
                ) : t.failed ? (
                  <IconWarning />
                ) : t.favicon ? (
                  <img src={t.favicon} alt="" width={16} height={16} />
                ) : (
                  <IconGlobe />
                )}
              </span>
              <span className="tab-title">{t.title}</span>
              {(t.audible || t.muted) && (
                <button
                  className="tab-audio"
                  tabIndex={-1}
                  aria-label={t.muted ? `Unmute ${t.title}` : `Mute ${t.title}`}
                  title={t.muted ? 'Unmute tab' : 'Mute tab'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.invoke('tabs:mute', { tabId: t.id })
                  }}
                >
                  {t.muted ? <IconSpeakerMuted /> : <IconSpeaker />}
                </button>
              )}
              <button
                className="tab-close"
                tabIndex={-1}
                aria-label={`Close ${t.title}`}
                title={`Close tab (${mod}W)`}
                onClick={(e) => {
                  e.stopPropagation()
                  void api.invoke('tabs:close', { tabId: t.id })
                }}
              >
                <IconClose />
              </button>
            </div>
          )
        })}
      </div>
      <button
        className="icon-btn new-tab"
        aria-label={`New tab (${mod}T)`}
        title={`New tab (${mod}T)`}
        onClick={() => void api.invoke('tabs:create', {})}
      >
        <IconPlus />
      </button>
      <div className="tabstrip-drag" />
    </div>
  )
}
