// The review session: cached queue, current card, ratings applied locally
// and queued for upload, undo.
import { dayKey, inReviewFilter, isLearningState, itemOf, type AnswerCheck, type Card, type CardState, type ExerciseAttempt, type ExerciseCheck, type Fact, type QueueItem, type Rating, type ReviewFilter, type Word, type WriteGrade } from '@recall/core'
import { api, flushNow, kv, outbox, scheduleFlush, status } from './app.svelte.ts'
import { AuthError, NetworkError, normalizeItem } from './api.ts'
import { getDecks } from './decks.ts'
import { fsrs } from './fsrs.ts'
import { applyRating, buildQueue, counts, dropWord, emptyQueue, itemFacts, keepExercises, nextItem, patchFact, patchWord, peekNext, RECENT_MAX, upcoming, withSchedules, type Counts, type QueueState, type Shown } from './queue.ts'
import type { DeckSettings, DeckWithCounts, FactItem, QueueDeck, WordItem } from './types.ts'
import { haptic } from './telegram.ts'
import { errorText, showToast } from './toast.svelte.ts'
import { uuid } from './uuid.ts'

interface SessionStats {
  reviewed: number
  again: number
  // Ratings of cards that were in the review state — the basis for retention.
  matured: number
  maturedAgain: number
  ms: number
  // New cards seen for the first time.
  fresh?: number
  // Ratings per deck id: the progress bar is the deck's, not the session's.
  perDeck?: Record<string, number>
}

// A card rated Again this session, for the summary's "you missed" list.
export interface Missed {
  cardId: string
  kind: 'word' | 'fact'
  id: string
  // Absent on entries cached by older versions.
  deckId?: string
  title: string
  sub: string
}

interface Cache {
  day: string
  // The deck under review and each deck's queue as the server sent it
  // (offline, a deck switch paints from here); ratings made on this device
  // live in `local`, for every deck.
  deckId?: string
  byDeck?: Record<string, { items: QueueItem[]; fetchedAt: number }>
  // Before decks were reviewed one at a time: one queue.
  items?: QueueItem[]
  decks?: Record<string, DeckSettings>
  // Every deck's counts as the server sent them with the queue.
  queueDecks?: QueueDeck[]
  buried: Record<string, string>
  local: Record<string, CardState>
  stats: SessionStats
  missed?: Missed[]
  fetchedAt?: number
}

// One deck in the switcher: what it has left today under its filter.
export interface DeckChoice {
  id: string
  name: string
  left: number
  counts: { new: number; learning: number; review: number }
}

const DECK_KEY = 'reviewDeck'
const readDeck = () => {
  try {
    return localStorage.getItem(DECK_KEY) ?? ''
  } catch {
    return ''
  }
}

// What a rating changed, to take back only that: the card's state, its
// burying and the session's tally — not the queue, which may have been
// refiltered since (a filter, a direction turned off).
interface UndoEntry {
  id: string
  current: QueueItem
  local: CardState | undefined
  // The word's (or fact's) entry in `buried` before the rating.
  buried: string | undefined
  stats: SessionStats
  missed: Missed[]
  recent: Shown[]
}

// A rule's exercises half answered, kept while the card is left (⋯ → Read
// the theory) so coming back to it resumes where it was.
export interface ExerciseProgress {
  ids: string[]
  index: number
  results: ExerciseAttempt[]
  tap: { pick: string | null; token: number | null; done: boolean }
  check: ExerciseCheck | null
  answer: string
  skipped: string[]
  grade: WriteGrade | null
}

const MAX_DURATION_MS = 120_000
// Inputs are ignored this long after a reveal or rating: a double tap on
// "Show answer" must not land on the rating button that appears under it.
const LOCK_MS = 280
const STALE_MS = 60_000

