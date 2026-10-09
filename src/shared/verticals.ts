/**
 * Buttons in an AI tab's header that open a search engine's own vertical (images, videos, ...)
 * for the question in a new browser tab. Adding one is one entry here.
 */
export interface SearchVertical {
  id: string
  label: string
  url: (query: string) => string
}

const q = encodeURIComponent

export const SEARCH_VERTICALS: SearchVertical[] = [
  {
    id: 'images',
    label: 'Images',
    url: (query) => `https://duckduckgo.com/?q=${q(query)}&iax=images&ia=images`
  },
  {
    id: 'videos',
    label: 'Videos',
    url: (query) => `https://duckduckgo.com/?q=${q(query)}&iax=videos&ia=videos`
  },
  {
    id: 'news',
    label: 'News',
    url: (query) => `https://duckduckgo.com/?q=${q(query)}&iar=news&ia=news`
  },
  {
    id: 'maps',
    label: 'Maps',
    url: (query) => `https://www.openstreetmap.org/search?query=${q(query)}`
  }
]
