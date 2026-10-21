import type { ExerciseInput, QueueItem, ReviewInput } from '@recall/core'
import type {
  ApiToken,
  AutofillResult,
  Dashboard,
  DeckPatch,
  DeckWithCounts,
  ExerciseInfo,
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

    queue: async (limit = 200) => normalizeQueue(await get<Json>(`/api/queue?limit=${limit}`)),
    // keepalive lets the upload survive the page being hidden mid-request,
    // which is exactly when the outbox flushes on iOS.
    postReviews: (inputs: ReviewInput[]) => post<ReviewsResult>('/api/reviews', inputs, { keepalive: true }),
    undoReview: (id: string) => post<unknown>('/api/reviews/undo', { id }),

    decks: async () => list<Json>(await get<unknown>('/api/decks'), 'decks').map(normalizeDeck),
    patchDeck: async (id: string, d: DeckPatch) => normalizeDeck(unwrap<Json>(await request<Json>('PATCH', `/api/decks/${enc(id)}`, d), 'deck')),
    createTopicDeck: async (name: string) => normalizeDeck(unwrap<Json>(await post<Json>('/api/decks', { kind: 'topic', name }), 'deck')),
    // A topic deck; one with facts only with withFacts (they're deleted too), else HttpError 409 with data.facts.
    deleteDeck: (id: string, withFacts = false) => request<{ ok: true; facts: number }>('DELETE', `/api/decks/${enc(id)}${withFacts ? '?facts=delete' : ''}`),

    facts: async (q: { deck?: string; q?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') qs.set(k, String(v))
      const data = await get<Json>(`/api/facts?${qs}`)
      const facts = list<FactItem>(data, 'facts')
      return { facts, total: typeof data.total === 'number' ? data.total : facts.length }
    },

    packs: async () => list<PackInfo>(await get<unknown>('/api/packs'), 'packs'),
    // Adds the pack's missing cards; the updated list comes back.
    addPack: (id: string) => post<{ added: number; alreadyAdded: number; duplicates: number; packs: PackInfo[] }>(`/api/packs/${enc(id)}`),

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
    approveFact: async (id: string) => unwrap<FactItem>(await post<Json>(`/api/facts/${enc(id)}/approve`), 'fact'),
    rejectFact: async (id: string) => unwrap<FactItem>(await post<Json>(`/api/facts/${enc(id)}/reject`), 'fact'),
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
    approve: async (id: string) => unwrap<WordItem>(await post<Json>(`/api/words/${enc(id)}/approve`), 'word'),
    reject: async (id: string) => unwrap<WordItem>(await post<Json>(`/api/words/${enc(id)}/reject`), 'word'),
    suspendCard: (cardId: string, on: boolean) => post<unknown>(`/api/cards/${enc(cardId)}/${on ? 'suspend' : 'unsuspend'}`),

    // Proposals of both kinds; older servers send words only.
    inbox: async () => {
      const d = await get<unknown>('/api/inbox')
      const facts = d && typeof d === 'object' && Array.isArray((d as Json).facts) ? ((d as Json).facts as FactItem[]) : []
      return { words: list<WordItem>(d, 'words'), facts }
    },
    approveAll: (deckId?: string) => post<{ approved: number }>('/api/inbox/approve-all', deckId ? { deckId } : {}),

    dashboard: () => get<Dashboard>('/api/dashboard'),
    // Cards coming due per study day, today first (14 days).
    forecast: async () => {
      const d = await get<Json>('/api/stats?days=1')
      return list<{ day: string; due: number }>(d, 'forecast')
    },
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
    inbox: num(d.inbox),
    decks: (Array.isArray(d.decks) ? (d.decks as Json[]) : []).map((x) => ({
      id: String(x.id),
      name: String(x.name ?? ''),
      kind: x.kind === 'topic' ? 'topic' : 'language',
      inReview: x.inReview !== false,
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
    kind: d.kind === 'topic' ? 'topic' : 'language',
    inReview: d.inReview !== false,
    targetLang: typeof d.targetLang === 'string' ? d.targetLang : null,
    nativeLang: typeof d.nativeLang === 'string' ? d.nativeLang : null,
    forwardEnabled: d.forwardEnabled !== false,
    reverseEnabled: d.reverseEnabled !== false,
    reverseAfterDays: typeof d.reverseAfterDays === 'number' ? d.reverseAfterDays : null,
    typeAnswer,
    counts: {
      total: num(c.total),
      active: num(c.active),
      inbox: num(c.inbox),
      known: num(c.known),
      learning: num(c.learning),
      due: num(c.due),
      new: num(c.new),
      newTotal: num(c.newTotal),
    },
  }
}
