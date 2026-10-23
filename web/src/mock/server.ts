// In-memory fake of the REST API (DESIGN.md "REST API"), used with `?mock`.
// Implements the queue rules (learning first, reviews, new interleaved,
// one card per word per day, new-per-day, disabled directions, the reverse
// gate), autofill, the dashboard and the vocabulary test closely enough to
// exercise every screen; decks hold words and facts, each reviewed on its own
// under its review filter.
// Loaded via dynamic import only in mock mode.
import {
  cleanExercise,
  cleanFact,
  cleanReviewFilter,
  cleanWord,
  DEFAULT_WEIGHTS,
  dayKey,
  dayStart,
  dedupeKey,
  exerciseKey,
  factKey,
  newCardState,
  nextDayStart,
  normalizeTerm,
  planToday,
  retrievability,
  review,
  todayCount,
  type Card,
  CLAUDE_TAG,
  type CardState,
  type CardType,
  type Deck,
  type Direction,
  type ExerciseInput,
  type Fact,
  type FactInput,
  type FacetItem,
  formsLine,
  facetOptions,
  inReviewFilter,
  tagMatches,
  type QueueItem,
  type Rating,
  type ReviewFilter,
  type ReviewInput,
  type ReviewLog,
  type Word,
  type WordInput,
} from '@recall/core'
import type { CardSummary, Dashboard, Draft, ExerciseInfo, FactItem, Placement, ScalePoint, TestResult, TypeAnswer, VocabEstimate, WordItem } from '../lib/types.ts'
import { autofillDictionary, baselineSrs, grammar, irregularVerbs, pseudowords, scale, testBands, topics as seedTopics, words as seedWords, type Plan, type SeedWord } from './seed.ts'

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
  facts: [] as Fact[],
  exercises: [] as ExerciseInfo[],
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

// The pack: facts generated like the server's.
const PACK = { id: 'irregular-verbs', name: 'Irregular verbs', description: 'The most common English irregular verbs, most frequent first.' }
const packRef = (v: string) => `pack:${PACK.id}:${v}`
const packRefs = new Map<string, string>()
function packFact(v: (typeof irregularVerbs)[number]) {
  const back = [`**${formsLine(v)}**`, `*${v.example.text}*\n${v.example.translation}`]
  if (v.note) back.push(v.note)
  return { front: `**to ${v.verb}**\n${v.translation}`, back: back.join('\n\n'), tags: [] }
}
function packInfo() {
  const have = irregularVerbs.filter((v) => packRefs.has(packRef(v.verb)))
  const deckId = have.length ? db.facts.find((f) => f.id === packRefs.get(packRef(have[0]!.verb)))?.deckId : undefined
  const deck = deckId ? db.decks.find((d) => d.id === deckId) : db.decks.find((d) => d.targetLang === 'en')
  return { ...PACK, count: irregularVerbs.length, added: have.length > 0, missing: irregularVerbs.length - have.length, deckId: deck?.id, deckName: deck?.name ?? PACK.name }
}

// The handbook pack's topics added to English (the mock's own, invented).
const handbookTopics: { id: string; group: string; title: string; level: string; ruleFactId: string; cardFactIds: string[] }[] = []

