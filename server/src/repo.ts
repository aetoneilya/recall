// Decks, words and cards: row mapping and mutations. Every function takes the
// acting user's id and only ever sees that user's rows: someone else's id
// behaves as if it didn't exist.
import {
  CLAUDE_TAG, cleanReviewFilter, cleanWord, dedupeKey, DIRECTIONS, LIMITS, newCardState, retrievability, WORD_STATUSES,
  type Author, type Card, type CardState, type Cefr, type CleanWord, type Deck, type Direction, type FsrsState, type ReviewFilter,
  type PartOfSpeech, type VerbForms, type Word, type WordInput, type WordStatus,
} from '@recall/core'
import { newId, tx, type Db } from './db.ts'
import type { Lexicon } from './lexicon.ts'
import { verbForms } from './pack-data.ts'

export class HttpError extends Error {
  status: number
  // Extra fields merged into the JSON error body.
  body: Record<string, unknown> | undefined
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
}

// A word with the same (normalised term, part of speech) already exists in the deck.
export class DuplicateWordError extends HttpError {
  existing: Word
  constructor(existing: Word) {
    super(409, `"${existing.term}" (${existing.pos}) is already in this deck`, { existing })
    this.existing = existing
  }
}

// ---------- rows ----------

export interface CardRow {
  id: string
  word_id: string | null
  fact_id: string | null
  direction: string
  suspended: number
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review: string | null
}

export interface WordRow {
  id: string
  user_id: string
  deck_id: string
  term: string
  pos: string
  translations: string
  ipa: string | null
  examples: string
  note: string | null
  tags: string
  freq_rank: number | null
  cefr: string | null
  status: string
  created_by: string
  dedupe_key: string
  import_ref: string | null
  created_at: string
  updated_at: string
}

interface DeckRow {
  id: string
  user_id: string
  name: string
  target_lang: string | null
  native_lang: string | null
  new_per_day: number
  forward_enabled: number
  reverse_enabled: number
  reverse_after_days: number | null
  type_answer: string
  review_filter: string | null
  created_at: string
}

// Typed answers in review: off, only for the reverse (production) card, or both directions.
export type TypeAnswer = 'off' | 'reverse' | 'both'
export const TYPE_ANSWERS: readonly TypeAnswer[] = ['off', 'reverse', 'both']

// A deck as the server returns it: the core shape plus server-side settings.
// extraNewToday: new cards added on top of newPerDay for the current study
// day ("+5 today"); filled where the day is known (listDecks / getDeck with
// `today`), 0 otherwise and when none.
export type DeckInfo = Deck & { typeAnswer: TypeAnswer; extraNewToday: number }

export function toCard(r: CardRow): Card {
  return { id: r.id, wordId: r.word_id, factId: r.fact_id ?? null, direction: r.direction as Direction, suspended: r.suspended === 1, schedule: toState(r) }
}

export function toState(r: Omit<CardRow, 'id' | 'word_id' | 'fact_id' | 'direction' | 'suspended'>): CardState {
  return {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    elapsedDays: r.elapsed_days,
    scheduledDays: r.scheduled_days,
    learningSteps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state as FsrsState,
    lastReview: r.last_review,
  }
}

export function toWord(r: WordRow): Word {
  return {
    id: r.id,
    deckId: r.deck_id,
    term: r.term,
    pos: r.pos as PartOfSpeech,
    translations: JSON.parse(r.translations) as string[],
    ipa: r.ipa,
    examples: JSON.parse(r.examples) as Word['examples'],
    note: r.note,
    tags: JSON.parse(r.tags) as string[],
    freqRank: r.freq_rank,
    cefr: r.cefr as Cefr | null,
    status: r.status as WordStatus,
    createdBy: r.created_by as Author,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...withForms(r.term, r.pos as PartOfSpeech),
  }
}

// `forms` only when there are some, so other words keep their shape.
function withForms(term: string, pos: PartOfSpeech): { forms?: VerbForms } {
  const f = verbForms(term, pos)
  return f ? { forms: f } : {}
}

