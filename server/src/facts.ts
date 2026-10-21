// Facts: Q&A cards of topic decks (front = question, back = answer, both
// Markdown), one card each. Same ownership rule as words: every function
// takes the acting user's id, and someone else's id behaves as unknown.
import {
  cleanFact, factKey, FACT_STATUSES, newCardState,
  type Author, type CardState, type CleanFact, type Fact, type FactInput, type FactStatus,
} from '@recall/core'
import { newId, tx, type Db } from './db.ts'
import { cardSummary, getDeck, HttpError, listDecks, mustBeKind, resolveDeck, stateValues, toCard, type CardRow, type CardSummary } from './repo.ts'

// A fact with the same normalised question already exists in the deck.
export class DuplicateFactError extends HttpError {
  existing: Fact
  constructor(existing: Fact) {
    super(409, `"${existing.front}" is already in this deck`, { existing })
    this.existing = existing
  }
}

export interface FactRow {
  id: string
  user_id: string
  deck_id: string
  front: string
  back: string
  tags: string
  status: string
  created_by: string
  dedupe_key: string
  import_ref: string | null
  created_at: string
  updated_at: string
}

export function toFact(r: FactRow): Fact {
  return {
    id: r.id,
    deckId: r.deck_id,
    front: r.front,
    back: r.back,
    tags: JSON.parse(r.tags) as string[],
    status: r.status as FactStatus,
    createdBy: r.created_by as Author,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface FactItem extends Fact {
  deckName: string
  card: CardSummary | null
}

export function getFact(db: Db, userId: string, id: string): Fact | null {
  const r = db.prepare('SELECT * FROM facts WHERE id = ? AND user_id = ?').get(id, userId) as FactRow | undefined
  return r ? toFact(r) : null
}

export function mustGetFact(db: Db, userId: string, id: string): Fact {
  const f = getFact(db, userId, id)
  if (!f) throw new HttpError(404, `fact ${id} not found`)
  return f
}

export function findDuplicateFact(db: Db, userId: string, deckId: string, front: string): Fact | null {
  const r = db.prepare('SELECT * FROM facts WHERE user_id = ? AND deck_id = ? AND dedupe_key = ?').get(userId, deckId, factKey(front)) as FactRow | undefined
  return r ? toFact(r) : null
}

export function cleanFactInput(input: FactInput): CleanFact {
  const r = cleanFact(input)
  if ('error' in r) throw new HttpError(400, r.error)
  return r.fact
}

export function insertFactCard(db: Db, factId: string, s: CardState, suspended = false, id = newId('cd')): string {
  db.prepare(
    `INSERT INTO cards(id, fact_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days,
       learning_steps, reps, lapses, state, last_review) VALUES (?, ?, 'forward', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, factId, suspended ? 1 : 0, ...stateValues(s))
  return id
}

export interface NewFact {
  deckId: string
  fact: FactInput
  status: FactStatus
  createdBy: Author
  importRef?: string | null
  createdAt?: Date
  // The card's state; default new. Imports bring their own.
  card?: { state: CardState; suspended?: boolean }
}

// Validates, dedupes (DuplicateFactError → 409 with the existing fact) and
// inserts the fact with its card. Returns the fact and the card's id.
export function createFact(db: Db, userId: string, input: NewFact, now: Date): { fact: Fact; cardId: string } {
  return tx(db, () => {
    const deck = getDeck(db, userId, input.deckId)
    if (!deck) throw new HttpError(404, 'deck not found')
    mustBeKind(deck, 'topic')
    const f = cleanFactInput(input.fact)
    const dup = findDuplicateFact(db, userId, deck.id, f.front)
    if (dup) throw new DuplicateFactError(dup)
    if (!FACT_STATUSES.includes(input.status)) throw new HttpError(400, `unknown status ${input.status}`)
    const at = (input.createdAt ?? now).toISOString()
    const id = newId('ft')
    db.prepare(`INSERT INTO facts(id, user_id, deck_id, front, back, tags, status, created_by, dedupe_key, import_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, userId, deck.id, f.front, f.back, JSON.stringify(f.tags), input.status, input.createdBy, factKey(f.front), input.importRef ?? null, at, at,
    )
    const cardId = insertFactCard(db, id, input.card?.state ?? newCardState(new Date(at)), input.card?.suspended ?? false)
    return { fact: getFact(db, userId, id)!, cardId }
  })
}

export type FactPatch = Partial<FactInput> & { status?: FactStatus }

// Only the fields given change; the card and its history always stay.
export function updateFact(db: Db, userId: string, id: string, patch: FactPatch, now: Date): Fact {
  return tx(db, () => {
    const cur = mustGetFact(db, userId, id)
    const f = cleanFactInput({
      front: patch.front ?? cur.front,
      back: patch.back ?? cur.back,
      tags: patch.tags ?? cur.tags,
    })
    const status = patch.status ?? cur.status
    if (!FACT_STATUSES.includes(status)) throw new HttpError(400, `unknown status ${status}`)
    const dup = findDuplicateFact(db, userId, cur.deckId, f.front)
    if (dup && dup.id !== id) throw new DuplicateFactError(dup)
    db.prepare('UPDATE facts SET front = ?, back = ?, tags = ?, status = ?, dedupe_key = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(f.front, f.back, JSON.stringify(f.tags), status, factKey(f.front), now.toISOString(), id, userId)
    return getFact(db, userId, id)!
  })
}

export function deleteFact(db: Db, userId: string, id: string) {
  const r = db.prepare('DELETE FROM facts WHERE id = ? AND user_id = ?').run(id, userId)
  if (r.changes === 0) throw new HttpError(404, `fact ${id} not found`)
}

export function factCard(db: Db, userId: string, factId: string) {
  const r = db.prepare('SELECT c.* FROM cards c JOIN facts f ON f.id = c.fact_id WHERE c.fact_id = ? AND f.user_id = ?').get(factId, userId) as CardRow | undefined
  return r ? toCard(r) : null
}

export function factItems(db: Db, userId: string, rows: FactRow[], now: Date): FactItem[] {
  if (!rows.length) return []
  const decks = new Map(listDecks(db, userId).map((d) => [d.id, d]))
  const cards = new Map<string, CardRow>()
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => r.id)
    for (const c of db.prepare(`SELECT * FROM cards WHERE fact_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as CardRow[]) cards.set(c.fact_id!, c)
  }
  return rows.map((r) => {
    const deck = decks.get(r.deck_id)!
    const c = cards.get(r.id)
    return { ...toFact(r), deckName: deck.name, card: c ? cardSummary(toCard(c), deck, now) : null }
  })
}

export function factItem(db: Db, userId: string, id: string, now: Date): FactItem {
  const r = db.prepare('SELECT * FROM facts WHERE id = ? AND user_id = ?').get(id, userId) as FactRow | undefined
  if (!r) throw new HttpError(404, `fact ${id} not found`)
  return factItems(db, userId, [r], now)[0]!
}

export interface FactSearch {
  deck?: string
  q?: string
  status?: FactStatus
  limit?: number
  offset?: number
}

// Oldest first (the order they were written or imported in).
export function searchFacts(db: Db, userId: string, s: FactSearch, now: Date): { facts: FactItem[]; total: number } {
  const where: string[] = ['f.user_id = ?']
  const args: (string | number)[] = [userId]
  if (s.deck) {
    const deck = resolveDeck(db, userId, s.deck)
    if (!deck) return { facts: [], total: 0 }
    where.push('f.deck_id = ?')
    args.push(deck.id)
  }
  if (s.status) {
    where.push('f.status = ?')
    args.push(s.status)
  }
  if (s.q?.trim()) {
    const like = `%${s.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const cols = ['f.front', 'f.back', 'f.tags']
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    args.push(...cols.map(() => like))
  }
  const clause = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(s.limit ?? 50, 1), 500)
  const offset = Math.max(s.offset ?? 0, 0)
  const total = (db.prepare(`SELECT count(*) AS n FROM facts f ${clause}`).get(...args) as { n: number }).n
  const rows = db.prepare(`SELECT f.* FROM facts f ${clause} ORDER BY f.created_at, f.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as FactRow[]
  return { facts: factItems(db, userId, rows, now), total }
}
