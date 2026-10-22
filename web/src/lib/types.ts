// Shapes of the REST API responses as the web app uses them (DESIGN.md
// "REST API"). Entities come from @recall/core; these are the envelopes and
// the server-side shapes (repo.ts, dashboard.ts, vocab.ts) around them.
import type { Card, CardType, Cefr, Deck, Direction, Example, ExerciseItem, Fact, FactInput, FactStatus, PartOfSpeech, QueueItem, ReviewLog, Word, WordInput, WordStatus } from '@recall/core'

export interface MeUser {
  id: string
  telegramId: number
  name: string | null
  isOwner: boolean
}

export type AuthVia = 'session' | 'telegram' | 'bearer' | 'dev'

// The user's FSRS parameters; null weights = the defaults.
export interface FsrsParams {
  weights: number[] | null
  requestRetention: number
  trainedAt: string | null
  // Reviews the personal weights were trained on; reviews needed before training.
  reviewsUsed?: number | null
  minReviews?: number
}

export interface FsrsOptimizeResult {
  adopted: boolean
  // Why trained weights were not adopted (they predicted no better).
  reason?: string
  reviews: number | null
  fsrs: FsrsParams
}

export interface Me {
  user: MeUser
  authenticatedVia: AuthVia
  timeZone: string
  dayStartHour: number
  today: string
  reminderTime: string
  // null: the evening nudge is off.
  eveningReminderTime: string | null
  // null while the bot is off.
  botUsername: string | null
  // Newer servers only.
  fsrs?: FsrsParams
  weeklyReport?: boolean
  // 0 = Sunday.
  weeklyReportDay?: number
  weeklyReportTime?: string
}

export type MePatch = Partial<Pick<Me, 'timeZone' | 'reminderTime' | 'eveningReminderTime' | 'weeklyReport' | 'weeklyReportDay' | 'weeklyReportTime'>> & {
  // 0.75–0.97.
  requestRetention?: number
}