function toDeck(r: DeckRow, extraNewToday = 0): DeckInfo {
  let filter: ReviewFilter | null = null
  try {
    filter = r.review_filter ? cleanReviewFilter(JSON.parse(r.review_filter) as ReviewFilter) : null
  } catch {
    filter = null
  }
  return {
    id: r.id,
    name: r.name,
    targetLang: r.target_lang,
    nativeLang: r.native_lang,
    newPerDay: r.new_per_day,
    forwardEnabled: r.forward_enabled === 1,
    reverseEnabled: r.reverse_enabled === 1,
    reverseAfterDays: r.reverse_after_days,
    typeAnswer: (TYPE_ANSWERS as readonly string[]).includes(r.type_answer) ? (r.type_answer as TypeAnswer) : 'off',
    reviewFilter: filter,
    createdAt: r.created_at,
    extraNewToday,
  }
}

// Each deck's extra new cards on study day `today` (study.addExtraNew).
function extraOn(db: Db, deckIds: string[], today: string | undefined): Map<string, number> {
  if (!today || !deckIds.length) return new Map()
  const rows = db.prepare(`SELECT deck_id, n FROM deck_extra_new WHERE day = ? AND deck_id IN (${deckIds.map(() => '?').join(',')})`).all(today, ...deckIds) as { deck_id: string; n: number }[]
  return new Map(rows.map((r) => [r.deck_id, r.n]))
}

// Columns of `cards` that hold the schedule, in CardState order.
export const STATE_COLUMNS =
  'due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ?'

export function stateValues(s: CardState) {
  return [s.due, s.stability, s.difficulty, s.elapsedDays, s.scheduledDays, s.learningSteps, s.reps, s.lapses, s.state, s.lastReview] as const
}

// SQL over `c` (cards) and `d` (decks): the card's direction is enabled in its deck.
export const ENABLED_DIRECTION = "((c.direction = 'forward' AND d.forward_enabled = 1) OR (c.direction = 'reverse' AND d.reverse_enabled = 1))"

// ---------- decks ----------

export const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian' }
const LANG = /^[a-z]{2,3}$/

// Decks with languages first, then the rest; each in the order they were
// made. `today` (a study day key) fills extraNewToday.
export function listDecks(db: Db, userId: string, today?: string): DeckInfo[] {
  const rows = db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY target_lang IS NULL, created_at, name COLLATE NOCASE').all(userId) as unknown as DeckRow[]
  const extra = extraOn(db, rows.map((r) => r.id), today)
  return rows.map((r) => toDeck(r, extra.get(r.id) ?? 0))
}

export function getDeck(db: Db, userId: string, id: string, today?: string): DeckInfo | null {
  const r = db.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?').get(id, userId) as DeckRow | undefined
  return r ? toDeck(r, extraOn(db, [r.id], today).get(r.id) ?? 0) : null
}

export function findDeckByName(db: Db, userId: string, name: string): DeckInfo | null {
  const r = db.prepare('SELECT * FROM decks WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name.trim()) as DeckRow | undefined
  return r ? toDeck(r) : null
}

// A deck id, a (case-insensitive) name or a target language code ("en").
export function resolveDeck(db: Db, userId: string, ref: string): DeckInfo | null {
  const byLang = LANG.test(ref) ? (db.prepare('SELECT * FROM decks WHERE user_id = ? AND target_lang = ?').get(userId, ref) as DeckRow | undefined) : undefined
  return getDeck(db, userId, ref) ?? findDeckByName(db, userId, ref) ?? (byLang ? toDeck(byLang) : null)
}

export const hasLanguages = (d: Pick<Deck, 'targetLang' | 'nativeLang'>) => !!d.targetLang && !!d.nativeLang

// Words need a deck with languages; facts go anywhere.
export function mustHaveLanguages(deck: DeckInfo): DeckInfo {
  if (!hasLanguages(deck)) throw new HttpError(400, `"${deck.name}" has no languages; words go into a deck with languages`)
  return deck
}

export interface DeckInput {
  name?: string
  // Both or neither.
  targetLang?: string | null
  nativeLang?: string | null
  newPerDay?: number
  typeAnswer?: TypeAnswer
}

const DECK_NAME_MAX = 100

function checkDeckName(db: Db, userId: string, raw: string, except?: string): string {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) throw new HttpError(400, 'deck name is empty')
  if (name.length > DECK_NAME_MAX) throw new HttpError(400, `deck name is longer than ${DECK_NAME_MAX} characters`)
  const other = findDeckByName(db, userId, name)
  if (other && other.id !== except) throw new HttpError(409, `deck "${name}" already exists`)
  return name
}

// A new deck without languages (facts, rules) starts with fewer new cards a day.
export const PLAIN_NEW_PER_DAY = 5

