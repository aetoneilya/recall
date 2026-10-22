import { emptyLibraryFilter } from './library.ts'

// The Cards tab's search, filters and scroll, kept across visits so Back
// from a card lands where the list was left.
export const wordsView = $state({
  filter: emptyLibraryFilter(),
  scrollTop: 0,
  scroller: undefined as HTMLElement | undefined,
})
