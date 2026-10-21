// Ratings waiting to be uploaded. Every op carries the client UUID of its
// review, so resending after a failure (or after the app was killed mid-
// request) is harmless: the server skips ids it has already applied.
import type { Card, ReviewInput } from '@recall/core'
import { AuthError, HttpError, NetworkError } from './api.ts'
import type { ReviewsResult } from './types.ts'

export type OutboxOp = { kind: 'review'; input: ReviewInput } | { kind: 'undo'; id: string }

export interface OutboxStore {
  load(): Promise<OutboxOp[] | undefined>
  save(ops: OutboxOp[]): Promise<void>
}

export interface OutboxTransport {
  postReviews(inputs: ReviewInput[]): Promise<ReviewsResult>
  undoReview(id: string): Promise<unknown>
}

export type FlushResult =
  | { ok: true; sent: number }
  | { ok: false; reason: 'offline' | 'auth' | 'server'; sent: number }

export const BATCH = 50

export class Outbox {
  private ops: OutboxOp[] = []
  private saving: Promise<void> = Promise.resolve()
  private inflight: Promise<FlushResult> | null = null
  private listeners = new Set<(pending: number) => void>()
  onCards: (cards: Card[]) => void = () => {}
  // A bad request would block the queue forever; such ops are dropped and
  // reported here instead.
  onDropped: (ops: OutboxOp[], error: HttpError) => void = () => {}

  private store: OutboxStore
  private transport: OutboxTransport

  constructor(store: OutboxStore, transport: OutboxTransport) {
    this.store = store
    this.transport = transport
  }

  async init(): Promise<void> {
    const saved = (await this.store.load()) ?? []
    // Ops added before init finished stay after the saved ones.
    this.ops = [...saved, ...this.ops.filter((o) => !saved.some((s) => key(s) === key(o)))]
    this.changed()
  }

  get pending(): number {
    return this.ops.filter((o) => o.kind === 'review').length
  }

  get size(): number {
    return this.ops.length
  }

  subscribe(fn: (pending: number) => void): () => void {
    this.listeners.add(fn)
    fn(this.pending)
    return () => this.listeners.delete(fn)
  }

  add(input: ReviewInput): void {
    this.ops.push({ kind: 'review', input })
    this.changed()
  }

  // Takes back a review. If it hasn't left the device it simply disappears;
  // otherwise an undo is queued behind whatever is still pending.
  undo(id: string): 'local' | 'queued' {
    const i = this.ops.findIndex((o) => o.kind === 'review' && o.input.id === id)
    if (i >= 0 && !this.isSending(id)) {
      this.ops.splice(i, 1)
      this.changed()
      return 'local'
    }
    this.ops.push({ kind: 'undo', id })
    this.changed()
    return 'queued'
  }

  // Single-flight: concurrent callers share one upload.
  flush(): Promise<FlushResult> {
    if (!this.inflight) {
      this.inflight = this.run().finally(() => {
        this.inflight = null
        this.sending.clear()
      })
    }
    return this.inflight
  }

  // Resolves once everything queued so far is persisted.
  persisted(): Promise<void> {
    return this.saving
  }

  private sending = new Set<string>()
  private isSending(id: string) {
    return this.sending.has(id)
  }

  private async run(): Promise<FlushResult> {
    let sent = 0
    while (this.ops.length) {
      const head = this.ops[0]
      try {
        if (head.kind === 'undo') {
          this.sending.add(`undo:${head.id}`)
          try {
            await this.transport.undoReview(head.id)
          } catch (e) {
            // Already gone on the server: nothing left to undo.
            if (!(e instanceof HttpError && e.status === 404)) throw e
          }
          this.remove([head])
          sent++
          continue
        }
        const batch: OutboxOp[] = []
        for (const o of this.ops) {
          if (o.kind !== 'review' || batch.length >= BATCH) break
          batch.push(o)
        }
        for (const o of batch) if (o.kind === 'review') this.sending.add(o.input.id)
        const res = await this.transport.postReviews(batch.map((o) => (o as { input: ReviewInput }).input))
        this.remove(batch)
        sent += batch.length
        if (res?.cards?.length) this.onCards(res.cards)
      } catch (e) {
        this.sending.clear()
        if (e instanceof NetworkError) return { ok: false, reason: 'offline', sent }
        if (e instanceof AuthError) return { ok: false, reason: 'auth', sent }
        if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          const dropped = head.kind === 'undo' ? [head] : this.ops.slice(0, this.reviewRun())
          this.remove(dropped)
          this.onDropped(dropped, e)
          continue
        }
        return { ok: false, reason: 'server', sent }
      }
    }
    return { ok: true, sent }
  }

  private reviewRun(): number {
    let n = 0
    while (n < this.ops.length && n < BATCH && this.ops[n].kind === 'review') n++
    return n
  }

  private remove(done: OutboxOp[]) {
    const keys = new Set(done.map(key))
    this.ops = this.ops.filter((o) => !keys.has(key(o)))
    this.changed()
  }

  private changed() {
    const snapshot = this.ops.slice()
    this.saving = this.saving.then(() => this.store.save(snapshot)).catch(() => {})
    for (const fn of this.listeners) fn(this.pending)
  }
}

function key(o: OutboxOp): string {
  return o.kind === 'review' ? `r:${o.input.id}` : `u:${o.id}`
}
