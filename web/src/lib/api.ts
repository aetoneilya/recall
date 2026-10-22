import type { ExerciseInput, QueueItem, ReviewFilter, ReviewInput, WriteGrade } from '@recall/core'
import type {
  ApiToken,
  AutofillResult,
  Dashboard,
  DeckPatch,
  DeckWithCounts,
  ExerciseInfo,
  MergeResult,
  ReviewOptions,
  FactDetail,
  FactItem,
  FactPatch,
  FsrsOptimizeResult,
  LoginPoll,
  LoginStart,
  Me,
  MePatch,
  NewFact,
  NewToken,
  NewWord,
  Handbook,
  PackInfo,
  QueueDeck,
  QueueResponse,
  ReviewsResult,
  TestResult,
  TestSummary,
  TypeAnswer,
  VocabTestStart,
  WordDetail,
  WordItem,
  WordPatch,
  WordQuery,
  WordsPage,
} from './types.ts'

export class AuthError extends Error {
  constructor(message = 'Not signed in') {
    super(message)
  }
}

// A real Telegram account that isn't on the allowlist; `telegramId` is what
// the owner needs to add them.
export class NotAllowedError extends AuthError {
  telegramId: number
  constructor(telegramId: number) {
    super('Not allowed')
    this.telegramId = telegramId
  }
}

export class HttpError extends Error {
  status: number
  // The parsed error body, e.g. {error, existing} for a duplicate word.
  data: Record<string, unknown>
  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message || `HTTP ${status}`)
    this.status = status
    this.data = data
  }
}

// fetch itself failed: offline, DNS, connection reset.
export class NetworkError extends Error {}

export interface ApiOptions {
  fetch?: typeof fetch
  base?: string
  // Telegram Mini App launch data; sent on every request when present.
  initData?: () => string | undefined
  onUnauthorized?: (e: AuthError) => void
  onNetwork?: (online: boolean) => void
}

type Json = Record<string, unknown>

