// Pending bot state behind inline buttons. Telegram's callback_data is at
// most 64 bytes, so a button carries only an opaque draft id; the draft holds
// the rest (the word it acts on, the other meanings, a selection). Drafts
// belong to one user and live 7 days; anyone else's or an expired id reads as
// missing.
import { newId, type Db } from './db.ts'

export const DRAFT_TTL_MS = 7 * 86400_000

export type DraftKind = 'word' | 'duplicate' | 'batch' | 'pick'

export interface Draft<T> {
  id: string
  kind: DraftKind
  payload: T
}

export function createDraft<T>(db: Db, userId: string, kind: DraftKind, payload: T, now: Date): Draft<T> {
  db.prepare('DELETE FROM bot_drafts WHERE expires_at <= ?').run(now.toISOString())
  const id = newId('bd')
  db.prepare('INSERT INTO bot_drafts(id, user_id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, userId, kind, JSON.stringify(payload), now.toISOString(), new Date(now.getTime() + DRAFT_TTL_MS).toISOString())
  return { id, kind, payload }
}

// The user's live draft of that kind, or null.
export function getDraft<T>(db: Db, userId: string, id: string, kind: DraftKind, now: Date): Draft<T> | null {
  const r = db.prepare('SELECT payload FROM bot_drafts WHERE id = ? AND user_id = ? AND kind = ? AND expires_at > ?')
    .get(id, userId, kind, now.toISOString()) as { payload: string } | undefined
  return r ? { id, kind, payload: JSON.parse(r.payload) as T } : null
}

export function saveDraft<T>(db: Db, userId: string, id: string, payload: T) {
  db.prepare('UPDATE bot_drafts SET payload = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(payload), id, userId)
}

export function deleteDraft(db: Db, userId: string, id: string) {
  db.prepare('DELETE FROM bot_drafts WHERE id = ? AND user_id = ?').run(id, userId)
}
