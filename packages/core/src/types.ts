import type { ExerciseAttempt, ExerciseItem } from './exercises.ts'

// Shared shapes for the server, the web app and the MCP tools. Dates travel
// as ISO strings; the server stores them the same way.

// active: its cards get reviewed (everything added starts here).
// rejected ("dropped" in the app): kept, never shown, so the same word or
// question proposed again is recognised as a duplicate.
export type WordStatus = 'active' | 'rejected'
export const WORD_STATUSES: readonly WordStatus[] = ['active', 'rejected']

// The tag on every card Claude adds.
export const CLAUDE_TAG = 'claude'

export type Author = 'user' | 'claude' | 'import'

export type PartOfSpeech =
  | 'noun' | 'verb' | 'adjective' | 'adverb' | 'phrasal_verb' | 'idiom' | 'phrase'
  | 'preposition' | 'conjunction' | 'pronoun' | 'interjection' | 'other'
export const PARTS_OF_SPEECH: readonly PartOfSpeech[] = [
  'noun', 'verb', 'adjective', 'adverb', 'phrasal_verb', 'idiom', 'phrase',
  'preposition', 'conjunction', 'pronoun', 'interjection', 'other',
]

export type Cefr = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'
export const CEFR_LEVELS: readonly Cefr[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

// forward: target → native (EN→RU, recognition). reverse: native → target (RU→EN, production).
export type Direction = 'forward' | 'reverse'
export const DIRECTIONS: readonly Direction[] = ['forward', 'reverse']

export interface Example {
  // In the target language.
  text: string
  // In the native language.
  translation: string | null
}

// One vocabulary item. Every word has exactly two cards, one per direction.
export interface Word {
  id: string
  deckId: string
  // Base form as entered, e.g. "to frown", "a chicken and egg situation".
  term: string
  pos: PartOfSpeech
  // At least one; the main translation first.
  translations: string[]
  // Without delimiters: "fraʊn", shown as /fraʊn/.
  ipa: string | null
  // At most 5.
  examples: Example[]
  // Usage, register, collocations — in the native language.
  note: string | null
  // Free labels, e.g. the book or article the word came from.
  tags: string[]
  // Rank of the term's lemma in the frequency list (1 = most frequent), computed by the server.
  freqRank: number | null
  cefr: Cefr | null
  status: WordStatus
  createdBy: Author
  createdAt: string
  updatedAt: string
  // An irregular verb's past and participle (variants in each list, General
  // American first), computed by the server from the irregular-verbs pack;
  // absent for other words and on words cached before it existed.
  forms?: VerbForms | null
}

export interface VerbForms {
  past: string[]
  participle: string[]
}

// The kinds of card a deck holds: a word (two cards, needs the deck's
// languages), a question/answer fact, a grammar rule (a fact reviewed
// through its exercise pool, ≥ 3 active items).
export type CardType = 'word' | 'fact' | 'rule'
export const CARD_TYPES: readonly CardType[] = ['word', 'fact', 'rule']

// What a deck's review session takes; every field empty or missing = all.
// Tags apply to every card; part of speech, CEFR and direction only to
// words (other cards pass them).
export interface ReviewFilter {
  types?: CardType[]
  tags?: string[]
  pos?: PartOfSpeech[]
  cefr?: Cefr[]
  directions?: Direction[]
}

// A big container ("English", "Programming") of cards of any type; topics
// within it are tags. Languages are optional: only a deck with them takes
// words (one deck per target language per user).
export interface Deck {
  id: string
  name: string
  // ISO 639-1: the language being learnt and the user's own; both or neither.
  targetLang: string | null
  nativeLang: string | null
  newPerDay: number
  // Word cards only: a disabled direction's cards stay (with their history)
  // but are not studied or counted.
  forwardEnabled: boolean
  reverseEnabled: boolean
  // When set, a word's reverse card is introduced only once its forward card's
  // stability reaches this many days. null = both directions from the start.
  reverseAfterDays: number | null
  // The review session's filter; null = everything.
  reviewFilter: ReviewFilter | null
  createdAt: string
}

// What a card is, for the review filter.
export interface CardFacts {
  type: CardType
  tags: string[]
  // Words only.
  pos?: PartOfSpeech | null
  cefr?: Cefr | null
  direction?: Direction
}

const has = <T>(xs: readonly T[] | undefined): xs is readonly T[] => !!xs && xs.length > 0

// Whether a card is in a deck's review filter.
export function inReviewFilter(f: ReviewFilter | null | undefined, c: CardFacts): boolean {
  if (!f) return true
  if (has(f.types) && !f.types.includes(c.type)) return false
  if (has(f.tags) && !c.tags.some((t) => f.tags!.includes(t))) return false
  if (c.type === 'word') {
    if (has(f.pos) && (!c.pos || !f.pos.includes(c.pos))) return false
    if (has(f.cefr) && (!c.cefr || !f.cefr.includes(c.cefr))) return false
    if (has(f.directions) && c.direction && !f.directions.includes(c.direction)) return false
  }
  return true
}

// An empty filter, normalised away.
export function cleanReviewFilter(f: ReviewFilter | null | undefined): ReviewFilter | null {
  if (!f) return null
  const out: ReviewFilter = {}
  for (const k of ['types', 'tags', 'pos', 'cefr', 'directions'] as const) {
    const v = [...new Set((f[k] ?? []) as string[])].filter(Boolean)
    if (v.length) (out as Record<string, string[]>)[k] = v
  }
  return Object.keys(out).length ? out : null
}

// A question and its answer; both sides are Markdown.
// One card per fact (direction 'forward').
export type FactStatus = WordStatus
export const FACT_STATUSES: readonly FactStatus[] = WORD_STATUSES

export interface Fact {
  id: string
  deckId: string
  front: string
  back: string
  tags: string[]
  status: FactStatus
  createdBy: Author
  createdAt: string
  updatedAt: string
}

// 0 New, 1 Learning, 2 Review, 3 Relearning — same numbers as ts-fsrs State.
export type FsrsState = 0 | 1 | 2 | 3

export interface CardState {
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: FsrsState
  lastReview: string | null
}

// A word's card (one per direction) or a fact's (forward): exactly one of
// wordId / factId is set.
export interface Card {
  id: string
  wordId: string | null
  factId: string | null
  direction: Direction
  suspended: boolean
  schedule: CardState
}

// 1 Again, 2 Hard, 3 Good, 4 Easy.
export type Rating = 1 | 2 | 3 | 4

// Written by the client; `id` is a client-generated UUID so retried
// uploads from the offline outbox are idempotent.
export interface ReviewInput {
  id: string
  cardId: string
  rating: Rating
  reviewedAt: string
  durationMs?: number
  // An exercise review: how each item went (stored with the log).
  exercises?: ExerciseAttempt[]
}

export interface ReviewLog extends ReviewInput {
  before: CardState
  after: CardState
}

// What the review screen needs for one card: a word's (render it with
// wordFace(word, card.direction)) or a fact's.
export type QueueItem = WordQueueItem | FactQueueItem

export interface WordQueueItem {
  kind: 'word'
  card: Card
  word: Word
  deckName: string
}

export interface FactQueueItem {
  kind: 'fact'
  card: Card
  fact: Fact
  deckName: string
  // A rule with an exercise pool: this review's items (3), picked by the
  // server; absent for a plain question/answer fact.
  exercises?: ExerciseItem[]
}

// The word or fact behind a queue item: siblings share it.
export function itemOf(it: QueueItem): Word | Fact {
  return it.kind === 'fact' ? it.fact : it.word
}
