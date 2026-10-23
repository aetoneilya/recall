// Edits made in the word and fact editors while offline. Each card's
// latest changes wait here (persisted), merged into one patch, until they
// can be sent; a patch is idempotent, so resending is harmless.
import { AuthError, HttpError, NetworkError } from './api.ts'

export type EditKind = 'word' | 'fact'

export interface PendingEdit {
  kind: EditKind
  id: string
  patch: Record<string, unknown>
}

export interface EditOutboxStore {
  load(): Promise<PendingEdit[] | undefined>
  save(edits: PendingEdit[]): Promise<void>
}

export interface EditOutboxTransport {
  updateWord(id: string, patch: never): Promise<unknown>
  updateFact(id: string, patch: never): Promise<unknown>
}

export interface EditFlush {
  sent: number
  // Refused by the server (e.g. now a duplicate, or the card is gone); dropped.
  failed: { edit: PendingEdit; error: string }[]
}

export class EditOutbox {
  private edits: PendingEdit[] = []
  private saving: Promise<void> = Promise.resolve()
  private inflight: Promise<EditFlush> | null = null
  private store: EditOutboxStore
  private transport: EditOutboxTransport

  constructor(store: EditOutboxStore, transport: EditOutboxTransport) {
    this.store = store
    this.transport = transport
  }

  async init(): Promise<void> {
    const saved = (await this.store.load()) ?? []
    for (const e of saved) this.merge(e)
    this.changed()
  }

  get size(): number {
    return this.edits.length
  }

  // The changes still to send for this card, to show over the server's copy.
  get(kind: EditKind, id: string): Record<string, unknown> | undefined {
    return this.edits.find((e) => e.kind === kind && e.id === id)?.patch
  }

  add(kind: EditKind, id: string, patch: Record<string, unknown>): void {
    this.merge({ kind, id, patch })
    this.changed()
  }

  // Saved online: what that save sent supersedes the same fields waiting
  // here, so a later flush can't put an older offline value back.
  supersede(kind: EditKind, id: string, sent: object): void {
    const cur = this.edits.find((x) => x.kind === kind && x.id === id)
    if (!cur) return
    for (const k of Object.keys(sent)) delete cur.patch[k]
    if (!Object.keys(cur.patch).length) this.edits = this.edits.filter((x) => x !== cur)
    this.changed()
  }

  private merge(e: PendingEdit) {
    const cur = this.edits.find((x) => x.kind === e.kind && x.id === e.id)
    if (cur) cur.patch = { ...cur.patch, ...e.patch }
    else this.edits.push({ kind: e.kind, id: e.id, patch: { ...e.patch } })
  }

  // Resolves once everything queued so far is persisted.
  persisted(): Promise<void> {
    return this.saving
  }

  flush(): Promise<EditFlush> {
    this.inflight ??= this.run().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async run(): Promise<EditFlush> {
    const out: EditFlush = { sent: 0, failed: [] }
    while (this.edits.length) {
      const e = this.edits[0]!
      const sending = { ...e.patch }
      try {
        if (e.kind === 'word') await this.transport.updateWord(e.id, sending as never)
        else await this.transport.updateFact(e.id, sending as never)
        out.sent++
      } catch (err) {
        if (err instanceof NetworkError || err instanceof AuthError) return out
        if (!(err instanceof HttpError) || err.status >= 500 || err.status === 408 || err.status === 429) return out
        out.failed.push({ edit: e, error: err.message })
      }
      // Changed again while it was sending: the rest stays queued.
      const newer = Object.keys(e.patch).filter((k) => e.patch[k] !== sending[k])
      if (newer.length) e.patch = Object.fromEntries(newer.map((k) => [k, e.patch[k]]))
      else this.edits = this.edits.filter((x) => x !== e)
      this.changed()
    }
    return out
  }

  private changed() {
    const snapshot = this.edits.map((e) => ({ ...e, patch: { ...e.patch } }))
    this.saving = this.saving.then(() => this.store.save(snapshot)).catch(() => {})
  }
}
