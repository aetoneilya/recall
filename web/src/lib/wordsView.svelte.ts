import { emptyFactFilter } from './factFilter.ts'
import { emptyFilter } from './wordFilter.ts'

const KIND_KEY = 'libraryKind'
function readKind(): 'words' | 'facts' {
  try {
    return localStorage.getItem(KIND_KEY) === 'facts' ? 'facts' : 'words'
  } catch {
    return 'words'
  }
}

// The Words tab's state, kept across visits so Back from a word or fact
// lands where the list was left: which collection (words or topic facts),
// its search, filters and scroll.
export const wordsView = $state({
  kind: readKind(),
  filter: emptyFilter(),
  scrollTop: 0,
  scroller: undefined as HTMLElement | undefined,
  factFilter: emptyFactFilter(),
  factScrollTop: 0,
  factScroller: undefined as HTMLElement | undefined,
})

export function setLibraryKind(kind: 'words' | 'facts') {
  wordsView.kind = kind
  try {
    localStorage.setItem(KIND_KEY, kind)
  } catch {
    // Storage unavailable: the choice lasts for this visit.
  }
}
