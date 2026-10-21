// Shared shapes for the server, the web app and the MCP tools. Dates travel
// as ISO strings; the server stores them the same way.

// inbox: proposed (usually by Claude), not studied until approved.
// active: its cards get reviewed. rejected: kept for history, never shown,
// so a re-proposed duplicate can be detected.
export type WordStatus = 'inbox' | 'active' | 'rejected'
export const WORD_STATUSES: readonly WordStatus[] = ['inbox', 'active', 'rejected']

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

// language: words, one deck per language per user, e.g. "English" (en → ru).
// topic: Q&A facts on one subject, e.g. "Concurrency"; no languages.
export type DeckKind = 'language' | 'topic'
export const DECK_KINDS: readonly DeckKind[] = ['language', 'topic']

export interface Deck {
  id: string
  kind: DeckKind
  name: string
  // ISO 639-1: the language being learnt and the user's own; null for topic decks.
  targetLang: string | null
  nativeLang: string | null
  newPerDay: number
  // Whether the deck's cards are in the review session. Off: kept, not queued.
  inReview: boolean
  // A disabled direction's cards stay (with their history) but are not studied
  // or counted. Language decks only; a topic deck's facts are always forward.
  forwardEnabled: boolean
  reverseEnabled: boolean
  // When set, a word's reverse card is introduced only once its forward card's
  // stability reaches this many days. null = both directions from the start.
  reverseAfterDays: number | null
  createdAt: string
}

// A question and its answer in a topic deck; both sides are Markdown.
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
}

// The word or fact behind a queue item: siblings share it.
export function itemOf(it: QueueItem): Word | Fact {
  return it.kind === 'fact' ? it.fact : it.word
}
