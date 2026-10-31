// The daily introduction order. Reviews and new directions of familiar
// words keep their own slots; only first encounters get a gentle curriculum.
import { CEFR_LEVELS, type Cefr, type PartOfSpeech } from './types.ts'
import { wordTopic } from './wordTopics.ts'

export interface NewStudyItem {
  id: string
  kind: 'word' | 'fact'
  createdAt: string
  tags: string[]
  term?: string
  pos?: PartOfSpeech | null
  cefr?: Cefr | null
  freqRank?: number | null
  language?: string | null
  familiar?: boolean
}

// Independent keys keep each day's choices reproducible in Node and the app.
function random(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  h ^= h >>> 16
  h = Math.imul(h, 0x45d9f3b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// Without a CEFR estimate, frequency gives a rough starting band, not a
// claim about the sense's CEFR. Unranked expressions start in the middle.
function level(item: NewStudyItem): number {
  const cefr = item.cefr ? CEFR_LEVELS.indexOf(item.cefr) : -1
  if (cefr >= 0) return cefr
  if (!item.freqRank) return 2
  const band = [1000, 2500, 5000, 10000, 20000].findIndex((n) => item.freqRank! <= n)
  return band < 0 ? 5 : band
}

function mixSources(items: NewStudyItem[]): NewStudyItem[] {
  const sources = new Map<string, NewStudyItem[]>()
  for (const item of items) {
    const source = item.tags[0]?.split('/')[0] ?? `:${item.kind}`
    const list = sources.get(source) ?? []
    list.push(item)
    sources.set(source, list)
  }
  const out: NewStudyItem[] = []
  for (let i = 0; out.length < items.length; i++) for (const list of sources.values()) if (list[i]) out.push(list[i]!)
  return out
}

function curriculum(items: NewStudyItem[], day: string): NewStudyItem[] {
  const at = Date.parse(`${day}T00:00:00Z`)
  const candidates = items.flatMap((item) => {
    if (item.kind !== 'word' || item.familiar) return []
    const topic = wordTopic({ term: item.term ?? '', pos: item.pos, tags: item.tags, language: item.language })
    // A card without any signal keeps its chronological/source slot.
    if (!topic && !item.cefr && !item.freqRank) return []
    const age = Math.max(0, (at - Date.parse(item.createdAt)) / 86_400_000) || 0
    const band = Math.max(-1, level(item) - Math.floor(age / 90))
    const frequency = item.freqRank ? Math.min(0.8, Math.log10(Math.max(1, item.freqRank)) / 6) : 0.8
    return [{ item, topic, key: `${topic ?? ':unthemed'}:${band}`, band, score: band + frequency - Math.min(age / 3650, 0.2) + random(`${day}:${item.id}`) * 0.08 }]
  })
  type Candidate = typeof candidates[number]
  const buckets = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const list = buckets.get(c.key) ?? []
    list.push(c)
    buckets.set(c.key, list)
  }
  for (const list of buckets.values()) list.sort((a, b) => a.score - b.score || a.item.createdAt.localeCompare(b.item.createdAt) || a.item.id.localeCompare(b.item.id))
  const ordered: NewStudyItem[] = []
  const focus = new Set<string | null>()
  let previous: string | null = null
  let block = 0
  while (buckets.size) {
    const heads = [...buckets.values()].map((list) => list[0]!)
    const floor = Math.min(...heads.map((c) => c.band))
    // Four blocks in the easiest available band, then a taste of the next.
    const explore = block % 5 === 4 && heads.some((c) => c.band === floor + 1)
    const band = floor + Number(explore)
    const ready = heads.filter((c) => c.band === band)
      .sort((a, b) => (a.score - random(`${day}:${block}:${a.key}`) * 0.25) - (b.score - random(`${day}:${block}:${b.key}`) * 0.25) || a.item.id.localeCompare(b.item.id))
    for (const topic of focus) if (!heads.some((c) => c.topic === topic)) focus.delete(topic)
    for (const c of ready) if (focus.size < 3) focus.add(c.topic)
    const focused = ready.filter((c) => focus.has(c.topic))
    const pool = focused.length ? focused : ready
    const picked = pool.find((c) => c.topic !== previous) ?? pool[0]!
    const list = buckets.get(picked.key)!
    const length = picked.topic ? 2 + Number(random(`${day}:${block}:length`) >= 0.5) : 1
    for (let i = 0; i < length && list[0]?.band === band; i++) ordered.push(list.shift()!.item)
    if (!list.length) buckets.delete(picked.key)
    previous = picked.topic
    block++
  }
  const ranked = new Set(candidates.map((c) => c.item.id))
  let i = 0
  return items.map((item) => ranked.has(item.id) ? ordered[i++]! : item)
}

// Persist the returned ids for the study day. Ratings, filter previews and
// restarts then only remove cards; newly added/unlocked items append. The
// following study day starts a fresh plan with new themes and age bonuses.
export function newItemOrder(items: NewStudyItem[], day: string, previous: readonly string[] = []): string[] {
  const known = new Set(previous)
  const added = items.filter((item) => !known.has(item.id))
  return [...previous, ...curriculum(mixSources(added), day).map((item) => item.id)]
}
