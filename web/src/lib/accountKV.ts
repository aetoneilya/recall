// Device caches per account: every key lives under the id of the account it
// belongs to, so a second account on the same phone or browser never paints
// (or uploads) the first one's cards. The owner is remembered; caches from
// before accounts were scoped go to the first account seen.
import type { KV } from './idb.ts'

// Everything the app caches for an account.
export const ACCOUNT_KEYS = ['outbox', 'wordOutbox', 'editOutbox', 'review', 'words', 'facts', 'dashboard', 'handbook', 'day', 'fsrs', 'me'] as const

const OWNER = 'owner'

export class AccountKV implements KV {
  // Whose caches are open; '' until an account has been seen on this device.
  owner = ''
  // The signed-in account is known to be the owner (uploads wait for this).
  confirmed = false
  private base: KV
  // A migration of unowned caches in progress: reads and writes wait for it,
  // so nothing lands under the old unprefixed keys or reads them half-moved.
  private ready: Promise<void> = Promise.resolve()
  // Keys cleared on sign-out: a late write (a persist still on its way) must
  // not bring them back before the reload.
  private closed = new Set<string>()

  constructor(base: KV) {
    this.base = base
  }

  async init(): Promise<void> {
    this.owner = (await this.base.get<string>(OWNER)) ?? ''
  }

  private key(k: string) {
    return this.owner ? `${this.owner}/${k}` : k
  }

  async get<T>(k: string) {
    await this.ready
    return this.base.get<T>(this.key(k))
  }
  async set(k: string, v: unknown) {
    await this.ready
    if (this.closed.has(k)) return
    return this.base.set(this.key(k), v)
  }
  async del(k: string) {
    await this.ready
    return this.base.del(this.key(k))
  }

  // The session ended (a 401): until the next sign-in is checked, nothing
  // uploads, since the next account may be another one.
  lost(): void {
    this.confirmed = false
  }

  // The signed-in account. 'same': its caches are open; 'claimed': the
  // unowned caches are now its; 'switched': another account's caches are
  // open — the app must start over (reload) under the new owner.
  async claim(id: string): Promise<'same' | 'claimed' | 'switched'> {
    await this.ready
    if (this.owner === id) {
      this.confirmed = true
      return 'same'
    }
    if (!this.owner) {
      this.ready = this.migrate(id)
      await this.ready
      this.confirmed = true
      return 'claimed'
    }
    await this.base.set(OWNER, id)
    return 'switched'
  }

  private async migrate(id: string): Promise<void> {
    for (const k of ACCOUNT_KEYS) {
      const v = await this.base.get(k)
      if (v === undefined) continue
      await this.base.set(`${id}/${k}`, v)
      await this.base.del(k)
    }
    this.owner = id
    await this.base.set(OWNER, id)
  }

  // Signing out: the account's caches go, except what still has to upload.
  async clear(keep: readonly string[] = []): Promise<void> {
    const gone = ACCOUNT_KEYS.filter((k) => !keep.includes(k))
    for (const k of gone) this.closed.add(k)
    for (const k of gone) await this.del(k)
  }
}