// A deck; with languages (one deck per target language) it takes words too.
// Its name defaults to the language's ("English") and is unique per user.
export function createDeck(db: Db, userId: string, input: DeckInput, now: Date): DeckInfo {
  const targetLang = input.targetLang?.trim().toLowerCase() || null
  const nativeLang = input.nativeLang?.trim().toLowerCase() || null
  if (!targetLang !== !nativeLang) throw new HttpError(400, 'give both targetLang and nativeLang, or neither')
  if (targetLang && nativeLang) {
    if (!LANG.test(targetLang) || !LANG.test(nativeLang)) throw new HttpError(400, 'targetLang and nativeLang must be ISO 639-1 codes like "en"')
    if (targetLang === nativeLang) throw new HttpError(400, 'targetLang and nativeLang must differ')
    if (db.prepare('SELECT 1 FROM decks WHERE user_id = ? AND target_lang = ?').get(userId, targetLang)) {
      throw new HttpError(409, `there is already a deck for ${LANGUAGE_NAMES[targetLang] ?? targetLang}: one deck per language`)
    }
  }
  const name = checkDeckName(db, userId, input.name ?? (targetLang ? LANGUAGE_NAMES[targetLang] ?? targetLang : ''))
  const id = newId('dk')
  db.prepare('INSERT INTO decks(id, user_id, name, target_lang, native_lang, new_per_day, type_answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, name, targetLang, nativeLang, checkNewPerDay(input.newPerDay ?? (targetLang ? 15 : PLAIN_NEW_PER_DAY)), checkTypeAnswer(input.typeAnswer ?? 'off'), now.toISOString())
  return getDeck(db, userId, id)!
}

// How many words and facts a deck holds.
export function deckSize(db: Db, userId: string, id: string): { words: number; facts: number } {
  const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE deck_id = ? AND user_id = ?`).get(id, userId) as { n: number }).n
  return { words: n('words'), facts: n('facts') }
}

// Deletes a deck. One with cards only with `withCards`: its words and facts
// go too, with their cards and review history. Returns how many went.
export function deleteDeck(db: Db, userId: string, id: string, { withCards = false } = {}): { words: number; facts: number } {
  return tx(db, () => {
    const deck = getDeck(db, userId, id)
    if (!deck) throw new HttpError(404, 'deck not found')
    const size = deckSize(db, userId, id)
    const n = size.words + size.facts
    if (n && !withCards) throw new HttpError(409, `deck "${deck.name}" still has ${n} ${n === 1 ? 'card' : 'cards'}`, { ...size })
    db.prepare('DELETE FROM words WHERE deck_id = ? AND user_id = ?').run(id, userId)
    db.prepare('DELETE FROM facts WHERE deck_id = ? AND user_id = ?').run(id, userId)
    db.prepare('UPDATE vocab_tests SET deck_id = NULL WHERE deck_id = ?').run(id)
    db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?').run(id, userId)
    return size
  })
}

// The user's English deck (en → ru), created on first use; else their first
// deck with languages. This is where words go by default.
export function defaultDeck(db: Db, userId: string, now: Date): DeckInfo {
  const en = db.prepare("SELECT * FROM decks WHERE user_id = ? AND target_lang = 'en'").get(userId) as DeckRow | undefined
  if (en) return toDeck(en)
  return listDecks(db, userId).find(hasLanguages) ?? createDeck(db, userId, { targetLang: 'en', nativeLang: 'ru' }, now)
}

export interface DeckPatch {
  name?: string
  newPerDay?: number
  forwardEnabled?: boolean
  reverseEnabled?: boolean
  reverseAfterDays?: number | null
  typeAnswer?: TypeAnswer
  reviewFilter?: ReviewFilter | null
}

// Turning a direction off keeps its cards and history; they are just not
// studied or counted until it is turned back on.
export function updateDeck(db: Db, userId: string, id: string, patch: DeckPatch, today?: string): DeckInfo {
  const deck = getDeck(db, userId, id, today)
  if (!deck) throw new HttpError(404, 'deck not found')
  if (patch.name !== undefined) deck.name = checkDeckName(db, userId, patch.name, id)
  if (patch.newPerDay !== undefined) deck.newPerDay = checkNewPerDay(patch.newPerDay)
  if (patch.forwardEnabled !== undefined) deck.forwardEnabled = patch.forwardEnabled
  if (patch.reverseEnabled !== undefined) deck.reverseEnabled = patch.reverseEnabled
  if (!deck.forwardEnabled && !deck.reverseEnabled) throw new HttpError(400, 'at least one direction must stay enabled')
  if (patch.reverseAfterDays !== undefined) {
    const d = patch.reverseAfterDays
    if (d !== null && (!Number.isFinite(d) || d < 1 || d > 365)) throw new HttpError(400, 'reverseAfterDays must be 1..365 days or null')
    deck.reverseAfterDays = d
  }
  if (patch.typeAnswer !== undefined) deck.typeAnswer = checkTypeAnswer(patch.typeAnswer)
  if (patch.reviewFilter !== undefined) deck.reviewFilter = cleanReviewFilter(patch.reviewFilter)
  db.prepare('UPDATE decks SET name = ?, new_per_day = ?, forward_enabled = ?, reverse_enabled = ?, reverse_after_days = ?, type_answer = ?, review_filter = ? WHERE id = ? AND user_id = ?')
    .run(deck.name, deck.newPerDay, deck.forwardEnabled ? 1 : 0, deck.reverseEnabled ? 1 : 0, deck.reverseAfterDays, deck.typeAnswer,
      deck.reviewFilter ? JSON.stringify(deck.reviewFilter) : null, id, userId)
  return deck
}

function checkTypeAnswer(v: string): TypeAnswer {
  if (!(TYPE_ANSWERS as readonly string[]).includes(v)) throw new HttpError(400, `typeAnswer must be one of ${TYPE_ANSWERS.join(', ')}`)
  return v as TypeAnswer
}

function checkNewPerDay(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, 'newPerDay must be an integer 0..1000')
  return n
}

export interface MergeResult {
  from: { id: string; name: string; deleted: boolean }
  into: { id: string; name: string }
  moved: { words: number; facts: number }
  // Already in the target by their dedupe key: left in the source.
  skipped: { kind: 'word' | 'fact'; id: string; text: string }[]
}

// Moves every word and fact of one deck into another — cards, schedules,
// history and exercise pools go with them — tagging each with the source's
// name (`tag`). Duplicates of the target's (by dedupe key) stay behind and
// are reported; the source is deleted once empty. Words only move between
// decks with the same languages.
export function mergeDecks(db: Db, userId: string, fromId: string, intoId: string, { tag = true } = {}, now = new Date()): MergeResult {
  return tx(db, () => {
    const from = getDeck(db, userId, fromId)
    const into = getDeck(db, userId, intoId)
    if (!from || !into) throw new HttpError(404, 'deck not found')
    if (from.id === into.id) throw new HttpError(400, 'a deck cannot be merged into itself')
    const words = db.prepare('SELECT id, term, tags, dedupe_key FROM words WHERE deck_id = ? AND user_id = ? ORDER BY created_at, id').all(from.id, userId) as { id: string; term: string; tags: string; dedupe_key: string }[]
    if (words.length && (from.targetLang !== into.targetLang || from.nativeLang !== into.nativeLang)) {
      throw new HttpError(409, `"${from.name}" has words and its languages differ from "${into.name}"'s; words can't move between languages`)
    }
    const facts = db.prepare('SELECT id, front, tags, dedupe_key FROM facts WHERE deck_id = ? AND user_id = ? ORDER BY created_at, id').all(from.id, userId) as { id: string; front: string; tags: string; dedupe_key: string }[]
    const out: MergeResult = { from: { id: from.id, name: from.name, deleted: false }, into: { id: into.id, name: into.name }, moved: { words: 0, facts: 0 }, skipped: [] }
    const at = now.toISOString()
    const withTag = (json: string) => {
      const tags = JSON.parse(json) as string[]
      if (tag && !tags.some((t) => t.toLowerCase() === from.name.toLowerCase()) && tags.length < LIMITS.tags) tags.push(from.name.slice(0, LIMITS.tag))
      return JSON.stringify(tags)
    }
    for (const [table, rows, kind] of [['words', words, 'word'], ['facts', facts, 'fact']] as const) {
      const dup = db.prepare(`SELECT 1 FROM ${table} WHERE deck_id = ? AND dedupe_key = ?`)
      const move = db.prepare(`UPDATE ${table} SET deck_id = ?, tags = ?, updated_at = ? WHERE id = ?`)
      for (const r of rows as { id: string; tags: string; dedupe_key: string; term?: string; front?: string }[]) {
        if (dup.get(into.id, r.dedupe_key)) {
          out.skipped.push({ kind, id: r.id, text: r.term ?? r.front ?? '' })
          continue
        }
        move.run(into.id, withTag(r.tags), at, r.id)
        out.moved[kind === 'word' ? 'words' : 'facts']++
      }
    }
    if (!out.skipped.length) {
      db.prepare('UPDATE vocab_tests SET deck_id = ? WHERE deck_id = ?').run(into.id, from.id)
      db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?').run(from.id, userId)
      out.from.deleted = true
    }
    return out
  })
}

// ---------- words ----------

export function getWord(db: Db, userId: string, id: string): Word | null {
  const r = db.prepare('SELECT * FROM words WHERE id = ? AND user_id = ?').get(id, userId) as WordRow | undefined
  return r ? toWord(r) : null
}

export function mustGetWord(db: Db, userId: string, id: string): Word {
  const w = getWord(db, userId, id)
  if (!w) throw new HttpError(404, `word ${id} not found`)
  return w
}

export function findDuplicate(db: Db, userId: string, deckId: string, term: string, pos: PartOfSpeech): Word | null {
  const r = db.prepare('SELECT * FROM words WHERE user_id = ? AND deck_id = ? AND dedupe_key = ?').get(userId, deckId, dedupeKey(term, pos)) as WordRow | undefined
  return r ? toWord(r) : null
}

export function clean(input: WordInput): CleanWord {
  const r = cleanWord(input)
  if ('error' in r) throw new HttpError(400, r.error)
  return r.word
}

const rankOf = (lex: Lexicon | null | undefined, term: string) => lex?.rank(term) ?? null

export interface NewWord {
  deckId: string
  word: WordInput
  status: WordStatus
  createdBy: Author
  importRef?: string | null
  createdAt?: Date
}

// Validates, dedupes (DuplicateWordError → 409 with the existing word) and
// inserts the word with its two new cards.
export function createWord(db: Db, userId: string, input: NewWord, now: Date, lex?: Lexicon | null): Word {
  return tx(db, () => {
    const deck = getDeck(db, userId, input.deckId)
    if (!deck) throw new HttpError(404, 'deck not found')
    mustHaveLanguages(deck)
    const w = clean(input.word)
    const dup = findDuplicate(db, userId, input.deckId, w.term, w.pos)
    if (dup) throw new DuplicateWordError(dup)
    const at = (input.createdAt ?? now).toISOString()
    const id = newId('wd')
    db.prepare(`INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, tags, freq_rank, cefr, status, created_by, dedupe_key, import_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, userId, input.deckId, w.term, w.pos, JSON.stringify(w.translations), w.ipa, JSON.stringify(w.examples), w.note,
      JSON.stringify(w.tags), rankOf(lex, w.term), w.cefr, input.status, input.createdBy, dedupeKey(w.term, w.pos), input.importRef ?? null, at, at,
    )
    for (const dir of DIRECTIONS) insertCard(db, id, dir, newCardState(new Date(at)))
    return getWord(db, userId, id)!
  })
}

