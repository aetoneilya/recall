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

  constructor(base: KV) {
    this.base = base
  }

  async init(): Promise<void> {
    this.owner = (await this.base.get<string>(OWNER)) ?? ''
  }

  private key(k: string) {
    return this.owner ? `${this.owner}/${k}` : k
  }

  get<T>(k: string) {
    return this.base.get<T>(this.key(k))
  }
  set(k: string, v: unknown) {
    return this.base.set(this.key(k), v)
  }
  del(k: string) {
    return this.base.del(this.key(k))
  }

  // The signed-in account. 'same': its caches are open; 'claimed': the
  // unowned caches are now its; 'switched': another account's caches are
  // open — the app must start over (reload) under the new owner.
  async claim(id: string): Promise<'same' | 'claimed' | 'switched'> {
    if (this.owner === id) {
      this.confirmed = true
      return 'same'
    }
    if (!this.owner) {
      for (const k of ACCOUNT_KEYS) {
        const v = await this.base.get(k)
        if (v === undefined) continue
        await this.base.set(`${id}/${k}`, v)
        await this.base.del(k)
      }
      this.owner = id
      this.confirmed = true
      await this.base.set(OWNER, id)
      return 'claimed'
    }
    await this.base.set(OWNER, id)
    return 'switched'
  }

  // Signing out: the account's caches go, except what still has to upload.
  async clear(keep: readonly string[] = []): Promise<void> {
    for (const k of ACCOUNT_KEYS) if (!keep.includes(k)) await this.del(k)
  }
}
