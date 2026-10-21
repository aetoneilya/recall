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
  // Where the word came from: a book, an article.
  source: string | null
  tags: string[]
  // Rank of the term's lemma in the frequency list (1 = most frequent), computed by the server.
  freqRank: number | null
  cefr: Cefr | null
  status: WordStatus
  createdBy: Author
  createdAt: string
  updatedAt: string
}

// One deck per language per user, e.g. "English" (en → ru).
export interface Deck {
  id: string
  name: string
  // ISO 639-1: the language being learnt and the user's own.
  targetLang: string
  nativeLang: string
  newPerDay: number
  // A disabled direction's cards stay (with their history) but are not studied or counted.
  forwardEnabled: boolean
  reverseEnabled: boolean
  // When set, a word's reverse card is introduced only once its forward card's
  // stability reaches this many days. null = both directions from the start.
  reverseAfterDays: number | null
  createdAt: string
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

export interface Card {
  id: string
  wordId: string
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

// What the review screen needs for one card; render it with wordFace(word, card.direction).
export interface QueueItem {
  card: Card
  word: Word
  deckName: string
}
