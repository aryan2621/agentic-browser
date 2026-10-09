/**
 * Answer styles for Search mode's Summary tab. Each style decides how many results are read, how
 * long the answer may be and how it is structured. Adding a style is one entry here; the Settings
 * dropdown and the main process pick it up automatically.
 */
export interface SearchAnswerMode {
  id: string
  label: string
  description: string
  /** How many top results to read (DuckDuckGo returns up to 10). More = broader but slower. */
  sources: number
  /** Upper bound on the answer length, in tokens. */
  maxTokens: number
  /** Answer structure given to the model (Markdown, citations required). */
  instructions: string[]
}

export const SEARCH_ANSWER_MODES = [
  {
    id: 'quick',
    label: 'Quick answer',
    description: 'A clear answer, the key facts and useful details.',
    sources: 6,
    maxTokens: 1300,
    instructions: [
      '1. A direct answer in one or two short paragraphs (no heading).',
      '2. "## Key facts": 6-10 bullets with specific details, numbers, dates and names.',
      '3. "## Details": up to three short paragraphs of further context from the sources; omit if there is nothing more.',
      '4. "## Good to know": up to three bullets of tips or caveats stated in the sources; omit if none.'
    ]
  },
  {
    id: 'detailed',
    label: 'Detailed',
    description: 'An in-depth answer from many sources: concepts, steps, numbers and debate.',
    sources: 10,
    maxTokens: 2200,
    instructions: [
      '1. "## Summary": one or two paragraphs that answer the query.',
      '2. "## Details": 3-6 subsections ("### ..."), each with a short paragraph and bullets covering every important point across the sources. For a how-to question, make one subsection "### Steps" with a numbered list; for a concept, explain how and why it works.',
      '3. "## Facts and numbers": bullets with the specific figures, dates and names from the sources; omit if there are none.',
      '4. "## Where sources agree or differ": what is settled and what is disputed, citing each side; omit if the sources do not compare.',
      '5. "## Open questions": parts of the query the sources leave unanswered; omit if none.'
    ]
  },
  {
    id: 'compare',
    label: 'Compare',
    description: 'Options side by side, with pros, cons and a recommendation.',
    sources: 8,
    maxTokens: 1800,
    instructions: [
      '1. A short verdict in two or three sentences (no heading).',
      '2. "## Comparison": a Markdown table comparing the options on criteria the sources cover; write "—" where a source gives no value.',
      '3. "## Pros and cons": for each option, a bold name followed by its pros and cons as bullets.',
      '4. "## Which to choose": when each option fits better, only as the sources describe it.'
    ]
  }
] as const satisfies readonly SearchAnswerMode[]

export type SearchAnswerModeId = (typeof SEARCH_ANSWER_MODES)[number]['id']

export const SEARCH_ANSWER_MODE_IDS = SEARCH_ANSWER_MODES.map((m) => m.id) as [
  SearchAnswerModeId,
  ...SearchAnswerModeId[]
]

/** Styles removed in earlier versions; a saved value maps to the style that replaced it. */
const LEGACY_MODE_IDS: Record<string, SearchAnswerModeId> = {
  research: 'detailed',
  theory: 'detailed',
  simple: 'detailed',
  steps: 'detailed',
  facts: 'detailed'
}

export function migrateSearchAnswerModeId(id: unknown): unknown {
  return typeof id === 'string' ? (LEGACY_MODE_IDS[id] ?? id) : id
}

/** Bounds for the "Sources to read" setting (DuckDuckGo returns up to 10 results). */
export const MIN_SEARCH_SOURCES = 1
export const MAX_SEARCH_SOURCES = 10

export function searchAnswerMode(id: string): SearchAnswerMode {
  return SEARCH_ANSWER_MODES.find((m) => m.id === id) ?? SEARCH_ANSWER_MODES[0]
}