export function createApi(opts: ApiOptions = {}) {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const base = opts.base ?? ''

  async function request<T>(method: string, path: string, body?: unknown, extra: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const initData = opts.initData?.()
    if (initData) headers['X-Telegram-Init-Data'] = initData

    let res: Response
    try {
      res = await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        ...extra,
      })
    } catch (e) {
      opts.onNetwork?.(false)
      throw new NetworkError(e instanceof Error ? e.message : String(e))
    }
    opts.onNetwork?.(true)

    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (res.status === 401) {
      const d = (data && typeof data === 'object' ? data : {}) as Json
      const err = d.error === 'not allowed' && typeof d.telegramId === 'number' ? new NotAllowedError(d.telegramId) : new AuthError()
      opts.onUnauthorized?.(err)
      throw err
    }
    if (!res.ok) {
      const msg = typeof data === 'object' && data && 'error' in data ? String((data as Json).error) : typeof data === 'string' ? data : ''
      throw new HttpError(res.status, msg, data && typeof data === 'object' ? (data as Json) : {})
    }
    return data as T
  }

  const get = <T>(path: string) => request<T>('GET', path)
  const post = <T>(path: string, body: unknown = {}, extra?: RequestInit) => request<T>('POST', path, body, extra)

  return {
    request,
    me: () => get<Me>('/api/me'),
    login: (password: string) => post<unknown>('/api/login', { password }),
    logout: () => post<unknown>('/api/logout'),
    patchMe: (p: MePatch) => request<Me>('PATCH', '/api/me', p),
    // 422 not enough reviews (data.reviews / data.minReviews), 429 ran recently (data.retryAfterSeconds).
    optimizeFsrs: () => post<FsrsOptimizeResult>('/api/fsrs/optimize'),

    // Bot login: start, then poll until ok (sets the session cookie) or expired.
    loginTelegram: () => post<LoginStart>('/api/login/telegram'),
    pollLogin: async (nonce: string): Promise<LoginPoll> => {
      try {
        return await get<LoginPoll>(`/api/login/telegram/${enc(nonce)}`)
      } catch (e) {
        if (e instanceof HttpError && e.status === 410) return { status: 'expired' }
        throw e
      }
    },

    tokens: async () => list<ApiToken>(await get<unknown>('/api/tokens'), 'tokens'),
    createToken: (name: string) => post<NewToken>('/api/tokens', { name }),
    deleteToken: (id: string) => request<unknown>('DELETE', `/api/tokens/${enc(id)}`),

    // One deck's session (all decks' without one) and every deck's counts.
    queue: async (limit = 200, deckId?: string) => normalizeQueue(await get<Json>(`/api/queue?limit=${limit}${deckId ? `&deck=${enc(deckId)}` : ''}`)),
    // keepalive lets the upload survive the page being hidden mid-request,
    // which is exactly when the outbox flushes on iOS.
    postReviews: (inputs: ReviewInput[]) => post<ReviewsResult>('/api/reviews', inputs, { keepalive: true }),
    undoReview: (id: string) => post<unknown>('/api/reviews/undo', { id }),

    decks: async () => list<Json>(await get<unknown>('/api/decks'), 'decks').map(normalizeDeck),
    patchDeck: async (id: string, d: DeckPatch) => normalizeDeck(unwrap<Json>(await request<Json>('PATCH', `/api/decks/${enc(id)}`, d), 'deck')),
    // Languages both or neither: a deck with them takes words.
    createDeck: async (d: { name: string; targetLang?: string | null; nativeLang?: string | null }) => normalizeDeck(unwrap<Json>(await post<Json>('/api/decks', d), 'deck')),
    // One with cards only with withCards (they're deleted too), else HttpError 409 with data.words / data.facts.
    deleteDeck: (id: string, withCards = false) => request<{ ok: true; words: number; facts: number }>('DELETE', `/api/decks/${enc(id)}${withCards ? '?cards=delete' : ''}`),
    mergeDeck: (id: string, into: string, tag = true) => post<MergeResult>(`/api/decks/${enc(id)}/merge`, { into, tag }),
    reviewOptions: (id: string, filter: ReviewFilter | null) =>
      get<ReviewOptions>(`/api/decks/${enc(id)}/review-options${filter ? `?filter=${enc(JSON.stringify(filter))}` : ''}`),

    facts: async (q: { deck?: string; q?: string; tag?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') qs.set(k, String(v))
      const data = await get<Json>(`/api/facts?${qs}`)
      const facts = list<FactItem>(data, 'facts')
      return { facts, total: typeof data.total === 'number' ? data.total : facts.length }
    },

    packs: async () => list<PackInfo>(await get<unknown>('/api/packs'), 'packs'),
    // Adds the pack's missing cards; the updated list comes back.
    addPack: (id: string, deckId?: string) => post<{ added: number; alreadyAdded: number; duplicates: number; packs: PackInfo[] }>(`/api/packs/${enc(id)}`, deckId ? { deckId } : {}),

    fact: (id: string) => get<FactDetail>(`/api/facts/${enc(id)}`),
    exercises: async (factId: string) => list<ExerciseInfo>(await get<unknown>(`/api/facts/${enc(factId)}/exercises`), 'exercises'),
    addExercises: (factId: string, items: ExerciseInput[]) =>
      post<{ created: { index: number; id: string }[]; duplicates: { index: number }[]; errors: { index: number; error: string }[]; exercises: ExerciseInfo[] }>(`/api/facts/${enc(factId)}/exercises`, { items }),
    patchExercise: async (id: string, p: Partial<ExerciseInput> & { status?: 'active' | 'flagged'; needsReview?: boolean }) =>
      unwrap<ExerciseInfo>(await request<Json>('PATCH', `/api/exercises/${enc(id)}`, p), 'exercise'),
    deleteExercise: (id: string) => request<unknown>('DELETE', `/api/exercises/${enc(id)}`),
    // A duplicate question is HttpError 409 with data.existing.
    createFact: async (f: NewFact) => unwrap<FactItem>(await post<Json>('/api/facts', f), 'fact'),
    updateFact: async (id: string, p: FactPatch) => unwrap<FactItem>(await request<Json>('PATCH', `/api/facts/${enc(id)}`, p), 'fact'),
    deleteFact: (id: string) => request<unknown>('DELETE', `/api/facts/${enc(id)}`),
    // Drop: never shown again (status rejected); restore brings it back.
    dropFact: async (id: string, on = true) => unwrap<FactItem>(await post<Json>(`/api/facts/${enc(id)}/${on ? 'drop' : 'restore'}`), 'fact'),
    suspendFact: async (id: string, on: boolean) => unwrap<FactItem>(await post<Json>(`/api/facts/${enc(id)}/${on ? 'suspend' : 'unsuspend'}`), 'fact'),

    words: async (q: WordQuery = {}): Promise<WordsPage> => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') qs.set(k, String(v))
      const data = await get<Json>(`/api/words?${qs}`)
      const words = list<WordItem>(data, 'words')
      return { words, total: typeof data.total === 'number' ? data.total : words.length }
    },
    word: (id: string) => get<WordDetail>(`/api/words/${enc(id)}`),
    autofill: (term: string, hint?: string, deckId?: string, signal?: AbortSignal) =>
      post<AutofillResult>('/api/words/autofill', { term, ...(hint ? { hint } : {}), ...(deckId ? { deckId } : {}) }, { signal }),
    // A duplicate is HttpError 409 with data.existing: the word already in the deck.
    createWord: async (w: NewWord) => unwrap<WordItem>(await post<Json>('/api/words', w), 'word'),
    updateWord: async (id: string, p: WordPatch) => unwrap<WordItem>(await request<Json>('PATCH', `/api/words/${enc(id)}`, p), 'word'),
    deleteWord: (id: string) => request<unknown>('DELETE', `/api/words/${enc(id)}`),
    dropWord: async (id: string, on = true) => unwrap<WordItem>(await post<Json>(`/api/words/${enc(id)}/${on ? 'drop' : 'restore'}`), 'word'),
    suspendCard: (cardId: string, on: boolean) => post<unknown>(`/api/cards/${enc(cardId)}/${on ? 'suspend' : 'unsuspend'}`),

    dashboard: () => get<Dashboard>('/api/dashboard'),
    // Cards coming due per study day, today first (14 days).
    forecast: async (deckId?: string) => {
      const d = await get<Json>(`/api/stats?days=1${deckId ? `&deck=${enc(deckId)}` : ''}`)
      return list<{ day: string; due: number }>(d, 'forecast')
    },
    // Reviews per study day, the last `days` (every deck).
    activity: async (days = 7) => list<{ day: string; reviews: number }>(await get<Json>(`/api/stats?days=${days}`), 'days'),
    // Today's new-card allowance of a deck, up by `n` for today only.
    extraNew: async (deckId: string, n = 5) => normalizeDeck(unwrap<Json>(await post<Json>(`/api/decks/${enc(deckId)}/extra-new`, { n }), 'deck')),
    // A practice run: cards that don't change the schedule when rated.
    practice: async (q: { deck: string } | { fact: string }, limit = 20) =>
      list<QueueItem>(await get<unknown>('deck' in q ? `/api/practice?deck=${enc(q.deck)}&limit=${limit}` : `/api/practice?fact=${enc(q.fact)}`), 'items').map(normalizeItem),
    // A written sentence graded by Claude (online only).
    grade: (exerciseId: string, text: string) => post<WriteGrade>(`/api/exercises/${enc(exerciseId)}/grade`, { text }),
    handbook: (deckId: string) => get<Handbook>(`/api/handbook?deck=${enc(deckId)}`),
    startVocabTest: () => post<VocabTestStart>('/api/vocab-test'),
    answerVocabTest: (id: string, answers: { id: string; known: boolean }[]) => post<TestResult>(`/api/vocab-test/${enc(id)}/answers`, { answers }),
    vocabTests: async () => list<TestSummary>(await get<unknown>('/api/vocab-tests'), 'tests'),
  }
}

