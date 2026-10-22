// Adding content packs (pack-data.ts) to a user's collection: one topic deck
// per pack, named after it, with the pack's facts active in pack order.
import type { Db } from './db.ts'
import { tx } from './db.ts'
import { createFact, findDuplicateFact } from './facts.ts'
import { currentPacks, type Pack } from './pack-data.ts'
import { createDeck, defaultDeck, findDeckByName, getDeck, HttpError, resolveDeck, type DeckInfo } from './repo.ts'

export interface PackInfo {
  id: string
  name: string
  description: string
  count: number
  // Some of its cards are in the user's collection.
  added: boolean
  // Items not added yet (all of them before the first add; a pack that grew later).
  missing: number
  // Where its cards are (once added), else where they would go (a deck named
  // after the pack is created when it is added; then `deckId` is absent).
  deckId?: string
  deckName: string
}

export interface AddPackResult {
  deck: DeckInfo
  added: number
  alreadyAdded: number
  // Items whose question the deck already had from elsewhere.
  duplicates: number
}

const ref = (p: Pack, key: string) => `pack:${p.id}:${key}`

// Which of the pack's items the user has, and the deck they're in.
function imported(db: Db, userId: string, p: Pack): { refs: Set<string>; deckId: string | null } {
  const rows = db.prepare("SELECT import_ref, deck_id FROM facts WHERE user_id = ? AND import_ref LIKE ? ESCAPE '\\' ORDER BY created_at")
    .all(userId, `pack:${p.id.replace(/[\\%_]/g, (c) => '\\' + c)}:%`) as { import_ref: string; deck_id: string }[]
  return { refs: new Set(rows.map((r) => r.import_ref)), deckId: rows[0]?.deck_id ?? null }
}

export function listPacks(db: Db, userId: string, now = new Date()): PackInfo[] {
  return currentPacks().map((p) => {
    const { refs, deckId } = imported(db, userId, p)
    const missing = p.facts.filter((f) => !refs.has(ref(p, f.key))).length
    const deck = (deckId ? getDeck(db, userId, deckId) : null) ?? defaultPackDeck(db, userId, p, now, false)
    return {
      id: p.id, name: p.name, description: p.description, count: p.facts.length, added: refs.size > 0, missing,
      ...(deck ? { deckId: deck.id } : {}), deckName: deck?.name ?? p.name,
    }
  })
}

// The deck a pack goes to unless one is chosen: irregular verbs into the
// user's English deck, other packs into a deck named after them (made when
// it is added).
export function defaultPackDeck(db: Db, userId: string, p: Pack, now: Date, create = true): DeckInfo | null {
  if (p.format === 'irregular-verbs') return create ? defaultDeck(db, userId, now) : resolveDeck(db, userId, 'en')
  return findDeckByName(db, userId, p.name) ?? (create ? createDeck(db, userId, { name: p.name }, now) : null)
}

// Adds what the user doesn't have yet, into `deckId` (or the deck earlier
// items went to, or the pack's default deck), each fact tagged with the
// pack's name. Facts are active, createdBy 'import', import_ref
// pack:<id>:<key>, and created a millisecond apart in pack order — the
// queue introduces new cards by creation time, so they come most frequent
// first. Items added on a later run (a grown pack) come after those.
export function addPack(db: Db, userId: string, packId: string, now: Date, { deckId: chosen }: { deckId?: string } = {}): AddPackResult {
  const p = currentPacks().find((x) => x.id === packId)
  if (!p) throw new HttpError(404, `no pack ${packId}`)
  return tx(db, () => {
    const { refs, deckId } = imported(db, userId, p)
    let deck: DeckInfo | null = null
    if (chosen) {
      deck = resolveDeck(db, userId, chosen)
      if (!deck) throw new HttpError(404, 'deck not found')
    } else deck = (deckId ? getDeck(db, userId, deckId) : null) ?? defaultPackDeck(db, userId, p, now)!
    const out: AddPackResult = { deck: deck!, added: 0, alreadyAdded: 0, duplicates: 0 }
    const into = deck!
    let i = 0
    for (const f of p.facts) {
      if (refs.has(ref(p, f.key))) {
        out.alreadyAdded++
        continue
      }
      if (findDuplicateFact(db, userId, into.id, f.front)) {
        out.duplicates++
        continue
      }
      createFact(db, userId, {
        deckId: into.id, fact: { front: f.front, back: f.back, tags: [p.name, ...f.tags.filter((t) => t !== p.name)] }, status: 'active', createdBy: 'import',
        importRef: ref(p, f.key), createdAt: new Date(now.getTime() + i++),
      }, now)
      out.added++
    }
    return out
  })
}