export function insertCard(db: Db, wordId: string, direction: Direction, s: CardState, suspended = false, id = newId('cd')): string {
  db.prepare(
    `INSERT INTO cards(id, word_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, reps, lapses, state, last_review) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, wordId, direction, suspended ? 1 : 0, ...stateValues(s))
  return id
}

export type WordPatch = Partial<WordInput> & { status?: WordStatus }

// Only the fields given change; the cards and their history always stay.
export function updateWord(db: Db, userId: string, id: string, patch: WordPatch, now: Date, lex?: Lexicon | null): Word {
  return tx(db, () => {
    const cur = mustGetWord(db, userId, id)
    const has = (k: keyof WordPatch) => patch[k] !== undefined
    const w = clean({
      term: has('term') ? patch.term! : cur.term,
      pos: has('pos') ? patch.pos! : cur.pos,
      translations: has('translations') ? patch.translations! : cur.translations,
      ipa: has('ipa') ? patch.ipa : cur.ipa,
      examples: has('examples') ? patch.examples : cur.examples,
      note: has('note') ? patch.note : cur.note,
      tags: has('tags') ? patch.tags : cur.tags,
      cefr: has('cefr') ? patch.cefr : cur.cefr,
    })
    const status = patch.status ?? cur.status
    if (!WORD_STATUSES.includes(status)) throw new HttpError(400, `unknown status ${status}`)
    const dup = findDuplicate(db, userId, cur.deckId, w.term, w.pos)
    if (dup && dup.id !== id) throw new DuplicateWordError(dup)
    const rank = w.term === cur.term ? cur.freqRank ?? rankOf(lex, w.term) : rankOf(lex, w.term)
    db.prepare(`UPDATE words SET term = ?, pos = ?, translations = ?, ipa = ?, examples = ?, note = ?, tags = ?, freq_rank = ?, cefr = ?,
      status = ?, dedupe_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(
      w.term, w.pos, JSON.stringify(w.translations), w.ipa, JSON.stringify(w.examples), w.note, JSON.stringify(w.tags), rank, w.cefr,
      status, dedupeKey(w.term, w.pos), now.toISOString(), id, userId,
    )
    return getWord(db, userId, id)!
  })
}