export type Api = ReturnType<typeof createApi>

const enc = encodeURIComponent

// The server may return a bare array or wrap it as { [key]: [...] }.
function list<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const v = (data as Json)[key] ?? (data as Json).items
    if (Array.isArray(v)) return v as T[]
  }
  return []
}

function unwrap<T>(data: Json, key: string): T {
  return (data && typeof data === 'object' && key in data ? data[key] : data) as T
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const counts3 = (v: unknown) => {
  const c = (v ?? {}) as Json
  return { new: num(c.new), learning: num(c.learning), review: num(c.review) }
}

// Items from servers (and caches) that predate facts carry no kind: words.
export function normalizeItem(it: QueueItem): QueueItem {
  return it.kind ? it : ({ ...(it as object), kind: 'word' } as QueueItem)
}

function normalizeQueue(d: Json): QueueResponse {
  return {
    items: list<QueueItem>(d, 'items').map(normalizeItem),
    counts: counts3(d.counts),
    decks: (Array.isArray(d.decks) ? (d.decks as Json[]) : []).map((x) => ({
      id: String(x.id),
      name: String(x.name ?? ''),
      hasLanguages: x.hasLanguages === true || x.kind === 'language',
      counts: counts3(x.counts),
    }) satisfies QueueDeck),
  }
}

const TYPE_ANSWER: readonly TypeAnswer[] = ['off', 'reverse', 'both']

// Older servers send no typeAnswer (= off) and may nest or flatten counts.
function normalizeDeck(d: Json): DeckWithCounts {
  const c = (d.counts ?? d) as Json
  const typeAnswer = TYPE_ANSWER.includes(d.typeAnswer as TypeAnswer) ? (d.typeAnswer as TypeAnswer) : 'off'
  return {
    ...(d as unknown as DeckWithCounts),
    reviewFilter: d.reviewFilter && typeof d.reviewFilter === 'object' ? (d.reviewFilter as ReviewFilter) : null,
    tags: Array.isArray(d.tags) ? (d.tags as { tag: string; n: number }[]) : [],
    targetLang: typeof d.targetLang === 'string' ? d.targetLang : null,
    nativeLang: typeof d.nativeLang === 'string' ? d.nativeLang : null,
    forwardEnabled: d.forwardEnabled !== false,
    reverseEnabled: d.reverseEnabled !== false,
    reverseAfterDays: typeof d.reverseAfterDays === 'number' ? d.reverseAfterDays : null,
    typeAnswer,
    extraNewToday: num(d.extraNewToday),
    counts: {
      total: num(c.total),
      active: num(c.active),
      dropped: num(c.dropped),
      known: num(c.known),
      learning: num(c.learning),
      due: num(c.due),
      new: num(c.new),
      newTotal: num(c.newTotal),
    },
  }
}
