import { emptyFilter } from './wordFilter.ts'

// The Words screen's search, filters and scroll, kept across visits so
// Back from a word lands where the list was left.
export const wordsView = $state({
  filter: emptyFilter(),
  scrollTop: 0,
  scroller: undefined as HTMLElement | undefined,
})