export function setWordStatus(db: Db, userId: string, id: string, status: WordStatus, now: Date): Word {
  return updateWord(db, userId, id, { status }, now)
}

export function deleteWord(db: Db, userId: string, id: string) {
  const r = db.prepare('DELETE FROM words WHERE id = ? AND user_id = ?').run(id, userId)
  if (r.changes === 0) throw new HttpError(404, `word ${id} not found`)
}

// Recomputes freqRank of every word (or one user's) against the current
// frequency list; run at startup and whenever the list is (re)loaded.
// Returns how many changed.
export function refreshFreqRanks(db: Db, lex: Lexicon, userId: string | null = null): number {
  if (!lex.hasFrequencies()) return 0
  const rows = (userId
    ? db.prepare('SELECT id, term, freq_rank FROM words WHERE user_id = ?').all(userId)
    : db.prepare('SELECT id, term, freq_rank FROM words').all()) as { id: string; term: string; freq_rank: number | null }[]
  const set = db.prepare('UPDATE words SET freq_rank = ? WHERE id = ?')
  let n = 0
  tx(db, () => {
    for (const r of rows) {
      const rank = lex.rank(r.term)
      if (rank !== r.freq_rank) {
        set.run(rank, r.id)
        n++
      }
    }
  })
  return n
}

