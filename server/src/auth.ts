import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { Config } from './config.ts'
import type { AppContext } from './context.ts'
import type { Db } from './db.ts'
import { apiTokenUserId, TOKEN_PREFIX } from './tokens.ts'
import { allowedUser, ensureUser, isAllowed, ownerUser, type User } from './users.ts'

// session: cookie from the password, the bot login or the OAuth page.
// bearer: MCP_TOKEN, a personal token or an OAuth access token.
export type AuthVia = 'session' | 'telegram' | 'bearer' | 'dev'

export const SESSION_COOKIE = 'recall_session'
const SESSION_DAYS = 90

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

// Hashing first makes the comparison length-independent.
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

// ---------- sessions ----------

export function checkPassword(cfg: Config, password: unknown): boolean {
  return typeof password === 'string' && !!cfg.ownerPassword && safeEqual(password, cfg.ownerPassword)
}

export function createSession(db: Db, userId: string, now: Date): { token: string; expires: Date } {
  const token = randomToken()
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString())
  db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now.toISOString(), expires.toISOString())
  return { token, expires }
}

// The user id behind a live session cookie.
export function sessionUserId(db: Db, token: string | undefined, now: Date): string | null {
  if (!token) return null
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sha256(token)) as { user_id: string; expires_at: string } | undefined
  return row && row.expires_at > now.toISOString() ? row.user_id : null
}

// The allowed user behind the request's session cookie.
export function sessionUser(ctx: AppContext, req: Request): User | null {
  return allowedUser(ctx.db, ctx.cfg, sessionUserId(ctx.db, readCookie(req.headers.cookie, SESSION_COOKIE), ctx.now()))
}

export function deleteSession(db: Db, token: string | undefined) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token))
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return undefined
}

export function sessionCookie(cfg: Config, token: string, expires: Date): string {
  const secure = cfg.appOrigin.startsWith('https:') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

// Attempts per client IP in a sliding window; small and in memory on purpose.
// Used for failed passwords and for bot-login nonces.
export class LoginLimiter {
  max: number
  windowMs: number
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max
    this.windowMs = windowMs
  }
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    return !!h && h.reset > now && h.n >= this.max
  }
  fail(key: string, now = Date.now()) {
    const h = this.hits.get(key)
    if (!h || h.reset <= now) this.hits.set(key, { n: 1, reset: now + this.windowMs })
    else h.n++
  }
  clear(key: string) {
    this.hits.delete(key)
  }
}

// ---------- Telegram Mini App ----------

export interface TelegramUser {
  id: number
  first_name?: string
  username?: string
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(initData: string, botToken: string, now: Date, maxAgeSec = 86400): TelegramUser | null {
  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null
  const pairs: string[] = []
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`)
  pairs.sort()
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', key).update(pairs.join('\n')).digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null
  const authDate = Number(params.get('auth_date'))
  if (!Number.isFinite(authDate) || now.getTime() / 1000 - authDate > maxAgeSec) return null
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as TelegramUser | null
    return user && typeof user.id === 'number' ? user : null
  } catch {
    return null
  }
}

// ---------- bearer ----------

export interface BearerAuth {
  user: User
  kind: 'static' | 'personal' | 'oauth'
  clientId: string
  scopes: string[]
  // Seconds since the epoch; the MCP SDK insists on one even for tokens that don't expire.
  expiresAt: number
  resource: string | null
}

const FAR = 365 * 86400

// MCP_TOKEN → the owner; mn_… → its user; otherwise an OAuth access token.
// Users dropped from the allowlist lose access with all their tokens.
export function verifyBearer(ctx: AppContext, token: string): BearerAuth | null {
  const { db, cfg } = ctx
  const now = ctx.now()
  const far = Math.floor(now.getTime() / 1000) + FAR
  if (cfg.mcpToken && safeEqual(token, cfg.mcpToken)) {
    const user = ownerUser(db, cfg, now)
    return user ? { user, kind: 'static', clientId: 'static', scopes: [], expiresAt: far, resource: null } : null
  }
  if (token.startsWith(TOKEN_PREFIX)) {
    const user = allowedUser(db, cfg, apiTokenUserId(db, token, now))
    return user ? { user, kind: 'personal', clientId: 'personal', scopes: [], expiresAt: far, resource: null } : null
  }
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(sha256(token)) as
    | { kind: string; user_id: string; client_id: string; scopes: string; resource: string | null; expires_at: string }
    | undefined
  if (!row || row.kind !== 'access' || row.expires_at <= now.toISOString()) return null
  const user = allowedUser(db, cfg, row.user_id)
  if (!user) return null
  return {
    user,
    kind: 'oauth',
    clientId: row.client_id,
    scopes: row.scopes ? row.scopes.split(' ') : [],
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    resource: row.resource,
  }
}

// ---------- middleware ----------

declare module 'express-serve-static-core' {
  interface Request {
    via?: AuthVia
    // The authenticated user; every data access is scoped to it.
    user?: User
  }
}

export type AuthResult = { user: User; via: AuthVia } | { user: null; strangerTelegramId?: number }

export function authenticate(req: Request, ctx: AppContext): AuthResult {
  const { db, cfg } = ctx
  const now = ctx.now()
  if (cfg.dev) return { user: ownerUser(db, cfg, now)!, via: 'dev' }
  // Inside the Mini App, Telegram says who this is; that beats any cookie.
  let stranger: number | undefined
  const initData = req.header('x-telegram-init-data')
  if (initData && cfg.botToken) {
    const tg = validateInitData(initData, cfg.botToken, now)
    if (tg && isAllowed(cfg, tg.id)) return { user: ensureUser(db, cfg, tg.id, now, tg.first_name), via: 'telegram' }
    if (tg) stranger = tg.id
  }
  const session = sessionUser(ctx, req)
  if (session) return { user: session, via: 'session' }
  const auth = req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const b = verifyBearer(ctx, auth.slice(7).trim())
    if (b) return { user: b.user, via: 'bearer' }
  }
  return stranger === undefined ? { user: null } : { user: null, strangerTelegramId: stranger }
}

// 401 unless the request resolves to an allowed user. A valid Telegram
// user who isn't allowed gets their id back, so they can ask to be added.
export function requireUser(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = authenticate(req, ctx)
    if (!r.user) {
      res.status(401).json(r.strangerTelegramId === undefined ? { error: 'unauthorized' } : { error: 'not allowed', telegramId: r.strangerTelegramId })
      return
    }
    req.user = r.user
    req.via = r.via
    next()
  }
}