export interface ApiToken {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

export interface NewToken {
  token: ApiToken
  // Shown once; only its hash is stored.
  secret: string
}

export interface LoginStart {
  nonce: string
  url: string
  expiresAt: string
}

export type LoginPoll = { status: 'pending'; expiresAt: string } | { status: 'ok'; user: MeUser } | { status: 'expired' }

export interface QueueCounts {
  new: number
  learning: number
  review: number
}

// Today's counts of one deck under its review filter (the deck switcher).
export interface QueueDeck {
  id: string
  name: string
  hasLanguages: boolean
  counts: QueueCounts
}

export interface QueueResponse {
  items: QueueItem[]
  counts: QueueCounts
  // Every deck; older servers send none.
  decks: QueueDeck[]
}

export interface ReviewsResult {
  applied: number
  skipped: number
  cards: Card[]
}

// Typed answers: off, RU→EN cards only, or both directions.
export type TypeAnswer = 'off' | 'reverse' | 'both'

export interface DeckSettings extends Deck {
  typeAnswer: TypeAnswer
}

export interface DeckCounts {
  // Words and facts by status (dropped = rejected).
  total: number
  active: number
  dropped: number
  known: number
  // Cards of enabled directions.
  learning: number
  due: number
  new: number
  newTotal: number
}

export interface DeckWithCounts extends DeckSettings {
  counts: DeckCounts
  // Tags in use, most used first.
  tags: { tag: string; n: number }[]
}

export type DeckPatch = Partial<Pick<DeckSettings, 'name' | 'newPerDay' | 'forwardEnabled' | 'reverseEnabled' | 'reverseAfterDays' | 'typeAnswer' | 'reviewFilter'>>

// The review filter sheet: what a deck has to filter by, and today's count under a draft.
export interface ReviewOptions {
  counts: QueueCounts
  types: { value: CardType; n: number }[]
  tags: { value: string; n: number }[]
  pos: { value: PartOfSpeech; n: number }[]
  cefr: { value: Cefr; n: number }[]
  directions: { value: Direction; n: number }[]
}

export interface MergeResult {
  from: { id: string; name: string; deleted: boolean }
  into: { id: string; name: string }
  moved: { words: number; facts: number }
  skipped: { kind: 'word' | 'fact'; id: string; text: string }[]
}

export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'

export interface CardSummary {
  id: string
  direction: Direction
  // false while the deck has this direction turned off.
  enabled: boolean
  suspended: boolean
  state: CardStateName
  due: string
  stability: number
  difficulty: number
  reps: number
  lapses: number
  lastReview: string | null
  retrievability: number | null
}

export interface WordItem extends Word {
  deckName: string
  cards: Record<Direction, CardSummary | null>
}

export interface WordsPage {
  words: WordItem[]
  total: number
}

export interface WordDetail {
  word: WordItem
  logs: ReviewLog[]
}

export type NewWord = WordInput & { deckId?: string }

// A content pack offered by the server (GET /api/packs).
export interface PackInfo {
  id: string
  name: string
  description: string
  count: number
  added: boolean
  // Cards of it not in the collection yet.
  missing: number
  // Where its cards are, else where they'd go (a deck named after it is made then).
  deckId?: string
  deckName: string
}

export interface FactItem extends Fact {
  deckName: string
  card: CardSummary | null
  // A rule with an exercise pool.
  exercises?: { active: number; flagged: number; needsReview: number }
}

// One item of a rule's exercise pool, with how it has gone.
export interface ExerciseInfo extends ExerciseItem {
  factId: string
  status: 'active' | 'flagged'
  needsReview: boolean
  createdBy: string
  createdAt: string
  shownCount: number
  lastShownAt: string | null
  correctCount: number
  wrongCount: number
}

export interface FactDetail {
  fact: FactItem
  logs: ReviewLog[]
}

export type NewFact = FactInput & { deckId: string }
// deckId moves it to another topic deck.
export type FactPatch = Partial<FactInput> & { status?: FactStatus; deckId?: string }
export type WordPatch = Partial<WordInput> & { status?: WordStatus }

export interface WordQuery {
  deck?: string
  q?: string
  status?: WordStatus
  pos?: PartOfSpeech
  cefr?: Cefr
  tag?: string
  sort?: 'recent' | 'alpha' | 'freq' | 'difficulty'
  limit?: number
  offset?: number
}

// ✨ An autofilled word, before it is added.
export interface Draft {
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa: string | null
  examples: Example[]
  note: string | null
  cefr: Cefr | null
}

export interface AutofillResult {
  draft: Draft
  alternatives: Draft[]
  freqRank: number | null
  duplicate: Word | null
}

// ---------- dashboard ----------

export interface DirectionCounts {
  enabled: boolean
  new: number
  learning: number
  known: number
  fading: number
  suspended: number
}

export interface ScalePoint {
  id: string
  size: number
  label: string
  labelRu: string | null
  emoji: string | null
  group: 'learner' | 'native' | 'fun' | string
  range: [number, number] | null
  approximate: boolean
  source: string | null
  url: string | null
}

export interface Placement {
  level: ScalePoint | null
  next: ScalePoint | null
}

export interface BandResult {
  from: number
  to: number
  items: number
  yes: number
  hitRate: number | null
  known: number
  srs: number
}

export interface VocabEstimate {
  estimate: number | null
  interval: [number, number] | null
  adjusted: number
  srsKnown: number
  basis: 'test+app' | 'app'
  nativeEquivalent: { value: number; approximate: true }
  cefr: Placement
  scale: Record<string, Placement>
  perBand: BandResult[]
}

export interface TestResult extends VocabEstimate {
  testId: string
  falseAlarmRate: number
  pseudowords: { items: number; yes: number }
  answered: number
  method: string
  reliability: 'ok' | 'low'
  valid: boolean
}

export interface VocabScale {
  unit: string
  points: ScalePoint[]
  calibration: { adultSize: number; expectedInList: number; listSize: number | null }
}

export interface VocabularySummary {
  available: { frequencies: boolean; test: boolean; scale: boolean }
  latestTest: (TestResult & { completedAt: string }) | null
  current: VocabEstimate | null
  history: { testId: string; completedAt: string; estimate: number | null; adjusted: number; nativeEquivalent: number; reliability: string; valid: boolean }[]
  scale: VocabScale | null
}

export interface ActivityDay {
  day: string
  reviews: number
  again: number
  timeMs: number
}

export interface Dashboard {
  deck: Deck
  counts: {
    words: { total: number; active: number; rejected: number }
    directions: Record<Direction, DirectionCounts>
    known: number
    mastered: number
  }
  growth: { date: string; known: number }[]
  activity: {
    days: ActivityDay[]
    streak: { current: number; longest: number; studiedToday: boolean }
    totals: { reviews: number; timeMs: number }
  }
  retention: Record<Direction, { rate: number | null; reviews: number }>
  coverage: { from: number; to: number; words: number; known: number }[]
  vocabulary: VocabularySummary
}

export interface VocabTestStart {
  testId: string
  items: { id: string; word: string }[]
}

export interface TestSummary {
  id: string
  createdAt: string
  completedAt: string | null
  items: number
  result: TestResult | null
}