// Keeps ranks in step with the frequency list: recomputed once per list
// version (startup, and when en-freq.tsv appears or changes).
const synced = new WeakMap<Db, number>()
export function syncFreqRanks(db: Db, lex: Lexicon) {
  if (!lex.hasFrequencies()) return
  const v = lex.freqVersion()
  if (synced.get(db) === v) return
  synced.set(db, v)
  const n = refreshFreqRanks(db, lex)
  if (n) console.log(`frequency ranks updated for ${n} words`)
}

// ---------- cards ----------

// Cards have no user_id of their own: ownership is the word's.
const OWN_WORDS = 'word_id IN (SELECT id FROM words WHERE user_id = ?)'
// …or the fact's: any card of the user.
const OWN_CARDS = 'id IN (SELECT id FROM study_cards WHERE user_id = ?)'

export function getCard(db: Db, userId: string, id: string): Card | null {
  const r = db.prepare(`SELECT * FROM cards WHERE id = ? AND ${OWN_CARDS}`).get(id, userId) as CardRow | undefined
  return r ? toCard(r) : null
}

// forward first.
export function wordCards(db: Db, userId: string, wordId: string): Card[] {
  return (db.prepare(`SELECT * FROM cards WHERE word_id = ? AND ${OWN_WORDS} ORDER BY direction`).all(wordId, userId) as unknown as CardRow[]).map(toCard)
}

export function setSuspended(db: Db, userId: string, cardId: string, suspended: boolean): Card {
  const r = db.prepare(`UPDATE cards SET suspended = ? WHERE id = ? AND ${OWN_CARDS}`).run(suspended ? 1 : 0, cardId, userId)
  if (r.changes === 0) throw new HttpError(404, `card ${cardId} not found`)
  return getCard(db, userId, cardId)!
}

// Suspends or resumes both cards of a word.
export function setWordSuspended(db: Db, userId: string, wordId: string, suspended: boolean): Card[] {
  mustGetWord(db, userId, wordId)
  db.prepare(`UPDATE cards SET suspended = ? WHERE word_id = ? AND ${OWN_WORDS}`).run(suspended ? 1 : 0, wordId, userId)
  return wordCards(db, userId, wordId)
}