function handbookOf(deck: MockDeck) {
  const active = (id: string) => db.facts.find((f) => f.id === id && f.deckId === deck.id && f.status !== 'rejected')
  const pool = (factId: string) => db.exercises.filter((e) => e.factId === factId && e.status === 'active').length
  const linked = new Set(handbookTopics.flatMap((t) => [t.ruleFactId, ...t.cardFactIds]))
  return {
    topics: handbookTopics
      .filter((t) => active(t.ruleFactId))
      .map((t) => ({ ...t, summary: active(t.ruleFactId)!.back, cardFactIds: t.cardFactIds.filter((id) => active(id)), exercises: pool(t.ruleFactId) })),
    mine: db.facts
      .filter((f) => f.deckId === deck.id && f.status !== 'rejected' && f.tags.some((t) => tagMatches('Grammar', t)) && !linked.has(f.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((f) => ({ factId: f.id, title: f.front, rule: f.back, exercises: pool(f.id) })),
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
    reviewFilter: null,
    createdAt: iso(now - 150 * D),
  }
  db.decks.push(eng)
  if (variant === 'empty') return
  const claudeCount = seedWords.filter((s) => s.plan === 'claude' || s.plan === 'rejected').length
  let claudeK = 0
  seedWords.forEach((s: SeedWord, k) => {
    if (s.freqRank !== null) ranks.set(normalizeTerm(s.term), s.freqRank)
    const byClaude = s.plan === 'claude' || s.plan === 'rejected'
    const createdAt = byClaude ? iso(now - (claudeCount - claudeK++) * 5 * H) : iso(now - (140 - k * 3) * D)
    const word: Word = {
      id: id('wd'),
      deckId: eng.id,
      term: s.term,
      pos: s.pos,
      translations: s.translations,
      ipa: s.ipa,
      examples: s.examples,
      note: s.note ?? null,
      tags: byClaude ? [CLAUDE_TAG, ...(s.tags ?? [])] : s.tags ?? [],
      freqRank: s.freqRank,
      cefr: s.cefr,
      status: s.plan === 'rejected' ? 'rejected' : 'active',
      createdBy: byClaude ? 'claude' : k % 3 === 0 ? 'user' : 'import',
      createdAt,
      updatedAt: createdAt,
    }
    db.words.push(word)
    const plans: [Plan, Plan] = Array.isArray(s.plan) ? s.plan : ['new', 'new']
    ;(['forward', 'reverse'] as const).forEach((direction, i) => {
      const p = planState(plans[i]!, k * 2 + i, now)
      db.cards.push({ id: id('cd'), wordId: word.id, factId: null, direction, suspended: p.suspended, schedule: p.state })
    })
  })
  // Grammar rules, in English: reviewed through their exercises.
  grammar.forEach((r, k) => {
    const createdAt = iso(now - (20 - k) * D)
    const t = r.topic
    const fact: Fact = { id: id('ft'), deckId: eng.id, front: r.title, back: r.rule, tags: t ? [`Grammar/${t.group}`] : ['Grammar/My rules'], status: 'active', createdBy: t ? 'import' : 'user', createdAt, updatedAt: createdAt }
    db.facts.push(fact)
    const ps = planState(r.plan, 200 + k, now)
    db.cards.push({ id: id('cd'), wordId: null, factId: fact.id, direction: 'forward', suspended: false, schedule: ps.state })
    for (const it of r.items) {
      db.exercises.push({ ...it, id: id('ex'), factId: fact.id, status: 'active', needsReview: false, createdBy: 'import', createdAt, shownCount: 0, lastShownAt: null, correctCount: 0, wrongCount: 0 })
    }
    if (!t) return
    // The grammar handbook pack's topic: write tasks and theory cards too.
    for (const w of t.write) {
      db.exercises.push({ type: 'write', prompt: w.prompt, answer: '', accepted: [], explain: null, rubric: w.rubric, id: id('ex'), factId: fact.id, status: 'active', needsReview: false, createdBy: 'import', createdAt, shownCount: 0, lastShownAt: null, correctCount: 0, wrongCount: 0 })
    }
    const cardFactIds = t.cards.map((c, n) => {
      const at = iso(now - (20 - k) * D + n + 1)
      const f: Fact = { id: id('ft'), deckId: eng.id, front: c.front, back: c.back, tags: [`Grammar/${t.group}`], status: 'active', createdBy: 'import', createdAt: at, updatedAt: at }
      db.facts.push(f)
      db.cards.push({ id: id('cd'), wordId: null, factId: f.id, direction: 'forward', suspended: false, schedule: planState(n === 0 ? 'later' : 'new', 260 + k * 5 + n, now).state })
      return f.id
    })
    handbookTopics.push({ id: t.id, group: t.group, title: r.title, level: t.level, ruleFactId: fact.id, cardFactIds })
  })
  // The irregular-verbs pack, added to English: a few already studied.
  irregularVerbs.forEach((v, k) => {
    const createdAt = iso(now - (40 - k) * D)
    const f = packFact(v)
    const fact: Fact = { id: id('ft'), deckId: eng.id, ...f, tags: [PACK.name], status: 'active', createdBy: 'import', createdAt, updatedAt: createdAt }
    db.facts.push(fact)
    packRefs.set(packRef(v.verb), fact.id)
    const ps = planState(k < 3 ? (['later', 'due', 'mastered'] as const)[k]! : 'new', 300 + k, now)
    db.cards.push({ id: id('cd'), wordId: null, factId: fact.id, direction: 'forward', suspended: false, schedule: ps.state })
  })
  // Programming: Q&A cards, one tag per subject. Its review leaves Databases out (a filter demo).
  const prog: MockDeck = {
    id: 'dk_programming', name: 'Programming', targetLang: null, nativeLang: null, newPerDay: 5,
    forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null, typeAnswer: 'off',
    reviewFilter: { tags: ['Concurrency', 'Java Core'] }, createdAt: iso(now - 90 * D),
  }
  db.decks.push(prog)
  seedTopics.forEach((t, ti) => {
    t.facts.forEach((f, k) => {
      const createdAt = iso(now - (60 - ti * 10 - k) * D)
      const byClaude = f.plan === 'claude'
      const tags = [...(byClaude ? [CLAUDE_TAG] : []), t.name, ...(f.tags ?? [])]
      const fact: Fact = { id: id('ft'), deckId: prog.id, front: f.front, back: f.back, tags, status: 'active', createdBy: byClaude ? 'claude' : 'import', createdAt, updatedAt: createdAt }
      db.facts.push(fact)
      const ps = planState(f.plan === 'claude' ? 'new' : f.plan, 100 + ti * 10 + k, now)
      db.cards.push({ id: id('cd'), wordId: null, factId: fact.id, direction: 'forward', suspended: ps.suspended, schedule: ps.state })
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

// Forms of irregular verbs, by lemma (the server's pack-data.verbForms, small).
const VERBS = new Map(irregularVerbs.map((v) => [v.verb, v]))
function formsOf(w: Word): Word {
  if (w.pos !== 'verb' && w.pos !== 'phrasal_verb') return w
  const parts = normalizeTerm(w.term).split(' ')
  const v = VERBS.get(parts[0]!)
  if (!v || (w.pos === 'verb' && parts.length > 1) || (w.pos === 'phrasal_verb' && parts.length < 2)) return w
  const rest = parts.slice(1).join(' ')
  const add = (f: string) => (rest ? `${f} ${rest}` : f)
  return { ...w, forms: { past: v.past.map(add), participle: v.participle.map(add) } }
}

const deckOf = (deckId: string) => db.decks.find((d) => d.id === deckId)!
const wordOf = (wordId: string) => db.words.find((w) => w.id === wordId)!
const factOf = (factId: string) => db.facts.find((f) => f.id === factId)!
const cardsOf = (wordId: string) => db.cards.filter((c) => c.wordId === wordId)
// The word or fact a card belongs to.
const ownerOf = (c: Card): Word | Fact => (c.factId ? factOf(c.factId) : wordOf(c.wordId!))
const today = (now: Date) => dayKey(now, DAY)
const isToday = (at: string, now: Date) => dayKey(new Date(at), DAY) === today(now)
const hasLangs = (d: Deck) => !!d.targetLang && !!d.nativeLang
// Decks with languages first, then by age, as the server lists them.
const sortDecks = (ds: MockDeck[]) => [...ds].sort((a, b) => Number(hasLangs(b)) - Number(hasLangs(a)) || a.createdAt.localeCompare(b.createdAt))
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
  const deck = deckOf(ownerOf(card).deckId)
  return {
    id: card.id,
    direction: card.direction,
    enabled: !!card.factId || enabled(deck, card.direction),
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
  return { ...formsOf(w), deckName: deckOf(w.deckId).name, cards: { forward: pick('forward'), reverse: pick('reverse') } }
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

// A card as the review filter sees it.
const typeOf = (o: Word | Fact): CardType =>
  'term' in o ? 'word' : db.exercises.filter((e) => e.factId === o.id && e.status === 'active').length >= 3 ? 'rule' : 'fact'
const factsOf = (c: Card, o: Word | Fact) => ({ type: typeOf(o), tags: o.tags, ...('term' in o ? { pos: o.pos, cefr: o.cefr, direction: c.direction } : {}) })

// Today's cards of every deck under its review filter (`draft` stands in for
// one deck's), then the session: one deck's, or all. Budgets are per deck
// and burying per word, so a deck's share doesn't depend on the others.
function buildQueue(now: Date, limit: number, deckId?: string, draft?: { deckId: string; filter: ReviewFilter | null }) {
  const dayEnd = nextDayStart(now, DAY).getTime()
  const filterOf = (d: string) => (draft && draft.deckId === d ? draft.filter : deckOf(d).reviewFilter)
  const owners = new Map<string, Word | Fact>()
  for (const o of [...db.words, ...db.facts]) if (o.status === 'active') owners.set(o.id, o)
  const ownerKey = (c: Card) => (c.factId ?? c.wordId)!
  const reviewedToday = new Map<string, Set<string>>()
  const firstLog = new Map<string, string>()
  for (const l of db.logs) {
    const f = firstLog.get(l.cardId)
    if (!f || l.reviewedAt < f) firstLog.set(l.cardId, l.reviewedAt)
    if (!isToday(l.reviewedAt, now)) continue
    const c = db.cards.find((x) => x.id === l.cardId)
    if (!c) continue
    if (!reviewedToday.has(ownerKey(c))) reviewedToday.set(ownerKey(c), new Set())
    reviewedToday.get(ownerKey(c))!.add(c.id)
  }
  const cards = db.cards.filter((c) => {
    const o = owners.get(ownerKey(c))
    return o && !c.suspended && (c.factId !== null || enabled(deckOf(o.deckId), c.direction)) && inReviewFilter(filterOf(o.deckId), factsOf(c, o))
  })
  const deckIdOf = (c: Card) => owners.get(ownerKey(c))!.deckId
  const dueT = (c: Card) => new Date(c.schedule.due).getTime()
  const learning = cards.filter((c) => (c.schedule.state === 1 || c.schedule.state === 3) && dueT(c) < dayEnd).sort((a, b) => dueT(a) - dueT(b))
  const reviews = cards.filter((c) => c.schedule.state === 2 && dueT(c) < dayEnd).sort((a, b) => dueT(a) - dueT(b))

  const introduced = new Map<string, number>()
  for (const c of cards) {
    const f = firstLog.get(c.id)
    if (f && isToday(f, now)) introduced.set(deckIdOf(c), (introduced.get(deckIdOf(c)) ?? 0) + 1)
  }
  const budget = new Map(db.decks.map((d) => [d.id, Math.max(0, d.newPerDay + extraToday(d.id, now) - (introduced.get(d.id) ?? 0))]))
  // The reverse gate: a new reverse card waits until its forward card is
  // out of the new state and stable enough (ignored while forward is off or
  // its card suspended).
  const gated = (c: Card) => {
    if (c.direction !== 'reverse' || !c.wordId) return false
    const deck = deckOf(deckIdOf(c))
    if (deck.reverseAfterDays === null || !deck.forwardEnabled) return false
    const fwd = cardsOf(c.wordId).find((x) => x.direction === 'forward')
    return !!fwd && !fwd.suspended && (fwd.schedule.state === 0 || fwd.schedule.stability < deck.reverseAfterDays)
  }
  const fresh = cards
    .filter((c) => c.schedule.state === 0 && !gated(c))
    .sort((a, b) => owners.get(ownerKey(a))!.createdAt.localeCompare(owners.get(ownerKey(b))!.createdAt) || (a.direction === 'forward' ? -1 : 1))

  // Burying, what waits and what the budget spends on: core.planToday, as on the server.
  const placed = planToday(
    [...learning, ...reviews, ...fresh],
    (c) => ({ id: c.id, itemId: ownerKey(c), state: c.schedule.state, due: c.schedule.due, lastReview: c.schedule.lastReview }),
    (itemId, cardId) => [...(reviewedToday.get(itemId) ?? [])].some((id) => id !== cardId),
    { start: dayStart(now, DAY).getTime(), end: dayEnd },
    (c) => {
      const left = budget.get(deckIdOf(c)) ?? 0
      budget.set(deckIdOf(c), left - 1)
      return left > 0
    },
  )
  const slot = new Map(placed.map((p) => [p.card.id, p.slot]))
  const waiting = placed.filter((p) => p.slot === 'later').map((p) => p.card)
  const due = placed.filter((p) => p.slot === 'now' && p.card.schedule.state !== 0).map((p) => p.card)
  const news = placed.filter((p) => p.slot === 'now' && p.card.schedule.state === 0).map((p) => p.card)
  const out: Card[] = [...waiting]
  let ni = 0
  due.forEach((c, i) => {
    out.push(c)
    if ((i + 1) % 4 === 0 && ni < news.length) out.push(news[ni++]!)
  })
  while (ni < news.length) out.push(news[ni++]!)

  const tally = (cs: Card[], d?: string) => {
    const t = { new: 0, learning: 0, review: 0 }
    for (const c of cs) if (!d || deckIdOf(c) === d) t[todayCount(slot.get(c.id)!, c.schedule.state)]++
    return t
  }
  const decks = sortDecks(db.decks).map((d) => ({ id: d.id, name: d.name, hasLanguages: hasLangs(d), counts: tally(out, d.id) }))
  const session = out.filter((c) => !deckId || deckIdOf(c) === deckId)
  const items: QueueItem[] = session.slice(0, limit).map((c): QueueItem => {
    const o = owners.get(ownerKey(c))!
    const deckName = deckOf(o.deckId).name
    if (!c.factId) return { kind: 'word', card: c, word: formsOf(o as Word), deckName }
    const exercises = pickExercises(c.factId, new Set(), reviewRand(c, now))
    return { kind: 'fact', card: c, fact: o as Fact, deckName, ...(exercises ? { exercises } : {}) }
  })
  return { out, items, counts: tally(session), decks }
}

function deckCounts(deck: MockDeck, now: Date) {
  const dayEnd = nextDayStart(now, DAY).getTime()
  const words: (Word | Fact)[] = [...db.words, ...db.facts].filter((w) => w.deckId === deck.id)
  const active = new Set(words.filter((w) => w.status === 'active').map((w) => w.id))
  const cards = db.cards.filter((c) => active.has((c.factId ?? c.wordId)!) && !c.suspended && (!!c.factId || enabled(deck, c.direction)))
  const knownWords = new Set(cards.filter((c) => known(c.schedule, now)).map((c) => c.factId ?? c.wordId))
  return {
    total: words.length,
    active: active.size,
    dropped: words.filter((w) => w.status === 'rejected').length,
    known: knownWords.size,
    learning: cards.filter((c) => c.schedule.state === 1 || c.schedule.state === 3).length,
    due: cards.filter((c) => c.schedule.state !== 0 && new Date(c.schedule.due).getTime() < dayEnd).length,
    new: buildQueue(now, 10_000, deck.id).decks.find((d) => d.id === deck.id)?.counts.new ?? 0,
    newTotal: cards.filter((c) => c.schedule.state === 0).length,
  }
}

// Tags in use in a deck (active cards), most used first.
function deckTags(deckId: string) {
  const m = new Map<string, number>()
  for (const o of [...db.words, ...db.facts]) if (o.deckId === deckId && o.status === 'active') for (const t of o.tags) m.set(t, (m.get(t) ?? 0) + 1)
  return [...m].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
}

// "What to review": today's count under the draft, and the deck's options
// as the server counts them (core.facetOptions over active words and facts,
// a word with its enabled directions).
function reviewOptions(deck: MockDeck, filter: ReviewFilter | null, now: Date) {
  const q = buildQueue(now, 10_000, deck.id, { deckId: deck.id, filter })
  const directions = (['forward', 'reverse'] as const).filter((d) => enabled(deck, d))
  const items: FacetItem[] = [...db.words, ...db.facts]
    .filter((o) => o.deckId === deck.id && o.status === 'active')
    .map((o) => ('term' in o ? { type: 'word', tags: o.tags, pos: o.pos, cefr: o.cefr, directions } : { type: typeOf(o), tags: o.tags }))
  return { counts: q.counts, ...facetOptions(items, filter) }
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
  if (!hasLangs(deck)) throw new Fail(400, `"${deck.name}" has no languages; words go into a deck with them`)
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
  for (const direction of ['forward', 'reverse'] as const) db.cards.push({ id: id('cd'), wordId: word.id, factId: null, direction, suspended: false, schedule: newCardState(now) })
  return word
}

// --- facts ------------------------------------------------------------------

function factItem(f: Fact, now: Date): FactItem {
  const c = db.cards.find((x) => x.factId === f.id)
  const pool = db.exercises.filter((e) => e.factId === f.id)
  const exercises = pool.length
    ? { exercises: { active: pool.filter((e) => e.status === 'active').length, flagged: pool.filter((e) => e.status === 'flagged').length, needsReview: pool.filter((e) => e.needsReview).length } }
    : {}
  const t = handbookTopics.find((x) => x.ruleFactId === f.id || x.cardFactIds.includes(f.id))
  const handbook = t ? { handbook: { topic: t.id, role: t.ruleFactId === f.id ? ('rule' as const) : ('card' as const) } } : {}
  return { ...f, deckName: deckOf(f.deckId).name, card: c ? summary(c, now) : null, ...exercises, ...handbook }
}

// A 0..1 generator from a string: the same card, day and reps pick the same
// items on every fetch (the server seeds its pick the same way).
function seeded(seed: string): () => number {
  let a = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193)
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const reviewRand = (c: Card, now: Date) => seeded(`${c.id}:${today(now)}:${c.schedule.reps}`)

// Three items for a review: least recently shown first, at most two of a type (as the server does).
function pickExercises(factId: string, avoid: Set<string> = new Set(), rand: () => number = Math.random) {
  const all = db.exercises.filter((e) => e.factId === factId && e.status === 'active')
  const tap = all.filter((e) => e.type !== 'write')
  if (tap.length < 3) return null
  const shuffle = (xs: ExerciseInfo[]) => xs.map((e) => ({ e, r: rand() })).sort((a, b) => Number(avoid.has(a.e.id)) - Number(avoid.has(b.e.id)) || (a.e.lastShownAt ?? '').localeCompare(b.e.lastShownAt ?? '') || a.r - b.r).map((x) => x.e)
  const order = shuffle(tap)
  const out: ExerciseInfo[] = []
  // At most one written item, only when it can be graded.
  const write = mockControl.autofill ? shuffle(all.filter((e) => e.type === 'write'))[0] : undefined
  if (write && rand() < 0.5) out.push(write)
  for (const e of order) if (out.length < 3 && out.filter((x) => x.type === e.type).length < 2) out.push(e)
  for (const e of order) if (out.length < 3 && !out.includes(e)) out.push(e)
  return out.map(({ id, type, prompt, answer, accepted, explain, options, wrong, rubric }) => ({ id, type, prompt, answer, accepted, explain, ...(options?.length ? { options, wrong } : {}), ...(type === 'write' ? { rubric: rubric ?? null } : {}) }))
}

// "+5 new": extra new cards per deck per study day.
const extraNew = new Map<string, number>()
const extraToday = (deckId: string, now: Date) => extraNew.get(`${deckId}:${today(now)}`) ?? 0

// A practice run: today's Again cards, then the hardest; nothing is written.
function practice(now: Date, q: { deckId?: string; factId?: string }, limit = 20): QueueItem[] {
  const itemOf = (c: Card): QueueItem => {
    const o = ownerOf(c)
    const deckName = deckOf(o.deckId).name
    if (!c.factId) return { kind: 'word', card: c, word: formsOf(o as Word), deckName }
    const exercises = pickExercises(c.factId, new Set(), reviewRand(c, now))
    return { kind: 'fact', card: c, fact: o as Fact, deckName, ...(exercises ? { exercises } : {}) }
  }
  if (q.factId) {
    const f = factOf(q.factId)
    const c = db.cards.find((x) => x.factId === q.factId)
    if (!f || !c) throw new Fail(404, `fact ${q.factId} not found`)
    const out: QueueItem[] = []
    const used = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const ex = pickExercises(f.id, used)
      if (!ex) break
      ex.forEach((e) => used.add(e.id))
      out.push({ kind: 'fact', card: c, fact: f, deckName: deckOf(f.deckId).name, exercises: ex })
    }
    return out
  }
  const deck = deckOf(q.deckId!)
  const againToday = new Map<string, string>()
  for (const l of db.logs) if (l.rating === 1 && isToday(l.reviewedAt, now)) againToday.set(l.cardId, l.reviewedAt)
  const seen = new Set<string>()
  const cards = db.cards.filter((c) => {
    const o = ownerOf(c)
    return o.deckId === deck.id && o.status === 'active' && !c.suspended && c.schedule.state !== 0 && (!!c.factId || enabled(deck, c.direction)) && inReviewFilter(deck.reviewFilter, factsOf(c, o))
  })
  const rank = (c: Card) => (againToday.has(c.id) ? 0 : 1)
  cards.sort((a, b) => rank(a) - rank(b) || (againToday.get(b.id) ?? '').localeCompare(againToday.get(a.id) ?? '') || b.schedule.lapses - a.schedule.lapses || retrievability(a.schedule, now) - retrievability(b.schedule, now))
  const out: QueueItem[] = []
  for (const c of cards) {
    const key = c.factId ?? c.wordId!
    if (seen.has(key) || out.length >= limit) continue
    seen.add(key)
    out.push(itemOf(c))
  }
  return out
}

// A fake grader: a sentence with a verb ending in -s after he/she/it, or any
// sentence of five words or more, is right; short ones get a fix.
function grade(e: ExerciseInfo, text: string) {
  if (!mockControl.autofill) throw new Fail(503, 'autofill is not configured')
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) throw new Fail(400, 'text is empty')
  const words = t.split(' ')
  if (words.length >= 5) return { correct: true, corrected: t, explain: 'Всё верно: правило использовано как нужно.', score: 2 as const }
  const corrected = /[.!?]$/.test(t) ? `I have ${t.replace(/^I\s+/i, '')}` : `${t.charAt(0).toUpperCase()}${t.slice(1)}.`
  return { correct: false, corrected, explain: e.rubric ? `Не хватает: ${e.rubric}` : 'Предложение слишком короткое, чтобы показать правило.', score: 1 as const }
}

function createFact(body: Body, now: Date): Fact {
  const deck = mustDeck(body.deckId as string | undefined)
  const r = cleanFact(body as unknown as FactInput)
  if ('error' in r) throw new Fail(400, r.error)
  const dup = db.facts.find((f) => f.deckId === deck.id && factKey(f.front) === factKey(r.fact.front))
  if (dup) throw new Fail(409, `"${dup.front}" is already in this deck`, { existing: dup })
  const fact: Fact = { id: id('ft'), deckId: deck.id, ...r.fact, status: 'active', createdBy: 'user', createdAt: now.toISOString(), updatedAt: now.toISOString() }
  db.facts.push(fact)
  db.cards.push({ id: id('cd'), wordId: null, factId: fact.id, direction: 'forward', suspended: false, schedule: newCardState(now) })
  return fact
}

function updateFact(f: Fact, body: Body, now: Date): Fact {
  for (const k of Object.keys(body)) if (!['front', 'back', 'tags', 'status', 'deckId'].includes(k)) throw new Fail(400, `Unrecognized key: "${k}"`)
  const target = body.deckId ? mustDeck(String(body.deckId)) : deckOf(f.deckId)
  const r = cleanFact({ front: (body.front as string) ?? f.front, back: (body.back as string) ?? f.back, tags: (body.tags as string[]) ?? f.tags })
  if ('error' in r) throw new Fail(400, r.error)
  const dup = db.facts.find((x) => x.id !== f.id && x.deckId === target.id && factKey(x.front) === factKey(r.fact.front))
  if (dup) throw new Fail(409, `"${dup.front}" is already in this deck`, { existing: dup })
  if ('status' in body) f.status = body.status as Fact['status']
  Object.assign(f, r.fact, { deckId: target.id, updatedAt: now.toISOString() })
  return f
}

const PATCH_KEYS = ['term', 'pos', 'translations', 'ipa', 'examples', 'note', 'tags', 'cefr', 'status']

function updateWord(w: Word, body: Body, now: Date): Word {
  for (const k of Object.keys(body)) if (!PATCH_KEYS.includes(k)) throw new Fail(400, `unknown key ${k}`)
  const merged = { ...w, ...body } as unknown as WordInput
  const r = cleanWord(merged)
  if ('error' in r) throw new Fail(400, r.error)
  const dup = duplicateOf(w.deckId, r.word.term, r.word.pos, w.id)
  if (dup) throw dupError(dup)
  if ('status' in body) {
    if (!['active', 'rejected'].includes(String(body.status))) throw new Fail(400, 'unknown status')
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
    [w.term, ...w.translations, ...w.examples.flatMap((e) => [e.text, e.translation ?? '']), w.note ?? '', ...w.tags].join('\n').toLowerCase()
  const maxOf = (w: Word, f: (c: Card) => number) => Math.max(0, ...cardsOf(w.id).map(f))
  const all = db.words
    .filter((w) => (!deck || w.deckId === deck.id) && (!status || w.status === status) && (!pos || w.pos === pos) && (!cefr || w.cefr === cefr) && (!tag || w.tags.some((t) => tagMatches(tag, t))))
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
  // A new account (no words) has nothing known yet.
  const counts = db.words.length ? [...baselineSrs] : baselineSrs.map(() => 0)
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
  const cards = db.cards.filter((c) => c.wordId && activeIds.has(c.wordId))
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
    if (!c.suspended && known(s, now)) knownWords.add(c.wordId!)
    stable.set(c.wordId!, (stable.get(c.wordId!) ?? true) && s.state === 2 && s.stability >= 21)
  }
  const knownNow = knownWords.size

  const growth = Array.from({ length: 26 }, (_, i) => {
    const x = i / 25
    return { date: iso(now.getTime() - (25 - i) * 7 * D).slice(0, 10), known: Math.round(knownNow * (0.12 + 0.88 * x ** 1.3)) }
  })

  // Activity from every log (words and facts, any deck), per study day.
  const keys: string[] = []
  for (let i = 181; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * D), DAY))
  const perDay = new Map(keys.map((k) => [k, { day: k, reviews: 0, again: 0, timeMs: 0 }]))
  const studied = new Set<string>()
  const deckCards = new Set(db.cards.filter((c) => c.wordId && wordOf(c.wordId).deckId === deck.id).map((c) => c.id))
  for (const l of db.logs) {
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
    // Written exercises are graded by a fake Claude here (off with ?mock=noautofill).
    grading: mockControl.autofill,
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

const DECK_KEYS = ['name', 'newPerDay', 'forwardEnabled', 'reverseEnabled', 'reverseAfterDays', 'typeAnswer', 'reviewFilter']
// Settings that only mean something for words (a deck with languages).
const WORD_SETTINGS = ['forwardEnabled', 'reverseEnabled', 'reverseAfterDays', 'typeAnswer']

function patchDeck(d: MockDeck, body: Body) {
  for (const k of Object.keys(body)) if (!DECK_KEYS.includes(k)) throw new Fail(400, `Unrecognized key: "${k}"`)
  const wordOnly = WORD_SETTINGS.filter((k) => k in body)
  if (wordOnly.length && !d.targetLang) throw new Fail(400, `${wordOnly.join(', ')}: only for a deck with languages`)
  if ('name' in body) {
    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim()
    if (!name) throw new Fail(400, 'deck name is empty')
    if (db.decks.some((x) => x.id !== d.id && x.name.toLowerCase() === name.toLowerCase())) throw new Fail(409, `deck "${name}" already exists`)
    body.name = name
  }
  if ('reviewFilter' in body) body.reviewFilter = cleanReviewFilter(body.reviewFilter as ReviewFilter | null)
  if ('newPerDay' in body && (!Number.isInteger(body.newPerDay) || (body.newPerDay as number) < 0 || (body.newPerDay as number) > 999)) throw new Fail(400, 'newPerDay must be 0..999')
  if ('reverseAfterDays' in body && body.reverseAfterDays !== null && (!Number.isInteger(body.reverseAfterDays) || (body.reverseAfterDays as number) < 1 || (body.reverseAfterDays as number) > 365))
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
    const { items, counts, decks } = buildQueue(now, Number(url.searchParams.get('limit') ?? 200), deckId)
    return { items, counts, decks }
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
      for (const a of r.exercises ?? []) {
        const e = db.exercises.find((x) => x.id === a.id && x.factId === card.factId)
        if (!e) continue
        e.shownCount++
        e.lastShownAt = r.reviewedAt
        if (!a.bad) a.correct ? e.correctCount++ : e.wrongCount++
        if (a.overridden) e.needsReview = true
        if (a.bad) e.status = 'flagged'
      }
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
    if (!b && method === 'GET') return { decks: sortDecks(db.decks).map((d) => ({ ...d, extraNewToday: extraToday(d.id, now), counts: deckCounts(d, now), tags: deckTags(d.id) })) }
    if (!b && method === 'POST') {
      const name = String(B.name ?? '').replace(/\s+/g, ' ').trim()
      const lang = B.targetLang ? String(B.targetLang).toLowerCase() : null
      const native = B.nativeLang ? String(B.nativeLang).toLowerCase() : null
      if (!!lang !== !!native) throw new Fail(400, 'targetLang and nativeLang go together')
      const deckName = name || lang?.toUpperCase() || ''
      if (!deckName) throw new Fail(400, 'deck name is empty')
      if (db.decks.some((d) => d.name.toLowerCase() === deckName.toLowerCase())) throw new Fail(409, `deck "${deckName}" already exists`)
      if (lang && db.decks.some((d) => d.targetLang === lang)) throw new Fail(409, `a deck for ${lang} already exists`)
      const d: MockDeck = {
        id: id('dk'), name: deckName, targetLang: lang, nativeLang: native, newPerDay: Number(B.newPerDay ?? (lang ? 15 : 5)),
        forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null, typeAnswer: 'off', reviewFilter: null, createdAt: now.toISOString(),
      }
      db.decks.push(d)
      return new Reply(201, { deck: { ...d, counts: deckCounts(d, now), tags: [] } })
    }
    const d = db.decks.find((x) => x.id === b)
    if (!d) throw new Fail(404, 'deck not found')
    if (method === 'DELETE') {
      const words = db.words.filter((w) => w.deckId === d.id)
      const facts = db.facts.filter((f) => f.deckId === d.id)
      const withCards = ['delete'].includes(url.searchParams.get('cards') ?? url.searchParams.get('facts') ?? '')
      if ((words.length || facts.length) && !withCards) throw new Fail(409, `deck "${d.name}" still has cards`, { words: words.length, facts: facts.length })
      const ids = new Set([...words, ...facts].map((x) => x.id))
      const cardIds = new Set(db.cards.filter((c) => ids.has((c.factId ?? c.wordId)!)).map((c) => c.id))
      db.words = db.words.filter((w) => !ids.has(w.id))
      db.facts = db.facts.filter((f) => !ids.has(f.id))
      db.exercises = db.exercises.filter((e) => !ids.has(e.factId))
      db.cards = db.cards.filter((c) => !cardIds.has(c.id))
      db.logs = db.logs.filter((l) => !cardIds.has(l.cardId))
      db.decks = db.decks.filter((x) => x.id !== d.id)
      for (const [ref, factId] of packRefs) if (ids.has(factId)) packRefs.delete(ref)
      return { ok: true, words: words.length, facts: facts.length }
    }
    if (method === 'PATCH') {
      patchDeck(d, B)
      return { deck: d }
    }
    if (c === 'tags' && (parts[3] === 'rename' || parts[3] === 'delete') && method === 'POST') {
      const from = String(parts[3] === 'rename' ? B.from ?? '' : B.tag ?? '').trim()
      const to = String(B.to ?? '').trim()
      if (!from || (parts[3] === 'rename' && (!to || to === from))) throw new Fail(400, 'from and to are needed, and must differ')
      if (parts[3] === 'rename' && tagMatches(from, to)) throw new Fail(400, `"${to}" is under "${from}": a tag can't move into itself`)
      const merged = parts[3] === 'rename' && [...db.words, ...db.facts].some((x) => x.deckId === d.id && x.tags.some((t) => tagMatches(to, t)))
      const out = { cards: 0, words: 0, facts: 0, merged }
      for (const x of [...db.words, ...db.facts]) {
        if (x.deckId !== d.id || !x.tags.some((t) => tagMatches(from, t))) continue
        const next: string[] = []
        for (const t of x.tags) {
          const r = !tagMatches(from, t) ? t : parts[3] === 'rename' ? to + t.slice(from.length) : null
          if (r !== null && !next.includes(r)) next.push(r)
        }
        x.tags = next
        x.updatedAt = now.toISOString()
        out.cards++
        if ('term' in x) out.words++
        else out.facts++
      }
      return { deck: { id: d.id, name: d.name }, ...out }
    }
    if (c === 'extra-new' && method === 'POST') {
      const n = B.n === undefined ? 5 : Number(B.n)
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Fail(400, 'n must be 1..100')
      const k = `${d.id}:${today(now)}`
      extraNew.set(k, (extraNew.get(k) ?? 0) + n)
      return { deck: { ...d, extraNewToday: extraToday(d.id, now) } }
    }
    if (c === 'merge' && method === 'POST') {
      const into = resolveDeck(String(B.into ?? ''))
      if (!into || !B.into) throw new Fail(404, 'deck not found')
      if (into.id === d.id) throw new Fail(400, 'a deck cannot be merged into itself')
      const words = db.words.filter((w) => w.deckId === d.id)
      if (words.length && (d.targetLang !== into.targetLang || d.nativeLang !== into.nativeLang)) throw new Fail(409, `"${into.name}" takes no words of ${d.name}'s languages`)
      const tag = B.tag !== false
      const moved = { words: 0, facts: 0 }
      const skipped: { kind: 'word' | 'fact'; id: string; text: string }[] = []
      const tagged = (tags: string[]) => (tag && !tags.includes(d.name) ? [...tags, d.name] : tags)
      for (const w of words) {
        if (duplicateOf(into.id, w.term, w.pos)) skipped.push({ kind: 'word', id: w.id, text: w.term })
        else {
          Object.assign(w, { deckId: into.id, tags: tagged(w.tags) })
          moved.words++
        }
      }
      for (const f of db.facts.filter((x) => x.deckId === d.id)) {
        if (db.facts.some((x) => x.deckId === into.id && factKey(x.front) === factKey(f.front))) skipped.push({ kind: 'fact', id: f.id, text: f.front })
        else {
          Object.assign(f, { deckId: into.id, tags: tagged(f.tags) })
          moved.facts++
        }
      }
      const deleted = !skipped.length
      if (deleted) db.decks = db.decks.filter((x) => x.id !== d.id)
      return { from: { id: d.id, name: d.name, deleted }, into: { id: into.id, name: into.name }, moved, skipped }
    }
    if (c === 'review-options' && method === 'GET') {
      let filter: ReviewFilter | null = null
      try {
        filter = cleanReviewFilter(JSON.parse(url.searchParams.get('filter') ?? 'null') as ReviewFilter | null)
      } catch {
        throw new Fail(400, 'filter is not JSON')
      }
      return reviewOptions(d, filter, now)
    }
  }

  if (p === '/api/practice') {
    const fact = url.searchParams.get('fact')
    const ref = url.searchParams.get('deck')
    return { items: practice(now, fact ? { factId: fact } : { deckId: mustDeck(ref).id }, Math.min(50, Number(url.searchParams.get('limit') ?? 20) || 20)) }
  }
  if (p === '/api/handbook') return handbookOf(mustDeck(url.searchParams.get('deck')))

  // ---------- packs ----------

  if (p === '/api/packs') return { packs: [packInfo()] }
  if (a === 'packs' && b && method === 'POST') {
    if (b !== PACK.id) throw new Fail(404, `no pack ${b}`)
    // The deck asked for, else where it already is, else the deck with English.
    const known = packInfo().deckId
    const deck = B.deckId ? mustDeck(String(B.deckId)) : known ? deckOf(known) : (db.decks.find((d) => d.targetLang === 'en') ?? db.decks[0]!)
    let added = 0
    irregularVerbs.forEach((v, i) => {
      if (packRefs.has(packRef(v.verb))) return
      const at = new Date(now.getTime() + i).toISOString()
      const fact: Fact = { id: id('ft'), deckId: deck.id, ...packFact(v), tags: [PACK.name], status: 'active', createdBy: 'import', createdAt: at, updatedAt: at }
      db.facts.push(fact)
      db.cards.push({ id: id('cd'), wordId: null, factId: fact.id, direction: 'forward', suspended: false, schedule: newCardState(now) })
      packRefs.set(packRef(v.verb), fact.id)
      added++
    })
    return { deck, added, alreadyAdded: irregularVerbs.length - added, duplicates: 0, packs: [packInfo()] }
  }

  if (a === 'exercises' && b) {
    const e = db.exercises.find((x) => x.id === b)
    if (!e) throw new Fail(404, `exercise ${b} not found`)
    if (c === 'grade' && method === 'POST') {
      if (e.type !== 'write') throw new Fail(400, 'not a write item')
      return grade(e, String(B.text ?? ''))
    }
    if (method === 'DELETE') {
      db.exercises = db.exercises.filter((x) => x.id !== b)
      return { ok: true }
    }
    if (method === 'PATCH') {
      if ('status' in B) e.status = B.status as ExerciseInfo['status']
      if ('needsReview' in B) e.needsReview = !!B.needsReview
      return { exercise: e }
    }
  }

  // ---------- facts ----------

  if (a === 'facts') {
    if (!b && method === 'GET') {
      const ref = url.searchParams.get('deck')
      const deck = ref ? resolveDeck(ref) : null
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const tag = url.searchParams.get('tag')
      const facts = db.facts
        .filter((f) => (!ref || f.deckId === deck?.id) && (!tag || f.tags.some((t) => tagMatches(tag, t))) && (!q || `${f.front}\n${f.back}\n${f.tags.join(' ')}`.toLowerCase().includes(q)))
        .map((f) => factItem(f, now))
      return { facts, total: facts.length }
    }
    if (!b && method === 'POST') return new Reply(201, { fact: factItem(createFact(B, now), now) })
    const f = db.facts.find((x) => x.id === b)
    if (!f) throw new Fail(404, `fact ${b} not found`)
    if (c === 'exercises' && method === 'GET') return { exercises: db.exercises.filter((e) => e.factId === f.id) }
    if (c === 'exercises' && method === 'POST') {
      const created: { index: number; id: string }[] = []
      const duplicates: { index: number }[] = []
      const errors: { index: number; error: string }[] = []
      ;((B.items ?? []) as ExerciseInput[]).forEach((x, index) => {
        const r = cleanExercise(x)
        if ('error' in r) return void errors.push({ index, error: r.error })
        if (db.exercises.some((e) => e.factId === f.id && exerciseKey(e.prompt, e.type) === exerciseKey(r.item.prompt, r.item.type))) return void duplicates.push({ index })
        const e: ExerciseInfo = { ...r.item, id: id('ex'), factId: f.id, status: 'active', needsReview: false, createdBy: 'user', createdAt: now.toISOString(), shownCount: 0, lastShownAt: null, correctCount: 0, wrongCount: 0 }
        db.exercises.push(e)
        created.push({ index, id: e.id })
      })
      return new Reply(created.length ? 201 : 200, { created, duplicates, errors, exercises: db.exercises.filter((e) => e.factId === f.id) })
    }
    if (method === 'POST' && (c === 'drop' || c === 'restore')) {
      f.status = c === 'drop' ? 'rejected' : 'active'
      f.updatedAt = now.toISOString()
      return { fact: factItem(f, now) }
    }
    if (method === 'POST' && (c === 'suspend' || c === 'unsuspend')) {
      for (const card of db.cards) if (card.factId === f.id) card.suspended = c === 'suspend'
      return { fact: factItem(f, now) }
    }
    if (method === 'GET') {
      const card = db.cards.find((x) => x.factId === f.id)
      const logs = db.logs.filter((l) => l.cardId === card?.id).sort((x, y) => y.reviewedAt.localeCompare(x.reviewedAt)).slice(0, 20)
      return { fact: factItem(f, now), logs }
    }
    if (method === 'PATCH') return { fact: factItem(updateFact(f, B, now), now) }
    if (method === 'DELETE') {
      const card = db.cards.find((x) => x.factId === f.id)
      db.facts = db.facts.filter((x) => x.id !== f.id)
      db.cards = db.cards.filter((x) => x.factId !== f.id)
      db.logs = db.logs.filter((l) => l.cardId !== card?.id)
      return { ok: true }
    }
  }

  // ---------- words ----------

  if (p === '/api/words/autofill' && method === 'POST') return autofill(B)

  if (a === 'words') {
    if (!b && method === 'GET') return searchWords(url, now)
    if (!b && method === 'POST') return new Reply(201, { word: item(createWord(B, now), now) })
    const w = mustWord(b!)
    if (method === 'POST' && (c === 'drop' || c === 'restore')) {
      w.status = c === 'drop' ? 'rejected' : 'active'
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

  // ---------- progress ----------

  // Without ?deck= the forecast covers every deck, words and facts.
  if (p === '/api/stats') {
    const ref = url.searchParams.get('deck')
    const only = ref ? mustDeck(ref) : null
    const cards = db.cards.filter((c) => {
      const o = ownerOf(c)
      const deck = deckOf(o.deckId)
      return (!only || deck.id === only.id) && o.status === 'active' && !c.suspended && (!!c.factId || enabled(deck, c.direction)) && c.schedule.state !== 0
    })
    const start = nextDayStart(now, DAY).getTime() - D
    const forecast = Array.from({ length: 14 }, (_, i) => ({
      day: dayKey(new Date(start + i * D + H), DAY),
      due: cards.filter((c) => {
        const t = new Date(c.schedule.due).getTime()
        return (i === 0 || t >= start + i * D) && t < start + (i + 1) * D
      }).length,
    }))
    const n = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30))
    const days = Array.from({ length: n }, (_, i) => {
      const day = dayKey(new Date(now.getTime() - (n - 1 - i) * D), DAY)
      return { day, reviews: db.logs.filter((l) => dayKey(new Date(l.reviewedAt), DAY) === day).length, again: 0 }
    })
    return { forecast, days }
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
