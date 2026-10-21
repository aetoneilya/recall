// In-memory fake of the REST API (DESIGN.md "REST API"), used with `?mock`.
// Implements the queue rules (learning first, reviews, new interleaved,
// one card per word per day, new-per-day, disabled directions, the reverse
// gate), autofill, the dashboard and the vocabulary test closely enough to
// exercise every screen. Loaded via dynamic import only in mock mode.
import {
  cleanWord,
  DEFAULT_WEIGHTS,
  dayKey,
  dedupeKey,
  newCardState,
  nextDayStart,
  normalizeTerm,
  retrievability,
  review,
  type Card,
  type CardState,
  type Deck,
  type Direction,
  type QueueItem,
  type Rating,
  type ReviewInput,
  type ReviewLog,
  type Word,
  type WordInput,
} from '@recall/core'
import type { CardSummary, Dashboard, Draft, Placement, ScalePoint, TestResult, TypeAnswer, VocabEstimate, WordItem } from '../lib/types.ts'
import { autofillDictionary, baselineSrs, pseudowords, scale, testBands, words as seedWords, type Plan, type SeedWord } from './seed.ts'

const DAY = { timeZone: 'Europe/Moscow', startHour: 4 }
const H = 3600_000
const D = 24 * H

// `?mock` variants: `login` starts signed out (bot login confirms itself ~3 s
// after the first poll; password: recall), `nobot` signed out with the bot
// off (password only), `denied` a Telegram account that isn't allowed,
// `bearer` signed in with an API token (no token management), `noautofill`
// autofill not configured (503), `empty` a new account with no words yet.
const variant = new URLSearchParams(location.search).get('mock') ?? ''

export const mockControl = {
  offline: false,
  authed: !['login', 'nobot'].includes(variant),
  bot: variant !== 'nobot',
  denied: variant === 'denied',
  autofill: variant !== 'noautofill',
  latencyMs: 120,
  // Extra wait for autofill, like a real model call.
  autofillMs: 400,
}
;(window as unknown as { __recallMock: typeof mockControl }).__recallMock = mockControl

type MockDeck = Deck & { typeAnswer: TypeAnswer }

interface TestRow {
  id: string
  items: { id: string; word: string; kind: 'real' | 'pseudo'; band: number | null }[]
  result: TestResult | null
  createdAt: string
  completedAt: string | null
}

const db = {
  decks: [] as MockDeck[],
  words: [] as Word[],
  cards: [] as Card[],
  logs: [] as ReviewLog[],
  tests: [] as TestRow[],
}

