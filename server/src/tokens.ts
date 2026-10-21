// Personal API tokens: long-lived bearers a user mints for Claude Code or a
// script. Only the SHA-256 is stored; the plaintext is shown once.
import { randomBytes } from 'node:crypto'
import { sha256 } from './auth.ts'
import { newId, type Db } from './db.ts'
import { HttpError } from './repo.ts'

export const TOKEN_PREFIX = 'mn_'
const MAX_TOKENS = 50

export interface ApiTokenInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

interface Row {
  id: string
  user_id: string
  name: string
  created_at: string
  last_used_at: string | null
}

const toInfo = (r: Row): ApiTokenInfo => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })

export function listApiTokens(db: Db, userId: string): ApiTokenInfo[] {
  return (db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at, id').all(userId) as unknown as Row[]).map(toInfo)
}

export function createApiToken(db: Db, userId: string, name: string, now: Date): { token: ApiTokenInfo; secret: string } {
  const clean = name.trim()
  if (!clean || clean.length > 100) throw new HttpError(400, 'token name must be 1..100 characters')
  const n = (db.prepare('SELECT count(*) AS n FROM api_tokens WHERE user_id = ?').get(userId) as { n: number }).n
  if (n >= MAX_TOKENS) throw new HttpError(409, `at most ${MAX_TOKENS} tokens; revoke an old one first`)
  const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const id = newId('tk')
  db.prepare('INSERT INTO api_tokens(id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, sha256(secret), clean, now.toISOString())
  return { token: { id, name: clean, createdAt: now.toISOString(), lastUsedAt: null }, secret }
}

export function deleteApiToken(db: Db, userId: string, id: string) {
  const r = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId)
  if (r.changes === 0) throw new HttpError(404, 'token not found')
}

// The owning user id of a live token. last_used_at is refreshed at most once a minute.
export function apiTokenUserId(db: Db, secret: string, now: Date): string | null {
  if (!secret.startsWith(TOKEN_PREFIX)) return null
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(sha256(secret)) as Row | undefined
  if (!row) return null
  const at = now.toISOString()
  const stale = new Date(now.getTime() - 60_000).toISOString()
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)').run(at, row.id, stale)
  return row.user_id
}
