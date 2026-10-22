// Drill-down options for the review filter sheet (and the web's Cards tab):
// each option's count is how many cards the filter would match with that
// option added (inReviewFilter: AND everywhere, tags by prefix).
import { tagAncestors } from './tags.ts'
import { inReviewFilter, type CardFacts, type CardType, type Cefr, type Direction, type PartOfSpeech, type ReviewFilter } from './types.ts'

// One word or fact. A word lists its enabled directions (one card each); a
// word without them is treated as one card that any direction passes.
export interface FacetItem {
  type: CardType
  tags: string[]
  pos?: PartOfSpeech | null
  cefr?: Cefr | null
  directions?: Direction[]
}

export interface FacetOption<T extends string> {
  value: T
  n: number
}

export interface FacetOptions {
  types: FacetOption<CardType>[]
  tags: FacetOption<string>[]
  pos: FacetOption<PartOfSpeech>[]
  cefr: FacetOption<Cefr>[]
  directions: FacetOption<Direction>[]
}

type Facet = keyof FacetOptions

const cardOf = (it: FacetItem, direction?: Direction): CardFacts => ({ type: it.type, tags: it.tags, pos: it.pos ?? null, cefr: it.cefr ?? null, direction })

// Words and facts count once (a word when one of its cards passes), except
// for `directions`, where a word counts once per card that passes. A
// word-only facet counts words only: other cards pass its values, but
// don't carry them ("noun" next to a selected "verb" matches no card).
const WORD_ONLY: readonly Facet[] = ['pos', 'cefr', 'directions']

function count(items: readonly FacetItem[], f: ReviewFilter, k: Facet): number {
  const perCard = k === 'directions'
  let n = 0
  for (const it of items) {
    if (it.type !== 'word' && WORD_ONLY.includes(k)) continue
    if (it.type !== 'word' || !it.directions?.length) n += inReviewFilter(f, cardOf(it)) ? 1 : 0
    else if (perCard) n += it.directions.filter((d) => inReviewFilter(f, cardOf(it, d))).length
    else n += it.directions.some((d) => inReviewFilter(f, cardOf(it, d))) ? 1 : 0
  }
  return n
}

// What a facet could take: values the items have (tags with every ancestor
// path, so a parent's count is exact rather than a sum of its children).
function candidates(items: readonly FacetItem[], k: Facet): Set<string> {
  const out = new Set<string>()
  for (const it of items) {
    if (k === 'types') out.add(it.type)
    else if (k === 'tags') for (const t of it.tags) [...tagAncestors(t), t].forEach((x) => out.add(x))
    else if (it.type !== 'word') continue
    else if (k === 'directions') (it.directions ?? []).forEach((d) => out.add(d))
    else if (it[k]) out.add(it[k]!)
  }
  return out
}

// Per facet, options with n > 0 under the filter plus that option, and every
// selected one even at 0; most first, then by name. The word-only facets
// (pos, cefr, directions) are empty when the selected types leave no words.
export function facetOptions(items: readonly FacetItem[], filter: ReviewFilter | null | undefined): FacetOptions {
  const f = filter ?? {}
  const options = <K extends Facet>(k: K): FacetOptions[K] => {
    const selected = (f[k] ?? []) as string[]
    const values = new Set([...candidates(items, k), ...selected])
    const out: FacetOption<string>[] = []
    for (const v of values) {
      const plus = { ...f, [k]: [...new Set([...selected, v])] }
      const n = count(items, plus, k)
      if (n > 0 || selected.includes(v)) out.push({ value: v, n })
    }
    return out.sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)) as FacetOptions[K]
  }
  const noWords = !!f.types?.length && f.types.some((t) => t !== 'word')
  return {
    types: options('types'),
    tags: options('tags'),
    pos: noWords ? [] : options('pos'),
    cefr: noWords ? [] : options('cefr'),
    directions: noWords ? [] : options('directions'),
  }
}
