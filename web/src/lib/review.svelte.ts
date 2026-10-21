// The review session: cached queue, current card, ratings applied locally
// and queued for upload, undo.
import { dayKey, type Card, type CardState, type QueueItem, type Rating, type Word } from '@recall/core'
import { api, flushNow, kv, outbox, scheduleFlush, status } from './app.svelte.ts'
import { AuthError, NetworkError } from './api.ts'
import { getDecks } from './decks.ts'
import { fsrs } from './fsrs.ts'
import { applyRating, buildQueue, dropWord, emptyQueue, LEARN_AHEAD_MS, nextItem, patchWord, waiting, type QueueState } from './queue.ts'
import type { DeckSettings, DeckWithCounts, WordItem } from './types.ts'
import { haptic } from './telegram.ts'
import { uuid } from './uuid.ts'

interface SessionStats {
  reviewed: number
  again: number
  // Ratings of cards that were in the review state — the basis for retention.
  matured: number
  maturedAgain: number
  ms: number
}

interface Cache {
  day: string
  // Today's queue as the server sent it; ratings made here live in `local`.
  items: QueueItem[]
  decks?: Record<string, DeckSettings>
  buried: Record<string, string>
  local: Record<string, CardState>
  stats: SessionStats
  fetchedAt: number
}

interface UndoEntry {
  id: string
  queue: QueueState
  current: QueueItem
  local: CardState | undefined
  stats: SessionStats
}

const MAX_DURATION_MS = 120_000
// Inputs are ignored this long after a reveal or rating: a double tap on
// "Show answer" must not land on the rating button that appears under it.
const LOCK_MS = 280
const STALE_MS = 60_000

const zeroStats = (): SessionStats => ({ reviewed: 0, again: 0, matured: 0, maturedAgain: 0, ms: 0 })

class ReviewSession {
  queue = $state.raw<QueueState>(emptyQueue())
  current = $state.raw<QueueItem | null>(null)
  revealed = $state(false)
  loaded = $state(false)
  refreshing = $state(false)
  error = $state<string | null>(null)
  stats = $state<SessionStats>(zeroStats())
  history = $state.raw<UndoEntry[]>([])
  // Deck settings by id: which directions are studied, typed answers.
  decks = $state.raw<Record<string, DeckSettings>>({})
  // Changes on a timer so "next card in 4 min" stays current.
  now = $state(Date.now())

  private day = ''
  private items: QueueItem[] = []
  private local: Record<string, CardState> = {}
  private fetchedAt = 0
  private shownAt = 0
  private lockUntil = 0
  private wake: ReturnType<typeof setTimeout> | undefined
  private started = false