let seq = 0
const id = (prefix: string) => `${prefix}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

// Deterministic randomness, so the mock looks the same on every load.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Term (without "to ") → frequency rank, for words added in the mock.
const ranks = new Map<string, number>()

const iso = (t: number) => new Date(t).toISOString()

function planState(plan: Plan, k: number, now: number): { state: CardState; suspended: boolean } {
  const base = { difficulty: 3 + (k % 6), learningSteps: 0, reps: 3 + (k % 6), lapses: k % 4 === 0 ? 1 : 0 }
  const reviewState = (stability: number, lastReview: number): CardState => ({
    ...base,
    due: iso(lastReview + stability * D),
    stability,
    elapsedDays: Math.round((now - lastReview) / D),
    scheduledDays: Math.round(stability),
    state: 2,
    lastReview: iso(lastReview),
  })
  switch (plan) {
    case 'new':
      return { state: newCardState(new Date(now)), suspended: false }
    case 'learning':
      return {
        state: { ...base, due: iso(now - 2 * 60_000), stability: 1.2, difficulty: 6.8, elapsedDays: 0, scheduledDays: 0, reps: 7, lapses: 2, state: 3, lastReview: iso(now - 12 * 60_000) },
        suspended: false,
      }
    case 'due': {
      // Overdue by a day or two: R has dropped below 0.9 (fading).
      const s = 4 + (k % 9)
      return { state: reviewState(s, now - (s + 1 + (k % 3)) * D), suspended: false }
    }
    case 'later':
    case 'suspended': {
      const s = 6 + (k % 13)
      return { state: reviewState(s, now - Math.floor(s * 0.4) * D - 3 * H), suspended: plan === 'suspended' }
    }
    case 'mastered': {
      const s = 25 + ((k * 7) % 60)
      return { state: reviewState(s, now - ((k % 10) + 2) * D), suspended: false }
    }
  }
}

function seed() {
  const now = Date.now()
  const eng: MockDeck = {
    id: 'dk_english',
    name: 'English',
    targetLang: 'en',
    nativeLang: 'ru',
    newPerDay: 10,
    forwardEnabled: true,
    reverseEnabled: true,
    reverseAfterDays: null,
    typeAnswer: 'reverse',
    createdAt: iso(now - 150 * D),
  }
  db.decks.push(eng)
  if (variant === 'empty') return
  const inboxCount = seedWords.filter((s) => s.plan === 'inbox' || s.plan === 'rejected').length
  let inboxK = 0
  seedWords.forEach((s: SeedWord, k) => {
    if (s.freqRank !== null) ranks.set(normalizeTerm(s.term), s.freqRank)
    const proposal = s.plan === 'inbox' || s.plan === 'rejected'
    const createdAt = proposal ? iso(now - (inboxCount - inboxK++) * 5 * H) : iso(now - (140 - k * 3) * D)
    const word: Word = {
      id: id('wd'),
      deckId: eng.id,
      term: s.term,
      pos: s.pos,
      translations: s.translations,
      ipa: s.ipa,
      examples: s.examples,
      note: s.note ?? null,
      source: s.source ?? null,
      tags: s.tags ?? [],
      freqRank: s.freqRank,
      cefr: s.cefr,
      status: s.plan === 'inbox' ? 'inbox' : s.plan === 'rejected' ? 'rejected' : 'active',
      createdBy: proposal ? 'claude' : k % 3 === 0 ? 'user' : 'import',
      createdAt,
      updatedAt: createdAt,
    }
    db.words.push(word)
    const plans: [Plan, Plan] = Array.isArray(s.plan) ? s.plan : ['new', 'new']
    ;(['forward', 'reverse'] as const).forEach((direction, i) => {
      const p = planState(plans[i]!, k * 2 + i, now)
      db.cards.push({ id: id('cd'), wordId: word.id, direction, suspended: p.suspended, schedule: p.state })
    })
  })
  for (const [k, e] of Object.entries(autofillDictionary)) if (e.freqRank !== null) ranks.set(k, e.freqRank)

  // 90 study days of history: a current streak of 9 (through yesterday),
  // a longest run of 23, and ~60% of the other days.
  const r = rng(42)
  const reviewed = db.cards.filter((c) => c.schedule.state !== 0)
  for (let d = 89; d >= 1; d--) {
    const studied = d <= 9 || (d >= 38 && d <= 60) || (d !== 10 && d !== 37 && d !== 61 && r() < 0.6)
    if (!studied) continue
    const n = 10 + Math.floor(r() * 30)
    for (let i = 0; i < n; i++) {
      const c = reviewed[Math.floor(r() * reviewed.length)]!
      const x = r()
      const againP = c.direction === 'forward' ? 0.12 : 0.21
      const rating: Rating = x < againP ? 1 : x < againP + 0.08 ? 2 : x < 0.93 ? 3 : 4
      const before = { ...c.schedule, state: (r() < 0.85 ? 2 : 1) as CardState['state'] }
      db.logs.push({
        id: id('lg'),
        cardId: c.id,
        rating,
        reviewedAt: iso(now - d * D - (n - i) * 90_000),
        durationMs: Math.round(3000 + r() * 9000),
        before,
        after: before,
      })
    }
  }
}

seed()

// --- helpers ---------------------------------------------------------------

const deckOf = (deckId: string) => db.decks.find((d) => d.id === deckId)!
const wordOf = (wordId: string) => db.words.find((w) => w.id === wordId)!
const cardsOf = (wordId: string) => db.cards.filter((c) => c.wordId === wordId)
const today = (now: Date) => dayKey(now, DAY)
const isToday = (at: string, now: Date) => dayKey(new Date(at), DAY) === today(now)
const enabled = (deck: Deck, dir: Direction) => (dir === 'forward' ? deck.forwardEnabled : deck.reverseEnabled)
const known = (s: CardState, at: Date) => s.state === 2 && retrievability(s, at) >= 0.9
const STATE_NAMES = ['new', 'learning', 'review', 'relearning'] as const

function resolveDeck(ref: string | null | undefined): MockDeck | null {
  if (!ref) return db.decks[0] ?? null
  const r = ref.toLowerCase()
  return db.decks.find((d) => d.id === ref || d.name.toLowerCase() === r || d.targetLang === r) ?? null
}

function mustDeck(ref: string | null | undefined): MockDeck {
  const d = resolveDeck(ref)
  if (!d) throw new Fail(404, 'deck not found')
  return d
}

function summary(card: Card, now: Date): CardSummary {
  const s = card.schedule
  const deck = deckOf(wordOf(card.wordId).deckId)
  return {
    id: card.id,
    direction: card.direction,
    enabled: enabled(deck, card.direction),
    suspended: card.suspended,
    state: STATE_NAMES[s.state],
    due: s.due,
    stability: Math.round(s.stability * 100) / 100,
    difficulty: Math.round(s.difficulty * 100) / 100,
    reps: s.reps,
    lapses: s.lapses,
    lastReview: s.lastReview,
    retrievability: s.state === 0 ? null : Math.round(retrievability(s, now) * 1000) / 1000,
  }
}

function item(w: Word, now: Date): WordItem {
  const cs = cardsOf(w.id)
  const pick = (dir: Direction) => {
    const c = cs.find((x) => x.direction === dir)
    return c ? summary(c, now) : null
  }
  return { ...w, deckName: deckOf(w.deckId).name, cards: { forward: pick('forward'), reverse: pick('reverse') } }
}

function mustWord(wordId: string): Word {
  const w = db.words.find((x) => x.id === wordId)
  if (!w) throw new Fail(404, `word ${wordId} not found`)
  return w
}

function rankOf(term: string): number | null {
  return ranks.get(normalizeTerm(term)) ?? null
}

// Single-word lemma of a term ("to frown" → "frown"), or null for phrases.
function lemma(term: string): string | null {
  const t = normalizeTerm(term).replace(/[^\p{L}' -]/gu, '')
  return t && !/\s/.test(t) ? t : null
}

// --- queue -----------------------------------------------------------------

function buildQueue(now: Date, limit: number, deckId?: string) {
  const dayEnd = nextDayStart(now, DAY).getTime()
  const words = new Map(db.words.filter((w) => w.status === 'active' && (!deckId || w.deckId === deckId)).map((w) => [w.id, w]))
  const reviewedToday = new Map<string, Set<string>>()
  const firstLog = new Map<string, string>()
  for (const l of db.logs) {
    const f = firstLog.get(l.cardId)
    if (!f || l.reviewedAt < f) firstLog.set(l.cardId, l.reviewedAt)
    if (!isToday(l.reviewedAt, now)) continue
    const c = db.cards.find((x) => x.id === l.cardId)
    if (!c) continue
    if (!reviewedToday.has(c.wordId)) reviewedToday.set(c.wordId, new Set())
    reviewedToday.get(c.wordId)!.add(c.id)
  }
  const cards = db.cards.filter((c) => {
    const w = words.get(c.wordId)
    return w && !c.suspended && enabled(deckOf(w.deckId), c.direction)
  })
  const dueT = (c: Card) => new Date(c.schedule.due).getTime()
  const learning = cards.filter((c) => (c.schedule.state === 1 || c.schedule.state === 3) && dueT(c) < dayEnd).sort((a, b) => dueT(a) - dueT(b))
  const reviews = cards.filter((c) => c.schedule.state === 2 && dueT(c) < dayEnd).sort((a, b) => dueT(a) - dueT(b))

  const introduced = new Map<string, number>()
  for (const c of cards) {
    const f = firstLog.get(c.id)
    if (f && isToday(f, now)) {
      const d = words.get(c.wordId)!.deckId
      introduced.set(d, (introduced.get(d) ?? 0) + 1)
    }
  }
  const budget = new Map(db.decks.map((d) => [d.id, Math.max(0, d.newPerDay - (introduced.get(d.id) ?? 0))]))
  // The reverse gate: a new reverse card waits until its forward card is
  // out of the new state and stable enough (ignored while forward is off).
  const gated = (c: Card) => {
    if (c.direction !== 'reverse') return false
    const deck = deckOf(words.get(c.wordId)!.deckId)
    if (deck.reverseAfterDays === null || !deck.forwardEnabled) return false
    const fwd = cardsOf(c.wordId).find((x) => x.direction === 'forward')
    return !fwd || fwd.schedule.state === 0 || fwd.schedule.stability < deck.reverseAfterDays
  }
  const fresh = cards
    .filter((c) => c.schedule.state === 0 && !gated(c))
    .sort((a, b) => words.get(a.wordId)!.createdAt.localeCompare(words.get(b.wordId)!.createdAt) || (a.direction === 'forward' ? -1 : 1))

  const out: Card[] = []
  const seenWords = new Set<string>()
  // One card per word per day: skip a card whose sibling was reviewed today
  // or is earlier in this queue.
  const ok = (c: Card) => {
    const r = reviewedToday.get(c.wordId)
    if (r && !r.has(c.id)) return false
    return !seenWords.has(c.wordId)
  }
  const push = (c: Card) => {
    seenWords.add(c.wordId)
    out.push(c)
  }
  // Learning cards are mid-flight and never buried.
  for (const c of learning) push(c)
  let ni = 0
  const nextNew = () => {
    while (ni < fresh.length) {
      const c = fresh[ni++]!
      const d = words.get(c.wordId)!.deckId
      if (ok(c) && (budget.get(d) ?? 0) > 0) {
        budget.set(d, budget.get(d)! - 1)
        return c
      }
    }
    return null
  }
  let sinceNew = 0
  for (const c of reviews) {
    if (!ok(c)) continue
    push(c)
    if (++sinceNew === 4) {
      sinceNew = 0
      const n = nextNew()
      if (n) push(n)
    }
  }
  for (let n = nextNew(); n; n = nextNew()) push(n)

  const items: QueueItem[] = out.slice(0, limit).map((c) => {
    const word = words.get(c.wordId)!
    return { card: c, word, deckName: deckOf(word.deckId).name }
  })
  const count = (s: number[]) => out.filter((c) => s.includes(c.schedule.state)).length
  return {
    out,
    items,
    counts: { new: count([0]), learning: count([1, 3]), review: count([2]) },
    inbox: db.words.filter((w) => w.status === 'inbox' && (!deckId || w.deckId === deckId)).length,
  }
}

function deckCounts(deck: MockDeck, now: Date) {
  const dayEnd = nextDayStart(now, DAY).getTime()
  const words = db.words.filter((w) => w.deckId === deck.id)
  const active = new Set(words.filter((w) => w.status === 'active').map((w) => w.id))
  const cards = db.cards.filter((c) => active.has(c.wordId) && !c.suspended && enabled(deck, c.direction))
  const knownWords = new Set(cards.filter((c) => known(c.schedule, now)).map((c) => c.wordId))
  return {
    total: words.length,
    active: active.size,
    inbox: words.filter((w) => w.status === 'inbox').length,
    known: knownWords.size,
    learning: cards.filter((c) => c.schedule.state === 1 || c.schedule.state === 3).length,
    due: cards.filter((c) => c.schedule.state !== 0 && new Date(c.schedule.due).getTime() < dayEnd).length,
    new: buildQueue(now, 10_000, deck.id).out.filter((c) => c.schedule.state === 0).length,
    newTotal: cards.filter((c) => c.schedule.state === 0).length,
  }
}

// --- words -----------------------------------------------------------------

type Body = Record<string, unknown>

function duplicateOf(deckId: string, term: string, pos: Word['pos'], except?: string): Word | null {
  const key = dedupeKey(term, pos)
  return db.words.find((w) => w.deckId === deckId && w.id !== except && dedupeKey(w.term, w.pos) === key) ?? null
}

function dupError(existing: Word): Fail {
  return new Fail(409, `"${existing.term}" (${existing.pos}) is already in this deck`, { existing })
}

function createWord(body: Body, now: Date): Word {
  const deck = mustDeck(body.deckId as string | undefined)
  const r = cleanWord(body as unknown as WordInput)
  if ('error' in r) throw new Fail(400, r.error)
  const dup = duplicateOf(deck.id, r.word.term, r.word.pos)
  if (dup) throw dupError(dup)
  const word: Word = {
    id: id('wd'),
    deckId: deck.id,
    ...r.word,
    freqRank: rankOf(r.word.term),
    status: 'active',
    createdBy: 'user',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  db.words.push(word)
  for (const direction of ['forward', 'reverse'] as const) db.cards.push({ id: id('cd'), wordId: word.id, direction, suspended: false, schedule: newCardState(now) })
  return word
}

const PATCH_KEYS = ['term', 'pos', 'translations', 'ipa', 'examples', 'note', 'source', 'tags', 'cefr', 'status']

function updateWord(w: Word, body: Body, now: Date): Word {
  for (const k of Object.keys(body)) if (!PATCH_KEYS.includes(k)) throw new Fail(400, `unknown key ${k}`)
  const merged = { ...w, ...body } as unknown as WordInput
  const r = cleanWord(merged)
  if ('error' in r) throw new Fail(400, r.error)
  const dup = duplicateOf(w.deckId, r.word.term, r.word.pos, w.id)
  if (dup) throw dupError(dup)
  if ('status' in body) {
    if (!['inbox', 'active', 'rejected'].includes(String(body.status))) throw new Fail(400, 'unknown status')
    w.status = body.status as Word['status']
  }
  Object.assign(w, r.word, { freqRank: rankOf(r.word.term) ?? (r.word.term === w.term ? w.freqRank : null), updatedAt: now.toISOString() })
  return w
}

function searchWords(url: URL, now: Date) {
  const p = url.searchParams
  const q = (p.get('q') ?? '').trim().toLowerCase()
  const deck = p.get('deck') ? resolveDeck(p.get('deck')) : null
  if (p.get('deck') && !deck) return { words: [], total: 0 }
  const status = p.get('status')
  const pos = p.get('pos')
  const cefr = p.get('cefr')
  const tag = p.get('tag')
  const sort = p.get('sort') ?? 'recent'
  const limit = Math.min(500, Math.max(1, Number(p.get('limit') ?? 50) || 50))
  const offset = Math.max(0, Number(p.get('offset') ?? 0) || 0)
  const haystack = (w: Word) =>
    [w.term, ...w.translations, ...w.examples.flatMap((e) => [e.text, e.translation ?? '']), w.note ?? '', ...w.tags, w.source ?? ''].join('\n').toLowerCase()
  const maxOf = (w: Word, f: (c: Card) => number) => Math.max(0, ...cardsOf(w.id).map(f))
  const all = db.words
    .filter((w) => (!deck || w.deckId === deck.id) && (!status || w.status === status) && (!pos || w.pos === pos) && (!cefr || w.cefr === cefr) && (!tag || w.tags.includes(tag)))
    .filter((w) => !q || haystack(w).includes(q))
    .sort((a, b) => {
      if (sort === 'alpha') return normalizeTerm(a.term).localeCompare(normalizeTerm(b.term))
      if (sort === 'freq') return (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity) || normalizeTerm(a.term).localeCompare(normalizeTerm(b.term))
      if (sort === 'difficulty')
        return maxOf(b, (c) => c.schedule.lapses) - maxOf(a, (c) => c.schedule.lapses) || maxOf(b, (c) => c.schedule.difficulty) - maxOf(a, (c) => c.schedule.difficulty)
      return b.createdAt.localeCompare(a.createdAt)
    })
  return { words: all.slice(offset, offset + limit).map((w) => item(w, now)), total: all.length }
}

// --- autofill --------------------------------------------------------------

function autofill(body: Body) {
  if (!mockControl.autofill) throw new Fail(503, 'autofill is not configured')
  const term = String(body.term ?? '').replace(/\s+/g, ' ').trim()
  if (!term) throw new Fail(400, 'term is empty')
  if (term.length > 200) throw new Fail(400, 'term is longer than 200 characters')
  const deck = mustDeck(body.deckId as string | undefined)
  const key = normalizeTerm(term)
  if (key.startsWith('zz')) throw new Fail(502, 'autofill failed')
  const hint = String(body.hint ?? '').toLowerCase()
  const entry = autofillDictionary[key]
  let senses: Draft[]
  let freqRank: number | null
  if (entry) {
    const picked = hint ? entry.senses.findIndex((s) => s.keys?.some((k) => hint.includes(k))) : -1
    const ordered = picked > 0 ? [entry.senses[picked]!, ...entry.senses.filter((_, i) => i !== picked)] : entry.senses
    senses = ordered.map(({ keys: _k, ...s }) => structuredClone(s))
    freqRank = entry.freqRank
  } else {
    const multi = /\s/.test(key)
    const verb = /^to\s/i.test(term)
    const draft: Draft = {
      term,
      pos: verb ? 'verb' : multi ? 'phrase' : 'noun',
      translations: [`перевод: ${key}`],
      ipa: null,
      examples: [{ text: hint && hint.includes(key) ? String(body.hint) : `I came across "${key}" in a book.`, translation: `Я встретил «${key}» в книге.` }],
      note: null,
      cefr: 'B2',
    }
    senses = [draft, { ...draft, pos: multi ? 'idiom' : 'adjective', translations: [`ещё одно значение: ${key}`], examples: [], cefr: 'C1' }]
    freqRank = rankOf(term)
  }
  const [draft, ...alternatives] = senses
  return { draft: draft!, alternatives, freqRank, duplicate: duplicateOf(deck.id, draft!.term, draft!.pos) }
}

// --- dashboard and vocabulary ------------------------------------------------

const BAND = 1000
const BANDS = testBands.length
const CAL = scale.calibration
const POINTS = scale.points as ScalePoint[]

function scalePosition(points: ScalePoint[], size: number): Placement {
  let level: ScalePoint | null = null
  for (const p of points) if (p.size <= size) level = p
  return { level, next: points.find((p) => p.size > size) ?? null }
}

function place(inList: number): Pick<VocabEstimate, 'nativeEquivalent' | 'cefr' | 'scale'> {
  const native = Math.round((CAL.adultSize * inList) / CAL.expectedInList)
  const groups: Record<string, Placement> = {}
  for (const g of new Set(POINTS.map((p) => p.group))) groups[g] = scalePosition(POINTS.filter((p) => p.group === g), g === 'learner' ? inList : native)
  return { nativeEquivalent: { value: native, approximate: true }, cefr: groups.learner ?? { level: null, next: null }, scale: groups }
}

// Lemmas known in the app per band: the baseline collection plus the
// seeded words that are known now.
function srsBands(now: Date, deckId?: string): number[] {
  const counts = [...baselineSrs]
  const seen = new Set<number>()
  for (const w of db.words) {
    if (w.status !== 'active' || (deckId && w.deckId !== deckId) || w.freqRank === null || !lemma(w.term) || seen.has(w.freqRank)) continue
    const deck = deckOf(w.deckId)
    if (!cardsOf(w.id).some((c) => !c.suspended && enabled(deck, c.direction) && known(c.schedule, now))) continue
    seen.add(w.freqRank)
    const b = Math.floor((w.freqRank - 1) / BAND)
    if (b < BANDS) counts[b]!++
  }
  return counts
}

interface Scored {
  known: number[]
  items: number[]
  yes: number[]
  interval: [number, number]
}

function estimate(srs: number[], test: Scored | null): VocabEstimate {
  const perBand = srs.map((n, i) => ({
    from: i * BAND + 1,
    to: (i + 1) * BAND,
    items: test?.items[i] ?? 0,
    yes: test?.yes[i] ?? 0,
    hitRate: test && test.items[i] ? test.yes[i]! / test.items[i]! : null,
    known: test?.known[i] ?? 0,
    srs: Math.min(1, n / BAND),
  }))
  const srsKnown = srs.reduce((a, b) => a + b, 0)
  const adjusted = Math.max(srsKnown, Math.round(perBand.reduce((s, b) => s + Math.max(b.known, b.srs) * BAND, 0)))
  return {
    estimate: test ? Math.round(perBand.reduce((s, b) => s + b.known * BAND, 0)) : null,
    interval: test?.interval ?? null,
    adjusted,
    srsKnown,
    basis: test ? 'test+app' : 'app',
    ...place(adjusted),
    perBand,
  }
}

// Pool-adjacent-violators for a non-increasing sequence, weighted.
function nonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = []
  values.forEach((v, i) => {
    blocks.push({ v, w: weights[i]!, n: 1 })
    while (blocks.length > 1 && blocks.at(-2)!.v < blocks.at(-1)!.v) {
      const b = blocks.pop()!
      const a = blocks.pop()!
      const w = a.w + b.w
      blocks.push({ v: w ? (a.v * a.w + b.v * b.w) / w : (a.v + b.v) / 2, w, n: a.n + b.n })
    }
  })
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.v))
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

function createTest(now: Date) {
  const have = new Set(db.words.map((w) => normalizeTerm(w.term)))
  const real = testBands.flatMap((ws, band) => shuffle(ws.filter((w) => !have.has(w))).slice(0, 3).map((word) => ({ word, kind: 'real' as const, band })))
  const nPseudo = Math.round((real.length * 0.25) / 0.75)
  const pseudo = shuffle(pseudowords).slice(0, nPseudo).map((word) => ({ word, kind: 'pseudo' as const, band: null }))
  const items = shuffle([...real, ...pseudo]).map((it, i) => ({ ...it, id: `q${i + 1}` }))
  const t: TestRow = { id: id('vt'), items, result: null, createdAt: now.toISOString(), completedAt: null }
  db.tests.push(t)
  return { testId: t.id, items: items.map(({ id, word }) => ({ id, word })) }
}

function answerTest(t: TestRow, answers: { id: string; known: boolean }[], now: Date): TestResult {
  if (t.completedAt) throw new Fail(409, 'this test has already been answered')
  const ids = new Set(t.items.map((i) => i.id))
  const map = new Map<string, boolean>()
  for (const a of answers ?? []) if (ids.has(a.id)) map.set(a.id, !!a.known)
  if (map.size < Math.ceil(t.items.length / 2)) throw new Fail(400, `answer at least half of the ${t.items.length} items`)
  const n = Array<number>(BANDS).fill(0)
  const yes = Array<number>(BANDS).fill(0)
  let pn = 0
  let py = 0
  for (const it of t.items) {
    const a = map.get(it.id)
    if (a === undefined) continue
    if (it.kind === 'pseudo') {
      pn++
      if (a) py++
    } else if (it.band !== null) {
      n[it.band]!++
      if (a) yes[it.band]!++
    }
  }
  const f = pn ? py / pn : 0
  const raw = n.map((k, i) => (k ? (f >= 1 ? 0 : Math.max(0, Math.min(1, (yes[i]! / k - f) / (1 - f)))) : null))
  const filled = raw.map((v, i) => {
    if (v !== null) return v
    const prev = raw.slice(0, i).reverse().find((x) => x !== null)
    const next = raw.slice(i + 1).find((x) => x !== null)
    return prev != null && next != null ? (prev + next) / 2 : (prev ?? next ?? 0)
  })
  const knownB = nonIncreasing(filled, n.map((k) => Math.max(k, 0.5)))
  const variance = n.reduce((s, k, i) => {
    if (!k) return s
    const h = yes[i]! / k
    const se = Math.sqrt(Math.max(h * (1 - h), 0.25 / k) / k) / Math.max(1 - f, 0.05)
    return s + (se * BAND) ** 2
  }, 0)
  const est = knownB.reduce((s, v) => s + v * BAND, 0)
  const half = 1.96 * Math.sqrt(variance)
  const interval: [number, number] = [Math.max(0, Math.round(est - half)), Math.min(BANDS * BAND, Math.round(est + half))]
  const realItems = n.reduce((a, b) => a + b, 0)
  const hits = yes.reduce((a, b) => a + b, 0)
  const noise = f > 0 && realItems > 0 && hits / realItems <= f
  const result: TestResult = {
    testId: t.id,
    ...estimate(srsBands(now), { known: knownB, items: n, yes, interval }),
    falseAlarmRate: Math.round(f * 1000) / 1000,
    pseudowords: { items: pn, yes: py },
    answered: map.size,
    method: 'corrected',
    reliability: f > 0.2 || noise ? 'low' : 'ok',
    valid: f <= 0.5,
  }
  t.result = result
  t.completedAt = now.toISOString()
  return result
}

function testList() {
  return [...db.tests]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((t) => ({ id: t.id, createdAt: t.createdAt, completedAt: t.completedAt, items: t.items.length, result: t.result }))
}

function vocabulary(now: Date, deckId: string): Dashboard['vocabulary'] {
  const done = testList().filter((t) => t.result && t.completedAt)
  const latest = done.find((t) => t.result!.valid) ?? null
  const r = latest?.result
  const test: Scored | null = r
    ? { known: r.perBand.map((b) => b.known), items: r.perBand.map((b) => b.items), yes: r.perBand.map((b) => b.yes), interval: r.interval ?? [0, 0] }
    : null
  return {
    available: { frequencies: true, test: true, scale: true },
    latestTest: latest ? { ...latest.result!, completedAt: latest.completedAt! } : null,
    current: estimate(srsBands(now, deckId), test),
    history: done.reverse().map((t) => ({
      testId: t.id,
      completedAt: t.completedAt!,
      estimate: t.result!.estimate,
      adjusted: t.result!.adjusted,
      nativeEquivalent: t.result!.nativeEquivalent.value,
      reliability: t.result!.reliability,
      valid: t.result!.valid,
    })),
    scale: { unit: scale.unit, points: POINTS, calibration: CAL },
  }
}

const COVERAGE: [number, number][] = [[1, 1000], [1001, 2000], [2001, 5000], [5001, 10000], [10001, 20000], [20001, 30000]]

function dashboard(deck: MockDeck, now: Date): Dashboard {
  const words = db.words.filter((w) => w.deckId === deck.id)
  const active = words.filter((w) => w.status === 'active')
  const activeIds = new Set(active.map((w) => w.id))
  const cards = db.cards.filter((c) => activeIds.has(c.wordId))
  const directions = {
    forward: { enabled: deck.forwardEnabled, new: 0, learning: 0, known: 0, fading: 0, suspended: 0 },
    reverse: { enabled: deck.reverseEnabled, new: 0, learning: 0, known: 0, fading: 0, suspended: 0 },
  }
  const knownWords = new Set<string>()
  const stable = new Map<string, boolean>()
  for (const c of cards) {
    const d = directions[c.direction]
    const s = c.schedule
    if (c.suspended) d.suspended++
    else if (s.state === 0) d.new++
    else if (s.state === 1 || s.state === 3) d.learning++
    else if (known(s, now)) d.known++
    else d.fading++
    if (!enabled(deck, c.direction)) continue
    if (!c.suspended && known(s, now)) knownWords.add(c.wordId)
    stable.set(c.wordId, (stable.get(c.wordId) ?? true) && s.state === 2 && s.stability >= 21)
  }
  const knownNow = knownWords.size

  const growth = Array.from({ length: 26 }, (_, i) => {
    const x = i / 25
    return { date: iso(now.getTime() - (25 - i) * 7 * D).slice(0, 10), known: Math.round(knownNow * (0.12 + 0.88 * x ** 1.3)) }
  })

  // Activity from the logs, per study day.
  const keys: string[] = []
  for (let i = 89; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * D), DAY))
  const perDay = new Map(keys.map((k) => [k, { day: k, reviews: 0, again: 0, timeMs: 0 }]))
  const studied = new Set<string>()
  const deckCards = new Set(db.cards.filter((c) => wordOf(c.wordId).deckId === deck.id).map((c) => c.id))
  for (const l of db.logs) {
    if (!deckCards.has(l.cardId)) continue
    const k = dayKey(new Date(l.reviewedAt), DAY)
    studied.add(k)
    const d = perDay.get(k)
    if (!d) continue
    d.reviews++
    if (l.rating === 1) d.again++
    d.timeMs += l.durationMs ?? 0
  }
  const todayKey = today(now)
  const back = (k: string) => dayKey(new Date(Date.parse(`${k}T12:00:00Z`) - D), { timeZone: 'UTC', startHour: 0 })
  const studiedToday = studied.has(todayKey)
  let current = 0
  for (let k = studiedToday ? todayKey : back(todayKey); studied.has(k); k = back(k)) current++
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const k of [...studied].sort()) {
    run = prev !== null && back(k) === prev ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = k
  }
  const days = [...perDay.values()]

  const since = iso(now.getTime() - 30 * D)
  const retention: Dashboard['retention'] = { forward: { rate: null, reviews: 0 }, reverse: { rate: null, reviews: 0 } }
  for (const dir of ['forward', 'reverse'] as const) {
    const ls = db.logs.filter((l) => l.reviewedAt >= since && l.before.state === 2 && deckCards.has(l.cardId) && db.cards.find((c) => c.id === l.cardId)?.direction === dir)
    retention[dir] = { rate: ls.length ? ls.filter((l) => l.rating > 1).length / ls.length : null, reviews: ls.length }
  }

  const inApp = new Map<number, boolean>()
  for (const w of active) {
    if (w.freqRank === null || !lemma(w.term)) continue
    const k = cardsOf(w.id).some((c) => enabled(deck, c.direction) && !c.suspended && known(c.schedule, now))
    inApp.set(w.freqRank, (inApp.get(w.freqRank) ?? false) || k)
  }
  const coverage = COVERAGE.map(([from, to]) => {
    let n = 0
    let k = 0
    for (const [rank, isKnown] of inApp) {
      if (rank < from || rank > to) continue
      n++
      if (isKnown) k++
    }
    return { from, to, words: n, known: k }
  })

  const { typeAnswer: _t, ...plainDeck } = deck
  return {
    deck: plainDeck,
    counts: {
      words: {
        total: words.length,
        active: active.length,
        inbox: words.filter((w) => w.status === 'inbox').length,
        rejected: words.filter((w) => w.status === 'rejected').length,
      },
      directions,
      known: knownNow,
      mastered: [...stable.values()].filter(Boolean).length,
    },
    growth,
    activity: {
      days,
      streak: { current, longest, studiedToday },
      totals: { reviews: days.reduce((s, d) => s + d.reviews, 0), timeMs: days.reduce((s, d) => s + d.timeMs, 0) },
    },
    retention,
    coverage,
    vocabulary: vocabulary(now, deck.id),
  }
}

// --- routing ---------------------------------------------------------------

class Fail extends Error {
  status: number
  extra: Record<string, unknown>
  constructor(status: number, msg: string, extra: Record<string, unknown> = {}) {
    super(msg)
    this.status = status
    this.extra = extra
  }
}

// A success with a status other than 200.
class Reply {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    this.status = status
    this.body = body
  }
}

// --- account, bot login, tokens ---------------------------------------------

const BOT = 'mnemosyne_cards_bot'
const USER = { id: 'us_owner', telegramId: 4242, name: 'Ilya', isOwner: true }
const settings = {
  timeZone: DAY.timeZone,
  reminderTime: '09:00',
  eveningReminderTime: '21:00' as string | null,
  weeklyReport: true,
  weeklyReportDay: 0,
  weeklyReportTime: '19:00',
  requestRetention: 0.9,
}
// Personal FSRS weights once "trained" (POST /api/fsrs/optimize).
const fsrsState = { weights: null as number[] | null, trainedAt: null as string | null, reviewsUsed: null as number | null, lastRun: 0 }
const FSRS_MIN_REVIEWS = 400
const nonces = new Map<string, { expiresAt: number; firstPoll: number | null }>()
const tokens: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[] = [
  { id: 'tk_laptop', name: 'MacBook', createdAt: iso(Date.now() - 40 * D), lastUsedAt: iso(Date.now() - 3 * H) },
  { id: 'tk_script', name: 'Backup script', createdAt: iso(Date.now() - 9 * D), lastUsedAt: null },
]

function me(now: Date) {
  return {
    user: USER,
    authenticatedVia: variant === 'bearer' ? 'bearer' : 'session',
    timeZone: settings.timeZone,
    dayStartHour: DAY.startHour,
    today: dayKey(now, { ...DAY, timeZone: settings.timeZone }),
    reminderTime: settings.reminderTime,
    eveningReminderTime: settings.eveningReminderTime,
    botUsername: mockControl.bot ? BOT : null,
    fsrs: { weights: fsrsState.weights, requestRetention: settings.requestRetention, trainedAt: fsrsState.trainedAt, reviewsUsed: fsrsState.reviewsUsed, minReviews: FSRS_MIN_REVIEWS },
    weeklyReport: settings.weeklyReport,
    weeklyReportDay: settings.weeklyReportDay,
    weeklyReportTime: settings.weeklyReportTime,
  }
}

const isTime = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)

function patchMe(body: Body) {
  const keys = ['timeZone', 'reminderTime', 'eveningReminderTime', 'weeklyReport', 'weeklyReportDay', 'weeklyReportTime', 'requestRetention']
  for (const k of Object.keys(body)) if (!keys.includes(k)) throw new Fail(400, `unknown key ${k}`)
  if ('weeklyReportDay' in body && !(Number.isInteger(body.weeklyReportDay) && Number(body.weeklyReportDay) >= 0 && Number(body.weeklyReportDay) <= 6)) throw new Fail(400, 'weeklyReportDay must be 0-6')
  if ('weeklyReportTime' in body && !isTime(body.weeklyReportTime)) throw new Fail(400, 'must be HH:MM (24 h)')
  if ('requestRetention' in body && !(typeof body.requestRetention === 'number' && body.requestRetention >= 0.75 && body.requestRetention <= 0.97)) throw new Fail(400, 'requestRetention must be 0.75-0.97')
  if ('timeZone' in body) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(body.timeZone) })
    } catch {
      throw new Fail(400, 'unknown IANA time zone')
    }
  }
  if ('reminderTime' in body && !isTime(body.reminderTime)) throw new Fail(400, 'must be HH:MM (24 h)')
  if ('eveningReminderTime' in body && body.eveningReminderTime !== null && !isTime(body.eveningReminderTime)) throw new Fail(400, 'must be HH:MM (24 h)')
  if ('weeklyReport' in body && typeof body.weeklyReport !== 'boolean') throw new Fail(400, 'weeklyReport must be a boolean')
  Object.assign(settings, body)
}

const DECK_KEYS = ['name', 'newPerDay', 'forwardEnabled', 'reverseEnabled', 'reverseAfterDays', 'typeAnswer']

function patchDeck(d: MockDeck, body: Body) {
  for (const k of Object.keys(body)) if (!DECK_KEYS.includes(k)) throw new Fail(400, `Unrecognized key: "${k}"`)
  if ('newPerDay' in body && (!Number.isInteger(body.newPerDay) || (body.newPerDay as number) < 0 || (body.newPerDay as number) > 999)) throw new Fail(400, 'newPerDay must be 0..999')
  if ('reverseAfterDays' in body && body.reverseAfterDays !== null && (typeof body.reverseAfterDays !== 'number' || body.reverseAfterDays < 1 || body.reverseAfterDays > 365))
    throw new Fail(400, 'reverseAfterDays must be 1..365 or null')
  if ('typeAnswer' in body && !['off', 'reverse', 'both'].includes(String(body.typeAnswer))) throw new Fail(400, 'typeAnswer must be off, reverse or both')
  const fwd = 'forwardEnabled' in body ? !!body.forwardEnabled : d.forwardEnabled
  const rev = 'reverseEnabled' in body ? !!body.reverseEnabled : d.reverseEnabled
  if (!fwd && !rev) throw new Fail(400, 'at least one direction must stay enabled')
  Object.assign(d, body)
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return 'mn_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function handle(method: string, url: URL, body: unknown): unknown {
  const p = url.pathname
  const now = new Date()
  const parts = p.split('/').filter(Boolean).slice(1) // drop "api"
  const [a, b, c] = parts
  const B = (body ?? {}) as Body

  if (p === '/api/health') return { ok: true }
  if (p === '/api/login' && method === 'POST') {
    if (B.password !== 'recall') throw new Fail(401, 'wrong password')
    mockControl.authed = true
    return { ok: true }
  }
  if (p === '/api/login/telegram' && method === 'POST') {
    if (!mockControl.bot) throw new Fail(503, 'Telegram login is unavailable')
    const nonce = randomSecret().slice(3, 25)
    const expiresAt = now.getTime() + 5 * 60_000
    nonces.set(nonce, { expiresAt, firstPoll: null })
    return { nonce, url: `https://t.me/${BOT}?start=login_${nonce}`, expiresAt: iso(expiresAt) }
  }
  if (a === 'login' && b === 'telegram' && c && method === 'GET') {
    const n = nonces.get(c)
    if (!n || n.expiresAt <= now.getTime()) throw new Fail(410, 'login link expired', { status: 'expired' })
    // "The user pressed Log in" about 3 s after the app started waiting.
    n.firstPoll ??= now.getTime()
    if (now.getTime() - n.firstPoll < 3000) return new Reply(202, { status: 'pending', expiresAt: iso(n.expiresAt) })
    nonces.delete(c)
    mockControl.authed = true
    return { status: 'ok', user: USER }
  }
  if (mockControl.denied) throw new Fail(401, 'not allowed', { telegramId: 5550123 })
  if (!mockControl.authed) throw new Fail(401, 'unauthorized')
  if (p === '/api/logout') {
    mockControl.authed = false
    return { ok: true }
  }
  if (p === '/api/me') {
    if (method === 'PATCH') patchMe(B)
    return me(now)
  }
  // Mock training: refuses below FSRS_MIN_REVIEWS logs, then "adopts" the
  // default weights as personal ones; once per 10 minutes.
  if (p === '/api/fsrs/optimize' && method === 'POST') {
    const reviews = db.logs.length
    if (now.getTime() - fsrsState.lastRun < 10 * 60_000) throw new Fail(429, 'FSRS training ran recently, try again later', { retryAfterSeconds: Math.ceil((fsrsState.lastRun + 10 * 60_000 - now.getTime()) / 1000) })
    if (reviews < FSRS_MIN_REVIEWS) throw new Fail(422, `not enough reviews to train FSRS (${reviews} of ${FSRS_MIN_REVIEWS})`, { reviews, minReviews: FSRS_MIN_REVIEWS })
    fsrsState.lastRun = now.getTime()
    fsrsState.weights = [...DEFAULT_WEIGHTS]
    fsrsState.trainedAt = now.toISOString()
    fsrsState.reviewsUsed = reviews
    return { adopted: true, reviews, metrics: null, baseline: null, fsrs: me(now).fsrs }
  }
  if (a === 'tokens') {
    if (variant === 'bearer') throw new Fail(403, 'manage tokens from the app, not with a bearer token')
    if (!b && method === 'GET') return { tokens }
    if (!b && method === 'POST') {
      const name = String(B.name ?? '').trim()
      if (!name) throw new Fail(400, 'name is required')
      const token = { id: id('tk'), name, createdAt: now.toISOString(), lastUsedAt: null }
      tokens.unshift(token)
      return new Reply(201, { token, secret: randomSecret() })
    }
    if (b && method === 'DELETE') {
      const i = tokens.findIndex((t) => t.id === b)
      if (i < 0) throw new Fail(404, 'no such token')
      tokens.splice(i, 1)
      return { ok: true }
    }
  }

  // ---------- review ----------

  if (p === '/api/queue') {
    const ref = url.searchParams.get('deck')
    const deckId = ref ? (resolveDeck(ref)?.id ?? '-') : undefined
    const { items, counts, inbox } = buildQueue(now, Number(url.searchParams.get('limit') ?? 200), deckId)
    return { items, counts, inbox }
  }

  if (p === '/api/reviews' && method === 'POST') {
    const inputs = [...(body as ReviewInput[])].sort((x, y) => x.reviewedAt.localeCompare(y.reviewedAt))
    let applied = 0
    let skipped = 0
    const touched = new Map<string, Card>()
    for (const r of inputs) {
      const card = db.cards.find((x) => x.id === r.cardId)
      if (db.logs.some((l) => l.id === r.id) || !card) {
        skipped++
        continue
      }
      const before = card.schedule
      const after = review(before, r.rating, new Date(r.reviewedAt))
      card.schedule = after
      db.logs.push({ ...r, before, after })
      touched.set(card.id, card)
      applied++
    }
    return { applied, skipped, cards: [...touched.values()] }
  }
  if (p === '/api/reviews/undo' && method === 'POST') {
    const log = db.logs.find((l) => l.id === B.id)
    if (!log) throw new Fail(404, 'no such review')
    const latest = db.logs.filter((l) => l.cardId === log.cardId).sort((x, y) => y.reviewedAt.localeCompare(x.reviewedAt))[0]!
    if (latest.id !== log.id) throw new Fail(409, 'not the latest review of this card')
    const card = db.cards.find((x) => x.id === log.cardId)
    if (card) card.schedule = log.before
    db.logs = db.logs.filter((l) => l.id !== log.id)
    return { card }
  }

  // ---------- decks ----------

  if (a === 'decks') {
    if (!b && method === 'GET') return { decks: db.decks.map((d) => ({ ...d, counts: deckCounts(d, now) })) }
    if (!b && method === 'POST') {
      const lang = String(B.targetLang ?? '').toLowerCase()
      if (!lang) throw new Fail(400, 'targetLang is required')
      if (db.decks.some((d) => d.targetLang === lang)) throw new Fail(409, `a deck for ${lang} already exists`)
      const d: MockDeck = {
        id: id('dk'),
        name: String(B.name ?? lang.toUpperCase()),
        targetLang: lang,
        nativeLang: String(B.nativeLang ?? 'ru'),
        newPerDay: Number(B.newPerDay ?? 15),
        forwardEnabled: true,
        reverseEnabled: true,
        reverseAfterDays: null,
        typeAnswer: 'off',
        createdAt: now.toISOString(),
      }
      db.decks.push(d)
      return new Reply(201, { deck: d })
    }
    if (b && method === 'PATCH') {
      const d = db.decks.find((x) => x.id === b)
      if (!d) throw new Fail(404, 'deck not found')
      patchDeck(d, B)
      return { deck: d }
    }
  }

  // ---------- words ----------

  if (p === '/api/words/autofill' && method === 'POST') return autofill(B)

  if (a === 'words') {
    if (!b && method === 'GET') return searchWords(url, now)
    if (!b && method === 'POST') return new Reply(201, { word: item(createWord(B, now), now) })
    const w = mustWord(b!)
    if (c === 'approve' || c === 'reject') {
      w.status = c === 'approve' ? 'active' : 'rejected'
      w.updatedAt = now.toISOString()
      return { word: item(w, now) }
    }
    if (c === 'suspend' || c === 'unsuspend') {
      for (const card of cardsOf(w.id)) card.suspended = c === 'suspend'
      return { word: item(w, now) }
    }
    if (!c && method === 'GET') {
      const ids = new Set(cardsOf(w.id).map((x) => x.id))
      const logs = db.logs.filter((l) => ids.has(l.cardId)).sort((x, y) => y.reviewedAt.localeCompare(x.reviewedAt)).slice(0, 20)
      return { word: item(w, now), logs }
    }
    if (!c && method === 'PATCH') return { word: item(updateWord(w, B, now), now) }
    if (!c && method === 'DELETE') {
      const ids = new Set(cardsOf(w.id).map((x) => x.id))
      db.words = db.words.filter((x) => x.id !== w.id)
      db.cards = db.cards.filter((x) => x.wordId !== w.id)
      db.logs = db.logs.filter((l) => !ids.has(l.cardId))
      return { ok: true }
    }
  }

  if (a === 'cards' && (c === 'suspend' || c === 'unsuspend') && method === 'POST') {
    const card = db.cards.find((x) => x.id === b)
    if (!card) throw new Fail(404, `card ${b} not found`)
    card.suspended = c === 'suspend'
    return { card: { ...card, summary: summary(card, now) } }
  }

  if (p === '/api/inbox') {
    const ref = url.searchParams.get('deck')
    const deck = ref ? mustDeck(ref) : null
    return {
      words: db.words
        .filter((w) => w.status === 'inbox' && (!deck || w.deckId === deck.id))
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        .map((w) => item(w, now)),
    }
  }
  if (p === '/api/inbox/approve-all' && method === 'POST') {
    const deck = B.deckId ? resolveDeck(String(B.deckId)) : null
    let n = 0
    for (const w of db.words) {
      if (w.status !== 'inbox' || (B.deckId && w.deckId !== deck?.id)) continue
      w.status = 'active'
      w.updatedAt = now.toISOString()
      n++
    }
    return { approved: n }
  }

  // ---------- progress ----------

  if (p === '/api/stats') {
    const deck = mustDeck(url.searchParams.get('deck'))
    const active = new Set(db.words.filter((w) => w.deckId === deck.id && w.status === 'active').map((w) => w.id))
    const cards = db.cards.filter((c) => active.has(c.wordId) && !c.suspended && enabled(deck, c.direction) && c.schedule.state !== 0)
    const start = nextDayStart(now, DAY).getTime() - D
    const forecast = Array.from({ length: 14 }, (_, i) => ({
      day: dayKey(new Date(start + i * D + H), DAY),
      due: cards.filter((c) => {
        const t = new Date(c.schedule.due).getTime()
        return (i === 0 || t >= start + i * D) && t < start + (i + 1) * D
      }).length,
    }))
    return { forecast }
  }
  if (p === '/api/dashboard') return dashboard(mustDeck(url.searchParams.get('deck')), now)
  if (p === '/api/vocab-test' && method === 'POST') return new Reply(201, createTest(now))
  if (a === 'vocab-test' && b && c === 'answers' && method === 'POST') {
    const t = db.tests.find((x) => x.id === b)
    if (!t) throw new Fail(404, `vocabulary test ${b} not found`)
    return answerTest(t, (B.answers ?? []) as { id: string; known: boolean }[], now)
  }
  if (p === '/api/vocab-tests') return { tests: testList() }

  throw new Fail(404, `mock: no route ${method} ${p}`)
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  const method = (init?.method ?? 'GET').toUpperCase()
  const signal = init?.signal
  let wait = mockControl.latencyMs * (0.5 + Math.random())
  if (url.pathname === '/api/words/autofill') wait += mockControl.autofillMs
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, wait)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(abortError())
    })
  })
  if (signal?.aborted) throw abortError()
  if (mockControl.offline) throw new TypeError('Failed to fetch')
  const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined
  try {
    const out = handle(method, url, body)
    const reply = out instanceof Reply ? out : new Reply(200, out)
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const status = e instanceof Fail ? e.status : 500
    if (status === 500) console.error(e)
    const extra = e instanceof Fail ? e.extra : {}
    return new Response(JSON.stringify({ ...extra, error: e instanceof Error ? e.message : String(e) }), { status, headers: { 'Content-Type': 'application/json' } })
  }
}
