// Facts: Q&A cards (front = question, back = answer, both
// Markdown), one card each. Same ownership rule as words: every function
// takes the acting user's id, and someone else's id behaves as unknown.
import {
  CLAUDE_TAG, cleanFact, factKey, FACT_STATUSES, newCardState,
  type Author, type CardState, type CleanFact, type Fact, type FactInput, type FactStatus,
} from '@recall/core'
import { newId, tx, type Db } from './db.ts'
import { cardSummary, createDeck, getDeck, HttpError, listDecks, resolveDeck, stateValues, tagArgs, tagList, tagWhere, toCard, withClaudeTag, type CardRow, type CardSummary } from './repo.ts'

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
  // A rule with an exercise pool (exercises.ts); absent without one.
  exercises?: { active: number; flagged: number; needsReview: number }
  // From the grammar handbook pack (by import_ref): its topic's id, and
  // whether this is the topic's rule or one of its theory cards.
  handbook?: { topic: string; role: 'rule' | 'card' }
}

export const HANDBOOK_REF = 'pack:grammar-handbook:'

// pack:grammar-handbook:<topic> → the rule, …:<topic>:card:<n> → a theory
// card; anything else (exercise refs aren't facts) → null.
export function handbookRef(importRef: string | null): FactItem['handbook'] | null {
  if (!importRef?.startsWith(HANDBOOK_REF)) return null
  const parts = importRef.slice(HANDBOOK_REF.length).split(':')
  if (parts.length === 1 && parts[0]) return { topic: parts[0], role: 'rule' }
  if (parts.length === 3 && parts[0] && parts[1] === 'card') return { topic: parts[0], role: 'card' }
  return null
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

// deckId moves the fact (with its card and history) to another deck.
export type FactPatch = Partial<FactInput> & { status?: FactStatus; deckId?: string }

// Only the fields given change; the card and its history always stay.
export function updateFact(db: Db, userId: string, id: string, patch: FactPatch, now: Date): Fact {
  return tx(db, () => {
    const cur = mustGetFact(db, userId, id)
    let deckId = cur.deckId
    if (patch.deckId !== undefined && patch.deckId !== cur.deckId) {
      const deck = resolveDeck(db, userId, patch.deckId)
      if (!deck) throw new HttpError(404, 'deck not found')
      deckId = deck.id
    }
    const f = cleanFactInput({
      front: patch.front ?? cur.front,
      back: patch.back ?? cur.back,
      tags: patch.tags ?? cur.tags,
    })
    const status = patch.status ?? cur.status
    if (!FACT_STATUSES.includes(status)) throw new HttpError(400, `unknown status ${status}`)
    const dup = findDuplicateFact(db, userId, deckId, f.front)
    if (dup && dup.id !== id) throw new DuplicateFactError(dup)
    db.prepare('UPDATE facts SET deck_id = ?, front = ?, back = ?, tags = ?, status = ?, dedupe_key = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(deckId, f.front, f.back, JSON.stringify(f.tags), status, factKey(f.front), now.toISOString(), id, userId)
    return getFact(db, userId, id)!
  })
}

export function deleteFact(db: Db, userId: string, id: string) {
  const r = db.prepare('DELETE FROM facts WHERE id = ? AND user_id = ?').run(id, userId)
  if (r.changes === 0) throw new HttpError(404, `fact ${id} not found`)
}

export function setFactSuspended(db: Db, userId: string, id: string, suspended: boolean) {
  mustGetFact(db, userId, id)
  db.prepare('UPDATE cards SET suspended = ? WHERE fact_id = ?').run(suspended ? 1 : 0, id)
}

export interface AddFactsResult {
  deck: { id: string; name: string; created: boolean }
  created: { index: number; id: string; front: string; status: FactStatus }[]
  duplicates: { index: number; existingId: string; existingStatus: FactStatus; front: string; differs: Record<string, unknown> }[]
  errors: { index: number; front?: string; error: string }[]
}

// Batch add (MCP): each fact validated and deduped by question like a manual
// add, against facts of any status and earlier ones in the batch; `tags`
// join every fact's own. The deck is created only when asked.
export function addFacts(
  db: Db,
  userId: string,
  input: { deck: string; facts: FactInput[]; tags?: string[]; createDeck?: boolean; createdBy: Author },
  now: Date,
): AddFactsResult {
  return tx(db, () => {
    let deck = resolveDeck(db, userId, input.deck)
    let created = false
    if (!deck) {
      if (!input.createDeck) throw new HttpError(404, `no deck "${input.deck}"; pass createDeck: true to create it, or call list_decks`)
      deck = createDeck(db, userId, { name: input.deck }, now)
      created = true
    }
    const d = deck
    const out: AddFactsResult = { deck: { id: d.id, name: d.name, created }, created: [], duplicates: [], errors: [] }
    const status: FactStatus = 'active'
    input.facts.forEach((p, index) => {
      const tags = [...(input.tags ?? []), ...(p.tags ?? [])]
      const r = cleanFact({ ...p, tags: input.createdBy === 'claude' ? withClaudeTag(tags) : tags })
      if ('error' in r) {
        out.errors.push({ index, front: p.front, error: r.error })
        return
      }
      const dup = findDuplicateFact(db, userId, d.id, r.fact.front)
      if (dup) {
        const differs: Record<string, unknown> = {}
        if (r.fact.back !== dup.back) differs.back = { existing: dup.back, proposed: r.fact.back }
        const newTags = r.fact.tags.filter((t) => !dup.tags.includes(t) && t !== CLAUDE_TAG)
        if (newTags.length) differs.newTags = newTags
        out.duplicates.push({ index, existingId: dup.id, existingStatus: dup.status, front: dup.front, differs })
        return
      }
      const { fact } = createFact(db, userId, { deckId: d.id, fact: r.fact, status, createdBy: input.createdBy }, now)
      out.created.push({ index, id: fact.id, front: fact.front, status })
    })
    return out
  })
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
  const pools = new Map<string, { active: number; flagged: number; needsReview: number }>()
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => r.id)
    const ps = db.prepare(`SELECT fact_id, sum(status = 'active') AS active, sum(status = 'flagged') AS flagged, sum(needs_review = 1) AS needs_review
      FROM fact_exercises WHERE fact_id IN (${chunk.map(() => '?').join(',')}) GROUP BY fact_id`).all(...chunk) as { fact_id: string; active: number; flagged: number; needs_review: number }[]
    for (const p of ps) pools.set(p.fact_id, { active: p.active, flagged: p.flagged, needsReview: p.needs_review })
  }
  return rows.map((r) => {
    const deck = decks.get(r.deck_id)!
    const c = cards.get(r.id)
    const pool = pools.get(r.id)
    const hb = handbookRef(r.import_ref)
    return { ...toFact(r), deckName: deck.name, card: c ? cardSummary(toCard(c), deck, now) : null, ...(pool ? { exercises: pool } : {}), ...(hb ? { handbook: hb } : {}) }
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
  // Every tag given (or one under it) must be on the fact.
  tag?: string | string[]
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
  for (const t of tagList(s.tag)) {
    where.push(tagWhere('f.tags'))
    args.push(...tagArgs(t))
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