  async start() {
    if (this.started) return
    this.started = true
    const cache = await kv.get<Cache>('review')
    if (cache) {
      this.day = cache.day
      this.local = cache.local ?? {}
      this.stats = cache.stats ?? zeroStats()
      this.fetchedAt = cache.fetchedAt ?? 0
      this.decks = cache.decks ?? {}
      this.items = cache.items ?? []
      this.rollDay()
      this.queue = this.build(cache.buried ?? {})
      this.pick()
    } else this.day = dayKey(new Date(), status.day)
    this.loaded = !!cache
    outbox.onCards = (cards) => this.adopt(cards)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.now = Date.now()
        if (Date.now() - this.fetchedAt > STALE_MS) void this.refresh()
        else if (!this.current) this.pick()
      }
    })
    await this.refresh()
  }

  // Uploads pending ratings, then fetches today's queue from the server.
  async refresh(): Promise<void> {
    // Asked again mid-flight (e.g. a setting changed): one more round after
    // this one, so the change isn't missed.
    if (this.refreshing) {
      this.again = true
      return
    }
    this.refreshing = true
    try {
      await flushNow()
      const [res, decks] = await Promise.all([api.queue(200), getDecks(true).catch(() => null)])
      status.inbox = res.inbox
      this.fetchedAt = Date.now()
      if (decks) this.decks = Object.fromEntries(decks.map((d) => [d.id, d]))
      this.items = res.items
      this.rollDay()
      this.rebuild()
      this.error = null
      this.loaded = true
      this.persist()
    } catch (e) {
      if (e instanceof NetworkError) this.error = this.loaded ? null : 'offline'
      else if (!(e instanceof AuthError)) this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.refreshing = false
    }
    if (this.again) {
      this.again = false
      return this.refresh()
    }
  }
  private again = false

  // Re-applies the queue rules to today's items, e.g. after a deck setting
  // changed; the card on screen stays if it's still in the queue.
  private rebuild(force = false) {
    const next = this.build(this.queue.buried)
    this.queue = next
    const cur = this.current
    const fresh = cur && [...next.learning, ...next.main].find((x) => x.card.id === cur.card.id)
    if (fresh) this.current = fresh
    else if (!cur || !this.revealed || force) this.pick()
    this.persist()
  }

  private build(buried: Record<string, string>): QueueState {
    return buildQueue(this.items, buried, this.local, new Date(), status.day, (it) => this.studied(it))
  }

  // Whether the card's direction is on in its deck (unknown decks: yes).
  private studied(it: QueueItem): boolean {
    const d = this.decks[it.word.deckId]
    return !d || (it.card.direction === 'forward' ? d.forwardEnabled : d.reverseEnabled)
  }

  deckOf(it: QueueItem): DeckSettings | undefined {
    return this.decks[it.word.deckId]
  }

  // A deck's settings changed here (optimistically): hide or bring back a
  // direction at once, without waiting for the server.
  applyDeck(d: DeckSettings) {
    this.decks = { ...this.decks, [d.id]: d }
    this.rebuild(true)
  }

  // A word was saved elsewhere (the editor opened from the card): the card on
  // screen shows the fix at once and stays where it was, revealed or not.
  // Suspending or deactivating it takes it out of today's queue.
  patchWord(w: WordItem) {
    const { cards, deckName: _, ...word } = w
    const suspended = new Set([cards.forward, cards.reverse].filter((c) => c?.suspended).map((c) => c!.id))
    this.replaceItems((list) => patchWord(list, word as Word, suspended))
  }

  // A word deleted elsewhere: none of its cards stay queued.
  dropWord(id: string) {
    this.replaceItems((list) => dropWord(list, id))
  }

  private replaceItems(fix: (list: QueueItem[]) => QueueItem[]) {
    this.items = fix(this.items)
    this.queue = { ...this.queue, main: fix(this.queue.main), learning: fix(this.queue.learning) }
    const cur = this.current
    if (cur) {
      const fresh = [...this.queue.learning, ...this.queue.main].find((x) => x.card.id === cur.card.id)
      if (fresh) this.current = fresh
      else this.pick()
    }
    this.persist()
  }

  // Reviews due tomorrow (server forecast, after this device's ratings are
  // uploaded); the last answer is reused offline the same day. null: unknown.
  private forecast: { day: string; at: number; n: number } | null = null
  async tomorrow(): Promise<number | null> {
    const day = dayKey(new Date(), status.day)
    const f = this.forecast
    if (f && f.day === day && Date.now() - f.at < 5 * 60_000) return f.n
    try {
      await flushNow()
      const days = await api.forecast()
      const n = days[1]?.due
      if (typeof n !== 'number') return null
      this.forecast = { day, at: Date.now(), n }
      return n
    } catch {
      return f && f.day === day ? f.n : null
    }
  }

  // Words in the collection, from the cached deck counts; null until known.
  get wordCount(): number | null {
    const ds = Object.values(this.decks) as Partial<DeckWithCounts>[]
    if (!ds.length || ds.some((d) => !d.counts)) return null
    return ds.reduce((n, d) => n + (d.counts?.total ?? 0), 0)
  }

  // Something changed server-side (e.g. words approved); refetch on next visit.
  markStale() {
    this.fetchedAt = 0
  }

  refreshIfStale() {
    if (this.started && Date.now() - this.fetchedAt > STALE_MS / 2) return this.refresh()
  }

  reveal() {
    if (!this.current || this.revealed || this.locked()) return
    this.revealed = true
    this.lock()
  }

  rate(rating: Rating): boolean {
    const item = this.current
    if (!item || !this.revealed || this.locked()) return false
    const now = new Date()
    this.rollDay()
    const before = { queue: this.queue, current: item, local: this.local[item.card.id], stats: { ...this.stats } }
    const { queue, after } = applyRating(this.queue, item, rating, now, status.day, fsrs())
    const input = {
      id: uuid(),
      cardId: item.card.id,
      rating,
      reviewedAt: now.toISOString(),
      durationMs: Math.min(MAX_DURATION_MS, Math.max(0, now.getTime() - this.shownAt)),
    }
    outbox.add(input)
    this.history = [...this.history.slice(-49), { id: input.id, ...before }]
    this.local = { ...this.local, [item.card.id]: after }
    const matured = item.card.schedule.state === 2
    this.stats = {
      reviewed: this.stats.reviewed + 1,
      again: this.stats.again + (rating === 1 ? 1 : 0),
      matured: this.stats.matured + (matured ? 1 : 0),
      maturedAgain: this.stats.maturedAgain + (matured && rating === 1 ? 1 : 0),
      ms: this.stats.ms + input.durationMs,
    }
    this.queue = queue
    haptic.impact(rating === 1 ? 'medium' : 'light')
    this.pick()
    this.lock()
    if (!this.current) haptic.notify('success')
    this.persist()
    if (outbox.pending >= 5 || !this.current) void flushNow()
    else scheduleFlush()
    return true
  }

  undo(): boolean {
    const last = this.history.at(-1)
    if (!last) return false
    this.history = this.history.slice(0, -1)
    outbox.undo(last.id)
    this.queue = last.queue
    this.current = last.current
    const local = { ...this.local }
    if (last.local) local[last.current.card.id] = last.local
    else delete local[last.current.card.id]
    this.local = local
    this.stats = last.stats
    // Back on the answer side: undo is usually a mis-tap, so the right
    // rating should be one tap away.
    this.revealed = true
    this.shownAt = Date.now()
    this.lock()
    this.persist()
    scheduleFlush()
    return true
  }

  get canUndo() {
    return this.history.length > 0
  }

  waiting() {
    return waiting(this.queue, new Date(this.now))
  }

  private pick() {
    clearTimeout(this.wake)
    const now = new Date()
    this.now = now.getTime()
    this.current = nextItem(this.queue, now)
    this.revealed = false
    this.shownAt = now.getTime()
    if (!this.current) {
      // Wake up when the next learning card becomes showable.
      const w = waiting(this.queue, now)
      if (w.next) this.wake = setTimeout(() => this.pick(), Math.max(1000, w.next.getTime() - LEARN_AHEAD_MS - now.getTime() + 500))
    }
  }

  // A new study day: yesterday's burying and stats no longer apply.
  private rollDay() {
    const today = dayKey(new Date(), status.day)
    if (today === this.day) return
    this.day = today
    this.local = {}
    this.stats = zeroStats()
    this.history = []
    this.queue = { ...this.queue, buried: {} }
  }

  // The server's view after an upload; normally identical (same scheduler,
  // same deterministic fuzz), but a review from another device would differ.
  private adopt(cards: Card[]) {
    const byId = new Map(cards.map((c) => [c.id, c]))
    const fix = (list: QueueItem[]) =>
      list.map((it) => {
        const c = byId.get(it.card.id)
        return c ? { ...it, card: { ...it.card, schedule: c.schedule } } : it
      })
    for (const c of cards) if (this.local[c.id]) this.local[c.id] = c.schedule
    this.items = fix(this.items)
    this.queue = { ...this.queue, main: fix(this.queue.main), learning: fix(this.queue.learning) }
  }

  private locked() {
    return Date.now() < this.lockUntil
  }

  private lock() {
    this.lockUntil = Date.now() + LOCK_MS
  }

  private persistQueued = false
  private persist() {
    if (this.persistQueued) return
    this.persistQueued = true
    queueMicrotask(() => {
      this.persistQueued = false
      const cache: Cache = {
        day: this.day,
        items: this.items,
        decks: this.decks,
        buried: this.queue.buried,
        local: this.local,
        stats: $state.snapshot(this.stats),
        fetchedAt: this.fetchedAt,
      }
      void kv.set('review', cache)
    })
  }
}

export const session = new ReviewSession()