export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'
export const STATE_NAMES: readonly CardStateName[] = ['new', 'learning', 'review', 'relearning']

export interface CardSummary {
  id: string
  direction: Direction
  // false while the deck has this direction turned off.
  enabled: boolean
  suspended: boolean
  state: CardStateName
  due: string
  // Days; 0 for new cards.
  stability: number
  difficulty: number
  reps: number
  lapses: number
  lastReview: string | null
  // Probability of recall now, 0..1; null for new cards.
  retrievability: number | null
}

export function cardSummary(card: Card, deck: Pick<Deck, 'forwardEnabled' | 'reverseEnabled'>, now: Date): CardSummary {
  const s = card.schedule
  return {
    id: card.id,
    direction: card.direction,
    enabled: card.direction === 'forward' ? deck.forwardEnabled : deck.reverseEnabled,
    suspended: card.suspended,
    state: STATE_NAMES[s.state]!,
    due: s.due,
    stability: Math.round(s.stability * 100) / 100,
    difficulty: Math.round(s.difficulty * 100) / 100,
    reps: s.reps,
    lapses: s.lapses,
    lastReview: s.lastReview,
    retrievability: s.state === 0 ? null : Math.round(retrievability(s, now) * 1000) / 1000,
  }
}

// ---------- search ----------

export type WordSort = 'recent' | 'alpha' | 'freq' | 'difficulty'
export const WORD_SORTS: readonly WordSort[] = ['recent', 'alpha', 'freq', 'difficulty']

export interface WordSearch {
  deck?: string
  q?: string
  status?: WordStatus
  pos?: PartOfSpeech
  cefr?: Cefr
  // Every tag given (or one under it) must be on the word.
  tag?: string | string[]
  sort?: WordSort
  limit?: number
  offset?: number
}

export interface WordListItem extends Word {
  deckName: string
  cards: { forward: CardSummary | null; reverse: CardSummary | null }
}

const SORT_SQL: Record<WordSort, string> = {
  recent: 'w.created_at DESC, w.id',
  alpha: 'w.term COLLATE NOCASE, w.id',
  freq: 'w.freq_rank IS NULL, w.freq_rank, w.term COLLATE NOCASE',
  // Most lapses first, then the highest FSRS difficulty among reviewed cards.
  difficulty: '(SELECT sum(lapses) FROM cards WHERE word_id = w.id) DESC, (SELECT max(difficulty) FROM cards WHERE word_id = w.id AND state > 0) DESC, w.term COLLATE NOCASE',
}

export function withCards(db: Db, userId: string, rows: WordRow[], now: Date): WordListItem[] {
  if (!rows.length) return []
  const decks = new Map(listDecks(db, userId).map((d) => [d.id, d]))
  const ids = rows.map((r) => r.id)
  const byWord = new Map<string, Card[]>()
  // Chunked: SQLite caps bound parameters.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const cards = db.prepare(`SELECT * FROM cards WHERE word_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as CardRow[]
    for (const c of cards) byWord.set(c.word_id!, [...(byWord.get(c.word_id!) ?? []), toCard(c)])
  }
  return rows.map((r) => {
    const deck = decks.get(r.deck_id)!
    const cs = byWord.get(r.id) ?? []
    const pick = (d: Direction) => {
      const c = cs.find((x) => x.direction === d)
      return c ? cardSummary(c, deck, now) : null
    }
    return { ...toWord(r), deckName: deck.name, cards: { forward: pick('forward'), reverse: pick('reverse') } }
  })
}

