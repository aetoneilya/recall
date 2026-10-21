// "Log in with Telegram" for the PWA / browser, where there is no Mini App
// initData: the web app asks for a nonce, the user opens
// t.me/<bot>?start=login_<nonce>, the bot asks "Log in to Mnemosyne on the
// web?" and a press of ✅ confirms the nonce for the sender; the web app's
// poll then exchanges it (once) for a session cookie.
import { randomBytes } from 'node:crypto'
import { sha256 } from './auth.ts'
import type { Db } from './db.ts'

export const NONCE_TTL_MS = 5 * 60_000
// Unconfirmed nonces alive at once, across all clients: a cheap cap on abuse.
const MAX_PENDING = 500
export const START_PREFIX = 'login_'

export interface NewNonce {
  nonce: string
  expiresAt: string
}

interface Row {
  nonce_hash: string
  user_id: string | null
  expires_at: string
  confirmed_at: string | null
  used_at: string | null
}

function cleanup(db: Db, now: Date) {
  db.prepare('DELETE FROM login_nonces WHERE expires_at <= ?').run(now.toISOString())
}

// null when too many are pending.
export function createLoginNonce(db: Db, now: Date): NewNonce | null {
  cleanup(db, now)
  const pending = (db.prepare('SELECT count(*) AS n FROM login_nonces WHERE confirmed_at IS NULL').get() as { n: number }).n
  if (pending >= MAX_PENDING) return null
  // 128 bits, base64url: 22 chars, fits Telegram's 64-char [A-Za-z0-9_-] start parameter.
  const nonce = randomBytes(16).toString('base64url')
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS).toISOString()
  db.prepare('INSERT INTO login_nonces(nonce_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(nonce), now.toISOString(), expiresAt)
  return { nonce, expiresAt }
}

// The bot's confirm / cancel buttons carry this instead of the nonce: the
// nonce hash, base64url (43 chars, fits the 64-byte callback_data). It is the
// row's key, so no extra state, and it can't be turned back into the nonce
// the web app polls with.
const REF_RE = /^[A-Za-z0-9_-]{43}$/
const refOf = (hash: string) => Buffer.from(hash, 'hex').toString('base64url')
const hashOf = (ref: string) => (REF_RE.test(ref) ? Buffer.from(ref, 'base64url').toString('hex') : null)

export type OpenResult = { ref: string } | { error: 'expired' | 'taken' }

// Step 1, /start login_<nonce> from an allowed sender: binds the live nonce to
// the first account that opens it and returns the ref for the buttons.
// Nothing is confirmed yet.
export function openLoginNonce(db: Db, nonce: string, userId: string, now: Date): OpenResult {
  const row = liveRow(db, sha256(nonce), now)
  if (!row) return { error: 'expired' }
  if (row.user_id && row.user_id !== userId) return { error: 'taken' }
  db.prepare('UPDATE login_nonces SET user_id = ? WHERE nonce_hash = ? AND user_id IS NULL').run(userId, row.nonce_hash)
  return { ref: refOf(row.nonce_hash) }
}

export type ConfirmResult = 'confirmed' | 'cancelled' | 'expired' | 'taken'

// Step 2, a button press: checked again at press time — still live, and
// pressed by the account that opened it. Confirming twice is harmless;
// cancelling drops the nonce, so the web app's next poll gets 410.
export function answerLoginRef(db: Db, ref: string, userId: string, action: 'confirm' | 'cancel', now: Date): ConfirmResult {
  const hash = hashOf(ref)
  const row = hash ? liveRow(db, hash, now) : null
  if (!row) return 'expired'
  if (row.user_id !== userId) return 'taken'
  if (action === 'cancel') {
    db.prepare('DELETE FROM login_nonces WHERE nonce_hash = ?').run(row.nonce_hash)
    return 'cancelled'
  }
  db.prepare('UPDATE login_nonces SET confirmed_at = ? WHERE nonce_hash = ? AND confirmed_at IS NULL').run(now.toISOString(), row.nonce_hash)
  return 'confirmed'
}

function liveRow(db: Db, hash: string, now: Date): Row | null {
  const row = db.prepare('SELECT * FROM login_nonces WHERE nonce_hash = ?').get(hash) as Row | undefined
  return row && row.expires_at > now.toISOString() && !row.used_at ? row : null
}

export type PollResult = { status: 'pending'; expiresAt: string } | { status: 'confirmed'; userId: string } | { status: 'gone' }

// A confirmed nonce is handed out once; unknown, used, cancelled and expired
// ones are all 'gone'. Opened but unconfirmed is still pending.
export function pollLoginNonce(db: Db, nonce: string, now: Date): PollResult {
  const hash = sha256(nonce)
  const row = liveRow(db, hash, now)
  if (!row) return { status: 'gone' }
  if (!row.confirmed_at || !row.user_id) return { status: 'pending', expiresAt: row.expires_at }
  const r = db.prepare('UPDATE login_nonces SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL').run(now.toISOString(), hash)
  return r.changes ? { status: 'confirmed', userId: row.user_id } : { status: 'gone' }
}
