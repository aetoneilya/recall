// Adding content packs (pack-data.ts) to a user's collection: one topic deck
// per pack, named after it, with the pack's facts active in pack order.
import type { Db } from './db.ts'
import { tx } from './db.ts'
import { createFact, findDuplicateFact } from './facts.ts'
import { currentPacks, type Pack } from './pack-data.ts'
import { createTopicDeck, findDeckByName, getDeck, HttpError, type DeckInfo } from './repo.ts'

export interface PackInfo {
  id: string
  name: string
  description: string
  count: number
  // Some of its cards are in the user's collection.
  added: boolean
  // Items not added yet (all of them before the first add; a pack that grew later).
  missing: number
  deckId?: string
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

export function listPacks(db: Db, userId: string): PackInfo[] {
  return currentPacks().map((p) => {
    const { refs, deckId } = imported(db, userId, p)
    const missing = p.facts.filter((f) => !refs.has(ref(p, f.key))).length
    const deck = deckId ?? null
    return { id: p.id, name: p.name, description: p.description, count: p.facts.length, added: refs.size > 0, missing, ...(deck ? { deckId: deck } : {}) }
  })
}

// Adds what the user doesn't have yet. The deck: the one earlier items went
// to, else a topic deck with the pack's name (made if missing: 5 new a day,
// in review). Facts are active, createdBy 'import', import_ref
// pack:<id>:<key>, and created a millisecond apart in pack order — the
// queue introduces new cards by creation time, so they come most frequent
// first. Items added on a later run (a grown pack) come after those.
export function addPack(db: Db, userId: string, packId: string, now: Date): AddPackResult {
  const p = currentPacks().find((x) => x.id === packId)
  if (!p) throw new HttpError(404, `no pack ${packId}`)
  return tx(db, () => {
    const { refs, deckId } = imported(db, userId, p)
    let deck = deckId ? getDeck(db, userId, deckId) : null
    if (!deck) {
      const named = findDeckByName(db, userId, p.name)
      if (named && named.kind !== 'topic') throw new HttpError(409, `"${p.name}" is already a language deck; rename it to add this pack`)
      deck = named ?? createTopicDeck(db, userId, { name: p.name, newPerDay: 5 }, now)
    }
    const out: AddPackResult = { deck, added: 0, alreadyAdded: 0, duplicates: 0 }
    let i = 0
    for (const f of p.facts) {
      if (refs.has(ref(p, f.key))) {
        out.alreadyAdded++
        continue
      }
      if (findDuplicateFact(db, userId, deck.id, f.front)) {
        out.duplicates++
        continue
      }
      createFact(db, userId, {
        deckId: deck.id, fact: { front: f.front, back: f.back, tags: f.tags }, status: 'active', createdBy: 'import',
        importRef: ref(p, f.key), createdAt: new Date(now.getTime() + i++),
      }, now)
      out.added++
    }
    return out
  })
}