export function searchWords(db: Db, userId: string, s: WordSearch, now: Date): { words: WordListItem[]; total: number } {
  const where: string[] = ['w.user_id = ?']
  const args: (string | number)[] = [userId]
  if (s.deck) {
    const deck = resolveDeck(db, userId, s.deck)
    if (!deck) return { words: [], total: 0 }
    where.push('w.deck_id = ?')
    args.push(deck.id)
  }
  for (const [col, v] of [['status', s.status], ['pos', s.pos], ['cefr', s.cefr]] as const) {
    if (v) {
      where.push(`w.${col} = ?`)
      args.push(v)
    }
  }
  if (s.q?.trim()) {
    // LIKE over the term and the JSON columns is good enough for a personal collection.
    const like = `%${s.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const cols = ['w.term', 'w.translations', 'w.note', 'w.tags', 'w.examples']
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    args.push(...cols.map(() => like))
  }
  for (const t of tagList(s.tag)) {
    where.push(tagWhere('w.tags'))
    args.push(...tagArgs(t))
  }
  const clause = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(s.limit ?? 50, 1), 500)
  const offset = Math.max(s.offset ?? 0, 0)
  const total = (db.prepare(`SELECT count(*) AS n FROM words w ${clause}`).get(...args) as { n: number }).n
  const rows = db.prepare(`SELECT w.* FROM words w ${clause} ORDER BY ${SORT_SQL[s.sort ?? 'recent']} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as WordRow[]
  return { words: withCards(db, userId, rows, now), total }
}

// ---------- batch add (MCP) ----------

export interface AddWordsResult {
  deck: { id: string; name: string }
  created: { index: number; id: string; term: string; pos: PartOfSpeech; status: WordStatus; freqRank: number | null }[]
  duplicates: { index: number; existingId: string; existingStatus: WordStatus; term: string; pos: PartOfSpeech; differs: Record<string, unknown> }[]
  errors: { index: number; term?: string; error: string }[]
}

// What a proposed duplicate would add to the existing word.
export function differences(existing: Word, w: CleanWord): Record<string, unknown> {
  const d: Record<string, unknown> = {}
  const lower = existing.translations.map((t) => t.toLowerCase())
  const newTranslations = w.translations.filter((t) => !lower.includes(t.toLowerCase()))
  if (newTranslations.length) d.newTranslations = newTranslations
  const newExamples = w.examples.filter((e) => !existing.examples.some((x) => x.text === e.text))
  if (newExamples.length) d.newExamples = newExamples
  if (w.term !== existing.term) d.term = { existing: existing.term, proposed: w.term }
  for (const k of ['ipa', 'note', 'cefr'] as const) {
    if (w[k] && w[k] !== existing[k]) d[k] = { existing: existing[k], proposed: w[k] }
  }
  return d
}

// Each word is validated and deduped like a manual add, against words of any
// status (a dropped word stays dropped) and earlier words in the batch. The
// words are studied at once; Claude's get the "claude" tag.
// Claude's tag first, so it survives the tag limit.
// A tags column holding `tag` or a tag under it ("Grammar" → "Grammar/Tenses");
// bind with tagArgs(tag).
export const tagWhere = (col: string) =>
  `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ? OR json_each.value LIKE ? ESCAPE '\\')`
export const tagArgs = (tag: string) => [tag, tag.replace(/[\\%_]/g, (c) => '\\' + c) + '/%']
// A search's tag or tags, blanks dropped.
export const tagList = (t: string | string[] | undefined) => (Array.isArray(t) ? t : t ? [t] : []).filter((x) => x.trim())

export const withClaudeTag = (tags: string[] | undefined) => [CLAUDE_TAG, ...(tags ?? []).filter((t) => t.trim().toLowerCase() !== CLAUDE_TAG)]

export function addWords(
  db: Db,
  userId: string,
  input: { deck?: string; words: WordInput[]; createdBy: Author },
  now: Date,
  lex?: Lexicon | null,
): AddWordsResult {
  return tx(db, () => {
    const deck = input.deck ? resolveDeck(db, userId, input.deck) : defaultDeck(db, userId, now)
    if (!deck) throw new HttpError(404, `no deck "${input.deck}"; call list_decks to see the existing ones`)
    mustHaveLanguages(deck)
    const out: AddWordsResult = { deck: { id: deck.id, name: deck.name }, created: [], duplicates: [], errors: [] }
    const status: WordStatus = 'active'
    input.words.forEach((p, index) => {
      const r = cleanWord(input.createdBy === 'claude' ? { ...p, tags: withClaudeTag(p.tags) } : p)
      if ('error' in r) {
        out.errors.push({ index, term: p.term, error: r.error })
        return
      }
      const dup = findDuplicate(db, userId, deck.id, r.word.term, r.word.pos)
      if (dup) {
        out.duplicates.push({ index, existingId: dup.id, existingStatus: dup.status, term: dup.term, pos: dup.pos, differs: differences(dup, r.word) })
        return
      }
      const w = createWord(db, userId, { deckId: deck.id, word: r.word, status, createdBy: input.createdBy }, now, lex)
      out.created.push({ index, id: w.id, term: w.term, pos: w.pos, status, freqRank: w.freqRank })
    })
    return out
  })
}
