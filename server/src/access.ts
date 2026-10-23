// Access by request: a stranger asks from the bot, the owner allows or
// denies; allowed accounts live in allowed_users (next to OWNER_TELEGRAM_ID
// and ALLOW_USER_IDS, users.accessOf). One request per account at a time; a
// deny holds off new requests for a week. No Telegram calls here: the bot
// (bot-access.ts) does the talking.
import type { Config } from './config.ts'
import { tx, type Db } from './db.ts'
import { accessOf, getUserByTelegramId } from './users.ts'

export const DENY_COOLDOWN_MS = 7 * 86400_000

export interface Requester {
  telegramId: number
  name: string
  username: string | null
}

export interface AccessRequest extends Requester {
  status: 'pending' | 'denied'
  requestedAt: string
  decidedAt: string | null
}

interface RequestRow {
  telegram_id: number
  name: string
  username: string | null
  status: 'pending' | 'denied'
  requested_at: string
  decided_at: string | null
}

const toRequest = (r: RequestRow): AccessRequest => ({
  telegramId: Number(r.telegram_id), name: r.name, username: r.username, status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at,
})

export function getRequest(db: Db, telegramId: number): AccessRequest | null {
  const r = db.prepare('SELECT * FROM access_requests WHERE telegram_id = ?').get(telegramId) as RequestRow | undefined
  return r ? toRequest(r) : null
}

// What a request from this account does now: reach the owner, or not (one
// is already waiting, or a deny is less than a week old).
export type RequestState = 'new' | 'pending' | 'cooldown'

export function requestState(req: AccessRequest | null, now: Date): RequestState {
  if (!req) return 'new'
  if (req.status === 'pending') return 'pending'
  return now.getTime() - Date.parse(req.decidedAt ?? req.requestedAt) < DENY_COOLDOWN_MS ? 'cooldown' : 'new'
}

// Records a request unless one is pending or in its cooldown; 'new' means
// the owner should be asked.
export function openRequest(db: Db, who: Requester, now: Date): RequestState {
  return tx(db, () => {
    const state = requestState(getRequest(db, who.telegramId), now)
    if (state !== 'new') return state
    db.prepare(`INSERT INTO access_requests(telegram_id, name, username, status, requested_at, decided_at) VALUES (?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name, username = excluded.username, status = 'pending', requested_at = excluded.requested_at, decided_at = NULL`)
      .run(who.telegramId, who.name, who.username, now.toISOString())
    return 'new'
  })
}

// The owner couldn't be reached: the request is forgotten so it can be sent again.
export function dropRequest(db: Db, telegramId: number) {
  db.prepare('DELETE FROM access_requests WHERE telegram_id = ?').run(telegramId)
}

// Allow / deny a pending request; returns it as it was. null when nothing is
// pending (already answered, or never asked), so a second press changes nothing.
export function decideRequest(db: Db, telegramId: number, allow: boolean, now: Date): AccessRequest | null {
  return tx(db, () => {
    const req = getRequest(db, telegramId)
    if (req?.status !== 'pending') return null
    if (allow) {
      allowAccount(db, req, now)
      dropRequest(db, telegramId)
    } else {
      db.prepare("UPDATE access_requests SET status = 'denied', decided_at = ? WHERE telegram_id = ?").run(now.toISOString(), telegramId)
    }
    return req
  })
}

export function allowAccount(db: Db, who: Requester, now: Date) {
  db.prepare(`INSERT INTO allowed_users(telegram_id, name, username, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name, username = excluded.username`).run(who.telegramId, who.name, who.username, now.toISOString())
}

// Takes an account off the bot's allowlist. Once it isn't allowed any other
// way its sessions and tokens go too, so letting it in again later doesn't
// bring an old credential back. False when it wasn't on the list.
export function revokeAccount(db: Db, cfg: Pick<Config, 'dev' | 'ownerTelegramId' | 'allowUserIds'>, telegramId: number): boolean {
  return tx(db, () => {
    const gone = Number(db.prepare('DELETE FROM allowed_users WHERE telegram_id = ?').run(telegramId).changes) > 0
    const user = getUserByTelegramId(db, telegramId)
    if (gone && user && !accessOf(db, cfg, telegramId)) {
      for (const t of ['sessions', 'api_tokens', 'oauth_tokens']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id)
    }
    return gone
  })
}

export interface AllowedAccount {
  telegramId: number
  name: string
  username: string | null
  // config: ALLOW_USER_IDS (changed in the config, not from the bot).
  via: 'config' | 'bot'
}

// Everyone let in besides the owner: ALLOW_USER_IDS first (named from their
// user row once they signed in), then the bot's allowlist by when they came.
export function listAllowed(db: Db, cfg: Pick<Config, 'ownerTelegramId' | 'allowUserIds'>): AllowedAccount[] {
  const fromConfig = [...new Set(cfg.allowUserIds)].filter((id) => id !== cfg.ownerTelegramId).map((id): AllowedAccount => {
    const u = getUserByTelegramId(db, id)
    return { telegramId: id, name: u?.name ?? '', username: null, via: 'config' }
  })
  const rows = db.prepare('SELECT * FROM allowed_users ORDER BY added_at, telegram_id').all() as { telegram_id: number; name: string; username: string | null }[]
  const fromBot = rows
    .map((r) => ({ telegramId: Number(r.telegram_id), name: r.name, username: r.username, via: 'bot' as const }))
    .filter((a) => a.telegramId !== cfg.ownerTelegramId && !cfg.allowUserIds.includes(a.telegramId))
  return [...fromConfig, ...fromBot]
}