// A card in one line: the term, or the question's first line.
export function itemTitle(it: QueueItem): string {
  return it.kind === 'word' ? it.word.term : (it.fact.front.replace(/[`*_#>]/g, '').split('\n')[0] ?? '')
}

function missedOf(it: QueueItem): Missed {
  if (it.kind === 'word') return { cardId: it.card.id, kind: 'word', id: it.word.id, deckId: it.word.deckId, title: itemTitle(it), sub: it.word.translations[0] ?? '' }
  return { cardId: it.card.id, kind: 'fact', id: it.fact.id, deckId: it.fact.deckId, title: itemTitle(it), sub: '' }
}

class Superseded extends Error {}

const zeroStats = (): SessionStats => ({ reviewed: 0, again: 0, matured: 0, maturedAgain: 0, ms: 0, fresh: 0 })

class ReviewSession {
  queue = $state.raw<QueueState>(emptyQueue())
  current = $state.raw<QueueItem | null>(null)
  revealed = $state(false)
  loaded = $state(false)
  refreshing = $state(false)
  error = $state<string | null>(null)
  stats = $state<SessionStats>(zeroStats())
  missed = $state.raw<Missed[]>([])
  history = $state.raw<UndoEntry[]>([])
  // Deck settings by id: in review, which directions are studied, typed answers.
  decks = $state.raw<Record<string, DeckSettings>>({})
  // Every deck with the server's counts for today (the switcher).
  queueDecks = $state.raw<QueueDeck[]>([])
  // The deck under review ('' until the first answer names one); remembered.
  deckId = $state(readDeck())
  // Changes on a timer so "next card in 4 min" stays current.
  now = $state(Date.now())
  // The latest ratings, oldest first: the minimum gap before a card comes back.
  recent = $state.raw<Shown[]>([])

  private day = ''
  private items: QueueItem[] = []
  private byDeck: Record<string, { items: QueueItem[]; fetchedAt: number }> = {}
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
      this.missed = cache.missed ?? []
      this.decks = cache.decks ?? {}
      this.queueDecks = cache.queueDecks ?? []
      this.byDeck = cache.byDeck ?? {}
      if (!this.deckId) this.deckId = cache.deckId ?? this.queueDecks[0]?.id ?? ''
      const mine = this.byDeck[this.deckId]
      this.items = (mine?.items ?? (cache.items ?? []).filter((it) => !this.deckId || itemOf(normalizeItem(it)).deckId === this.deckId)).map(normalizeItem)
      this.fetchedAt = mine?.fetchedAt ?? 0
      // Yesterday's burying goes with the day.
      this.queue = { ...emptyQueue(), buried: cache.buried ?? {} }
      this.rollDay()
      this.queue = this.build(this.queue.buried)
      this.pick()
    } else this.day = dayKey(new Date(), status.day)
    this.loaded = !!cache
    outbox.onCards = (cards) => this.adopt(cards)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.now = Date.now()
        // Resumed on a new day: today's queue at once, offline too.
        this.turnDay()
        if (Date.now() - this.fetchedAt > STALE_MS) void this.refresh()
        else if (!this.current) this.pick()
      }
    })
    await this.refresh()
  }

  // Uploads pending ratings, then fetches today's queue from the server.
  // Asked again mid-flight (e.g. a setting changed): one more round after
  // this one, so the change isn't missed — and the caller waits for that
  // round too, not just for the one already on its way.
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true
      return this.inflight
    }
    this.inflight = this.rounds().finally(() => (this.inflight = null))
    return this.inflight
  }
  private inflight: Promise<void> | null = null

  private async rounds(): Promise<void> {
    do {
      this.again = false
      await this.round()
    } while (this.again)
  }

  private async round(): Promise<void> {
    this.refreshing = true
    const startedAt = Date.now()
    try {
      await flushNow()
      const asked = this.deckId
      const [res, decks] = await Promise.all([api.queue(200, asked || undefined), getDecks(true).catch(() => null)])
      // A deck changed here since this round began (a filter, a setting)
      // keeps the local copy: the server's answer may predate the change.
      if (decks) this.decks = Object.fromEntries(decks.map((d) => [d.id, (this.editedAt[d.id] ?? 0) >= startedAt && this.decks[d.id] ? this.decks[d.id]! : d]))
      this.queueDecks = res.decks
      // No deck chosen yet, or the chosen one is gone (deleted, merged): the first.
      if (!asked || (res.decks.length && !res.decks.some((d) => d.id === asked))) {
        this.choose(res.decks[0]?.id ?? '')
        if (asked) this.again = true
      }
      // Switched to another deck meanwhile: its own round follows.
      if (this.deckId !== asked && asked) throw new Superseded()
      this.rollDay()
      this.fetchedAt = Date.now()
      this.items = res.items.filter((it) => itemOf(it).deckId === this.deckId)
      this.byDeck = { ...this.byDeck, [this.deckId]: { items: this.items, fetchedAt: this.fetchedAt } }
      this.rebuild()
      this.error = null
      this.loaded = true
      this.persist()
      this.lastFailure = null
    } catch (e) {
      this.lastFailure = e instanceof Superseded ? null : e instanceof NetworkError ? 'offline' : e instanceof Error ? e.message : String(e)
      if (e instanceof Superseded) this.again = true
      else if (e instanceof NetworkError) this.error = this.loaded ? null : 'offline'
      else if (!(e instanceof AuthError)) this.error = e instanceof Error ? e.message : String(e)
    } finally {
      this.refreshing = false
    }
  }
  private again = false
  // Why the last round failed (offline included, which the screen doesn't show).
  private lastFailure: string | null = null
  // When each deck's settings last changed on this device.
  private editedAt: Record<string, number> = {}

  // Re-applies the queue rules to today's items, e.g. after a deck setting
  // changed; the card on screen stays if it's still in the queue.
  private rebuild(force = false) {
    const next = this.build(this.queue.buried)
    this.queue = next
    const cur = this.current
    const fresh = cur && [...next.learning, ...next.main].find((x) => x.card.id === cur.card.id)
    if (fresh) this.current = keepExercises(cur!, fresh)
    else if (!cur || !this.revealed || force) this.pick()
    this.persist()
  }

  private build(buried: Record<string, string>): QueueState {
    return buildQueue(this.items, buried, this.local, new Date(), status.day, (it) => this.studied(it))
  }

  // Whether the card is of the deck under review and, for a word, its direction is on.
  private studied(it: QueueItem): boolean {
    const id = itemOf(it).deckId
    if (this.deckId && id !== this.deckId) return false
    const d = this.decks[id]
    return !d || it.kind === 'fact' || (it.card.direction === 'forward' ? d.forwardEnabled : d.reverseEnabled)
  }

  private choose(id: string) {
    this.deckId = id
    try {
      localStorage.setItem(DECK_KEY, id)
    } catch {
      // No storage: the choice lasts for this visit.
    }
  }

  deckOf(it: QueueItem): DeckSettings | undefined {
    return this.decks[itemOf(it).deckId]
  }

  // Cards rated today in the deck under review.
  get doneHere(): number {
    return this.stats.perDeck?.[this.deckId] ?? 0
  }

  // The deck switcher: every deck the server listed, in its order. The deck
  // under review counts down as cards are rated here; the others show the
  // server's numbers.
  get choices(): DeckChoice[] {
    const sum = (c: Counts) => c.new + c.learning + c.review
    return this.queueDecks.map((d) => {
      const c = d.id === this.deckId ? counts(this.queue) : d.counts
      return { id: d.id, name: d.name, left: sum(c), counts: { new: c.new, learning: c.learning, review: c.review } }
    })
  }

  // Another deck: its cached queue at once (offline too), then the server's.
  // Undo doesn't reach across decks.
  selectDeck(id: string) {
    if (id === this.deckId) return
    // This deck's items as they are now (drops, edits), for coming back offline.
    if (this.deckId) this.byDeck = { ...this.byDeck, [this.deckId]: { items: this.items, fetchedAt: this.fetchedAt } }
    this.choose(id)
    const cached = this.byDeck[id]
    this.items = cached?.items ?? []
    this.fetchedAt = cached?.fetchedAt ?? 0
    this.history = []
    this.queue = this.build(this.queue.buried)
    this.pick()
    this.persist()
    haptic.select()
    void this.refresh()
  }

  // The selected deck's review filter (null = everything).
  get filter(): ReviewFilter | null {
    return this.decks[this.deckId]?.reviewFilter ?? null
  }

  // Saves the deck's filter and refetches its queue; refused (or offline) → a note.
  async setFilter(f: ReviewFilter | null): Promise<boolean> {
    const id = this.deckId
    const d = this.decks[id]
    try {
      const saved = await api.patchDeck(id, { reviewFilter: f })
      this.editedAt[id] = Date.now()
      this.decks = { ...this.decks, [id]: { ...(this.decks[id] ?? d ?? saved), reviewFilter: saved.reviewFilter } }
      void getDecks(true).catch(() => null)
      await this.refresh()
      return true
    } catch (e) {
      showToast(e instanceof NetworkError ? 'Offline — the filter changes when connected' : `Not saved: ${errorText(e)}`)
      return false
    }
  }

  // A deck's settings changed here (optimistically): hide or bring back a
  // direction at once, without waiting for the server.
  applyDeck(d: DeckSettings) {
    this.editedAt[d.id] = Date.now()
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

  // A fact of today's queue, for an editor to paint before its fetch lands.
  fact(id: string): (Fact & { deckName: string }) | null {
    for (const it of this.items) if (it.kind === 'fact' && it.fact.id === id) return { ...it.fact, deckName: it.deckName }
    return null
  }

  // The same for a fact.
  patchFact(f: FactItem) {
    const { card, deckName: _, ...fact } = f
    this.replaceItems((list) => patchFact(list, fact, !!card?.suspended))
  }

  // A word (or fact) deleted elsewhere: none of its cards stay queued.
  dropWord(id: string) {
    this.replaceItems((list) => dropWord(list, id))
  }

  private replaceItems(fix: (list: QueueItem[]) => QueueItem[]) {
    this.items = fix(this.items)
    // Every deck's cached queue too: switching back offline mustn't bring it back.
    this.byDeck = Object.fromEntries(Object.entries(this.byDeck).map(([id, d]) => [id, { ...d, items: fix(d.items) }]))
    this.queue = { ...this.queue, main: fix(this.queue.main), learning: fix(this.queue.learning) }
    const cur = this.current
    if (cur) {
      const fresh = [...this.queue.learning, ...this.queue.main].find((x) => x.card.id === cur.card.id)
      if (fresh) this.current = keepExercises(cur, fresh)
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
      const days = await api.forecast(this.deckId || undefined)
      const n = days[1]?.due
      if (typeof n !== 'number') return null
      this.forecast = { day, at: Date.now(), n }
      return n
    } catch {
      return f && f.day === day ? f.n : null
    }
  }

  // "+5 new": today's allowance of the deck under review goes up (on the
  // server, for this study day), then the queue brings the extra cards.
  async moreNew(n = 5): Promise<boolean> {
    const id = this.deckId
    if (!id) return false
    try {
      const d = await api.extraNew(id, n)
      this.editedAt[id] = Date.now()
      this.decks = { ...this.decks, [id]: { ...(this.decks[id] ?? d), extraNewToday: d.extraNewToday } }
      // The queue has to come after the allowance grew: a refresh already
      // on its way asked before it, so this waits for one more round.
      await this.refresh()
      if (this.lastFailure) showToast(`Couldn't load the new cards: ${this.lastFailure}`)
      else if (!this.current) showToast('No new cards left to add here')
      return !this.lastFailure
    } catch (e) {
      showToast(e instanceof NetworkError ? 'Offline — more new cards need a connection' : errorText(e))
      return false
    }
  }

  // Reviews per study day this week (every deck), for the summary's dots.
  async week(): Promise<boolean[] | null> {
    try {
      const days = await api.activity(7)
      return days.slice(-7).map((d) => d.reviews > 0)
    } catch {
      return null
    }
  }

  // Words in the collection, from the cached deck counts; null until known.
  get wordCount(): number | null {
    const ds = Object.values(this.decks) as Partial<DeckWithCounts>[]
    if (!ds.length || ds.some((d) => !d.counts)) return null
    return ds.reduce((n, d) => n + (d.counts?.total ?? 0), 0)
  }

  // Something changed server-side (e.g. a card dropped); refetch on next visit.
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

  // An exercise review's items, by card, for showing them again after an undo.
  exerciseResults: Record<string, ExerciseAttempt[]> = {}
  // The same for a typed answer and its verdict.
  typedAnswers: Record<string, { answer: string; check: AnswerCheck }> = {}
  // Exercises half answered, by card (see ExerciseProgress); gone with the rating.
  exerciseProgress: Record<string, ExerciseProgress> = {}

  rate(rating: Rating, extra: { exercises?: ExerciseAttempt[] } = {}): boolean {
    const item = this.current
    if (!item || !this.revealed || this.locked()) return false
    // Plain data: a $state proxy can't be stored (structured clone).
    const exercises = extra.exercises?.length ? ($state.snapshot(extra.exercises) as ExerciseAttempt[]) : undefined
    const now = new Date()
    // Rated on a new day: today's burying first, so this rating lands in it.
    if (this.rollDay()) this.queue = this.build(this.queue.buried)
    delete this.exerciseProgress[item.card.id]
    const before = { current: item, local: this.local[item.card.id], buried: this.queue.buried[itemOf(item).id], stats: $state.snapshot(this.stats), missed: this.missed, recent: this.recent }
    const { queue, after } = applyRating(this.queue, item, rating, now, status.day, fsrs())
    const input = {
      id: uuid(),
      cardId: item.card.id,
      rating,
      reviewedAt: now.toISOString(),
      durationMs: Math.min(MAX_DURATION_MS, Math.max(0, now.getTime() - this.shownAt)),
      ...(exercises ? { exercises } : {}),
    }
    if (exercises) this.exerciseResults[item.card.id] = exercises
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
      fresh: (this.stats.fresh ?? 0) + (item.card.schedule.state === 0 ? 1 : 0),
      perDeck: { ...this.stats.perDeck, [itemOf(item).deckId]: (this.stats.perDeck?.[itemOf(item).deckId] ?? 0) + 1 },
    }
    if (rating === 1 && !this.missed.some((m) => m.cardId === item.card.id)) this.missed = [...this.missed, missedOf(item)]
    this.queue = queue
    this.recent = [...this.recent, { cardId: item.card.id, at: now.getTime() }].slice(-RECENT_MAX)
    // Light and frequent; Again distinct without feeling like an error.
    haptic.impact(rating === 1 ? 'rigid' : 'light')
    this.pick()
    this.lock()
    if (!this.current && !this.upcoming()) haptic.notify('success')
    this.persist()
    if (outbox.pending >= 5 || !this.current) void flushNow()
    else scheduleFlush()
    return true
  }

  undo(): boolean {
    const last = this.history.at(-1)
    if (!last) return false
    this.history = this.history.slice(0, -1)
    haptic.impact('soft')
    outbox.undo(last.id)
    const cur = last.current
    const local = { ...this.local }
    if (last.local) local[cur.card.id] = last.local
    else delete local[cur.card.id]
    this.local = local
    // The cached copy may already hold the server's state after the rating;
    // the undo takes the server back to the state before it too.
    this.items = withSchedules(this.items, { [cur.card.id]: cur.card.schedule })
    const buried = { ...this.queue.buried }
    const itemId = itemOf(cur).id
    if (last.buried) buried[itemId] = last.buried
    else delete buried[itemId]
    // Today's queue under today's settings, with the card back on top —
    // unless what changed since (a filter, a direction) leaves it out.
    const q = this.build(buried)
    const back = this.studied(cur) && inReviewFilter(this.filter, itemFacts(cur))
    this.queue = back ? putFirst(q, cur) : q
    this.current = back ? cur : null
    this.stats = last.stats
    this.missed = last.missed
    this.recent = last.recent ?? []
    if (!this.current) {
      this.pick()
      this.persist()
      scheduleFlush()
      return true
    }
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

  // Nothing to show now: the card that comes next today and when.
  upcoming() {
    return this.current ? null : upcoming(this.queue, new Date(this.now), this.recent)
  }

  // The card under the current one: what a rating would bring next.
  get peek(): QueueItem | null {
    return this.current ? peekNext(this.queue, this.current, new Date(this.now), this.recent) : null
  }

  // Keeps "next card in N min" current while the waiting screen is open.
  tick() {
    this.now = Date.now()
    this.turnDay()
  }

  // The study day turned while the app stayed open (or was resumed): the
  // queue is rebuilt without yesterday's burying, online or not.
  private turnDay() {
    if (this.started && this.rollDay()) this.rebuild()
  }

  // The waiting screen's "Show now": the next card early, this once; after
  // its rating the usual rules apply again.
  showNow() {
    const u = this.upcoming()
    if (!u) return
    clearTimeout(this.wake)
    this.current = u.item
    this.revealed = false
    this.shownAt = Date.now()
    this.freshExercises()
  }

  private pick() {
    clearTimeout(this.wake)
    const now = new Date()
    this.now = now.getTime()
    this.current = nextItem(this.queue, now, this.recent)
    this.revealed = false
    this.shownAt = now.getTime()
    this.freshExercises()
    if (!this.current) {
      // Wake up when the next card becomes showable: on the waiting screen
      // it comes by itself.
      const u = upcoming(this.queue, now, this.recent)
      if (u) this.wake = setTimeout(() => this.pick(), Math.max(1000, u.at.getTime() - now.getTime() + 500))
    }
  }

  // A rule back after Again (a learning step) would show the three items it
  // was just answered with; online, it gets a newly picked set — only if it
  // arrives before anything could have been answered.
  private freshExercises() {
    const cur = this.current
    if (!cur || cur.kind !== 'fact' || !cur.exercises?.length || !this.local[cur.card.id] || !status.online) return
    const asked = Date.now()
    void api.practice({ fact: cur.fact.id }).then((items) => {
      const ex = items[0]?.kind === 'fact' ? items[0].exercises : undefined
      if (!ex?.length || this.current !== cur || this.revealed || Date.now() - asked > 400) return
      this.current = { ...cur, exercises: ex }
    }, () => {})
  }

  // A new study day: yesterday's burying and stats no longer apply. Ratings
  // made here since the last fetch stay applied: they move into the cached
  // queues (offline, nothing newer will come). Those not uploaded yet stay
  // in `local` as well: a queue fetched meanwhile doesn't have them. True
  // when the day changed.
  private rollDay(): boolean {
    const today = dayKey(new Date(), status.day)
    if (today === this.day) return false
    this.day = today
    const fold = (list: QueueItem[]) => withSchedules(list, this.local)
    this.items = fold(this.items)
    this.byDeck = Object.fromEntries(Object.entries(this.byDeck).map(([id, d]) => [id, { ...d, items: fold(d.items) }]))
    this.local = Object.fromEntries(Object.entries(this.local).filter(([id]) => outbox.pendingFor(id)))
    this.exerciseProgress = {}
    this.stats = zeroStats()
    this.missed = []
    this.history = []
    this.recent = []
    this.queue = { ...this.queue, buried: {} }
    return true
  }

  // The server's view after an upload; normally identical (same scheduler,
  // same deterministic fuzz), but a review from another device would differ.
  // A card rated (or a rating undone) here while the upload was in flight
  // keeps its local state: the next upload brings the server's.
  private adopt(cards: Card[]) {
    const schedules: Record<string, CardState> = {}
    for (const c of cards) if (!outbox.pendingFor(c.id)) schedules[c.id] = c.schedule
    for (const id of Object.keys(schedules)) if (this.local[id]) this.local[id] = schedules[id]!
    this.items = withSchedules(this.items, schedules)
    this.queue = { ...this.queue, main: withSchedules(this.queue.main, schedules), learning: withSchedules(this.queue.learning, schedules) }
    this.persist()
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
        deckId: this.deckId,
        byDeck: { ...this.byDeck, ...(this.deckId ? { [this.deckId]: { items: this.items, fetchedAt: this.fetchedAt } } : {}) },
        decks: this.decks,
        queueDecks: this.queueDecks,
        buried: this.queue.buried,
        local: this.local,
        stats: $state.snapshot(this.stats),
        missed: this.missed,
      }
      void kv.set('review', cache)
    })
  }
}

// The undone card on top of the queue (of its own list, so the counts stay
// right); its review or new sibling goes, as the rating's own burying would
// have it (a learning one stays).
export function putFirst(q: QueueState, cur: QueueItem): QueueState {
  const id = itemOf(cur).id
  const keep = (x: QueueItem) => x.card.id !== cur.card.id && (itemOf(x).id !== id || isLearningState(x.card.schedule.state))
  const main = q.main.filter(keep)
  const learning = q.learning.filter(keep)
  return isLearningState(cur.card.schedule.state) ? { ...q, main, learning: [cur, ...learning] } : { ...q, main: [cur, ...main], learning }
}

export const session = new ReviewSession()
