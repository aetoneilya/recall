// Words added while offline. Each waits here (persisted) until it can be
// POSTed; a retry after an upload that did land comes back as a 409
// duplicate, which counts as done, so resending is harmless.
import { AuthError, HttpError, NetworkError } from './api.ts'
import type { NewWord } from './types.ts'

export interface PendingWord {
  id: string
  input: NewWord
  queuedAt: string
}

export interface WordOutboxStore {
  load(): Promise<PendingWord[] | undefined>
  save(words: PendingWord[]): Promise<void>
}

export interface WordOutboxTransport {
  createWord(w: NewWord): Promise<unknown>
}

export interface WordFlush {
  ok: boolean
  reason?: 'offline' | 'auth' | 'server'
  added: string[]
  // Already in the deck (from another device, or a retried upload).
  duplicates: string[]
  // Refused by the server (bad input); dropped.
  failed: { term: string; error: string }[]
}

export class WordOutbox {
  private words: PendingWord[] = []
  private saving: Promise<void> = Promise.resolve()
  private inflight: Promise<WordFlush> | null = null
  private listeners = new Set<(n: number) => void>()
  private store: WordOutboxStore
  private transport: WordOutboxTransport
  private seq = 0

  constructor(store: WordOutboxStore, transport: WordOutboxTransport) {
    this.store = store
    this.transport = transport
  }

  async init(): Promise<void> {
    const saved = (await this.store.load()) ?? []
    this.words = [...saved, ...this.words.filter((w) => !saved.some((s) => s.id === w.id))]
    this.changed()
  }

  get size(): number {
    return this.words.length
  }

  list(): PendingWord[] {
    return this.words.slice()
  }

  subscribe(fn: (n: number) => void): () => void {
    this.listeners.add(fn)
    fn(this.size)
    return () => this.listeners.delete(fn)
  }

  add(input: NewWord, now = new Date()): string {
    const id = `pw_${now.getTime().toString(36)}_${(++this.seq).toString(36)}`
    this.words.push({ id, input, queuedAt: now.toISOString() })
    this.changed()
    return id
  }

  // Takes back a word that hasn't been sent yet.
  remove(id: string): boolean {
    const before = this.words.length
    this.words = this.words.filter((w) => w.id !== id)
    if (this.words.length === before) return false
    this.changed()
    return true
  }

  persisted(): Promise<void> {
    return this.saving
  }

  flush(): Promise<WordFlush> {
    if (!this.inflight) this.inflight = this.run().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async run(): Promise<WordFlush> {
    const out: WordFlush = { ok: true, added: [], duplicates: [], failed: [] }
    while (this.words.length) {
      const w = this.words[0]
      try {
        await this.transport.createWord(w.input)
        out.added.push(w.input.term)
      } catch (e) {
        if (e instanceof NetworkError) return { ...out, ok: false, reason: 'offline' }
        if (e instanceof AuthError) return { ...out, ok: false, reason: 'auth' }
        if (e instanceof HttpError && e.status === 409) out.duplicates.push(w.input.term)
        else if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) out.failed.push({ term: w.input.term, error: e.message })
        else return { ...out, ok: false, reason: 'server' }
      }
      this.remove(w.id)
    }
    return out
  }

  private changed() {
    const snapshot = this.words.slice()
    this.saving = this.saving.then(() => this.store.save(snapshot)).catch(() => {})
    for (const fn of this.listeners) fn(this.size)
  }
}
