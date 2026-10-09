import type { Bookmark, TabInfo } from '@shared/types'
import { api, openInNewTab } from '../lib/api'

function faviconLetter(b: Bookmark): string {
  try {
    return new URL(b.url).hostname
      .replace(/^www\./, '')
      .charAt(0)
      .toUpperCase()
  } catch {
    return '•'
  }
}

/**
 * Bookmarks under the toolbar. A click opens the bookmark in the current tab (a new tab if the
 * current one is an AI or built-in page); ⌘/Ctrl-click or a middle click opens a new tab.
 */
export function BookmarksBar({
  list,
  activeTab,
  onShowAll
}: {
  list: Bookmark[]
  activeTab: TabInfo | null
  onShowAll: () => void
}) {
  const open = (b: Bookmark, newTab: boolean): void => {
    if (newTab || !activeTab || activeTab.ai !== null || activeTab.page !== null)
      openInNewTab(b.url)
    else void api.invoke('tabs:navigate', { tabId: activeTab.id, input: b.url })
  }
  return (
    <nav className="bookmarks-bar" aria-label="Bookmarks">
      {list.map((b) => (
        <button
          key={b.id}
          className="bookmark-chip"
          title={`${b.title}\n${b.url}`}
          onClick={(e) => open(b, e.metaKey || e.ctrlKey)}
          onAuxClick={(e) => e.button === 1 && open(b, true)}
        >
          <span className="bookmark-icon" aria-hidden="true">
            {faviconLetter(b)}
          </span>
          <span className="bookmark-title">{b.title}</span>
        </button>
      ))}
      <button className="bookmark-chip all" onClick={onShowAll}>
        All bookmarks
      </button>
    </nav>
  )
}
