import type { ReviewInput } from '@recall/core'
import type {
  ApiToken,
  AutofillResult,
  Dashboard,
  DeckPatch,
  DeckWithCounts,
  FsrsOptimizeResult,
  LoginPoll,
  LoginStart,
  Me,
  MePatch,
  NewToken,
  NewWord,
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

    inbox: async () => list<WordItem>(await get<unknown>('/api/inbox'), 'words'),
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

function normalizeQueue(d: Json): QueueResponse {
  const c = (d.counts ?? {}) as Json
  return {
    items: list(d, 'items'),
    counts: { new: num(c.new), learning: num(c.learning), review: num(c.review) },
    inbox: num(d.inbox),
  }
}

const TYPE_ANSWER: readonly TypeAnswer[] = ['off', 'reverse', 'both']

// Older servers send no typeAnswer (= off) and may nest or flatten counts.
function normalizeDeck(d: Json): DeckWithCounts {
  const c = (d.counts ?? d) as Json
  const typeAnswer = TYPE_ANSWER.includes(d.typeAnswer as TypeAnswer) ? (d.typeAnswer as TypeAnswer) : 'off'
  return {
    ...(d as unknown as DeckWithCounts),
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
