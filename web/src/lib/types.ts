// Shapes of the REST API responses as the web app uses them (DESIGN.md
// "REST API"). Entities come from @recall/core; these are the envelopes and
// the server-side shapes (repo.ts, dashboard.ts, vocab.ts) around them.
import type { Card, Cefr, Deck, DeckKind, Direction, Example, Fact, FactInput, FactStatus, PartOfSpeech, QueueItem, ReviewLog, Word, WordInput, WordStatus } from '@recall/core'

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

// Today's counts of one deck, whether in review or not (the deck chips).
export interface QueueDeck {
  id: string
  name: string
  kind: DeckKind
  inReview: boolean
  counts: QueueCounts
}

export interface QueueResponse {
  items: QueueItem[]
  counts: QueueCounts
  inbox: number
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
  // Words (facts in a topic deck) by status.
  total: number
  active: number
  inbox: number
  known: number
  // Cards of enabled directions.
  learning: number
  due: number
  new: number
  newTotal: number
}

export interface DeckWithCounts extends DeckSettings {
  counts: DeckCounts
}

export type DeckPatch = Partial<Pick<DeckSettings, 'name' | 'newPerDay' | 'inReview' | 'forwardEnabled' | 'reverseEnabled' | 'reverseAfterDays' | 'typeAnswer'>>

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
  deckId?: string
}

export interface FactItem extends Fact {
  deckName: string
  card: CardSummary | null
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
    words: { total: number; active: number; inbox: number; rejected: number }
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
