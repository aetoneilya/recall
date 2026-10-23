// Bulk tag edits within one deck: rename a tag (with everything under it),
// delete one, or add one — on every word and fact of the deck, and in the
// deck's review filter. REST (/api/decks/:id/tags/…) and the retag CLI.
import { cleanReviewFilter, cleanTag, LIMITS, renamedTag, tagMatches, type ReviewFilter } from '@recall/core'
import { tx, type Db } from './db.ts'
import { getDeck, HttpError } from './repo.ts'

export type TagOp =
  | { kind: 'rename'; from: string; to: string }
  // exact: only the tag itself, not the tags under it.
  | { kind: 'delete'; tag: string; exact?: boolean }
  | { kind: 'add'; tag: string }

// Which cards an op touches. onlyWith: cards carrying that tag or one under
// it (checked before the op). source: 'pack' = added from a content pack
// (import_ref pack:…), 'own' = anything else.
export interface TagScope {
  onlyWith?: string
  source?: 'own' | 'pack'
}

export interface RetagResult {
  deck: { id: string; name: string }
  // words + facts changed.
  cards: number
  words: number
  facts: number
  // A rename landed on a tag some card of the deck already had (it or one
  // under it): a merge, which renaming back can't undo.
  merged: boolean
}

// A tag name from the outside, non-empty and within the limit. A new tag
// (`to`, `add`) is cleaned; one to match is only trimmed, so tags stored
// before "/" meant a path ("phrases / collocations") can still be named.
function tagArg(name: string, t: string | undefined, match = false): string {
  const s = match ? (t ?? '').trim() : cleanTag(t)
  if (!s) throw new HttpError(400, `${name} is empty`)
  if (s.length > LIMITS.tag) throw new HttpError(400, `${name} is longer than ${LIMITS.tag} characters`)
  return s
}

export function cleanOp(op: TagOp): TagOp {
  if (op.kind === 'rename') {
    const from = tagArg('from', op.from, true)
    const to = tagArg('to', op.to)
    if (from === to) throw new HttpError(400, 'from and to are the same tag')
    // "Grammar" → "Grammar/Tenses" would rewrite its own result again
    // ("Grammar/Tenses" → "Grammar/Tenses/Tenses").
    if (tagMatches(from, to)) throw new HttpError(400, `"${to}" is under "${from}": a tag can't move into itself`)
    return { kind: 'rename', from, to }
  }
  return op.kind === 'delete' ? { kind: 'delete', tag: tagArg('tag', op.tag, true), exact: !!op.exact } : { kind: 'add', tag: tagArg('tag', op.tag) }
}

// A card's tags after the op; first occurrence wins when a rename lands on a
// tag the card already has.
export function applyOp(op: TagOp, tags: string[]): string[] {
  if (op.kind === 'delete') return tags.filter((t) => (op.exact ? t !== op.tag : !tagMatches(op.tag, t)))
  if (op.kind === 'add') return tags.includes(op.tag) || tags.length >= LIMITS.tags ? tags : [...tags, op.tag]
  const out = [...new Set(tags.map((t) => renamedTag(t, op.from, op.to) ?? t))]
  if (out.some((t) => t.length > LIMITS.tag)) throw new HttpError(400, `renaming to "${op.to}" makes a tag longer than ${LIMITS.tag} characters`)
  return out
}

// The review filter follows renames and deletes (an exact delete leaves it:
// the filter's tag still takes what is under it); adds don't touch it. A
// filter tag some card still matches afterwards stays as it is: a scoped op
// (onlyWith, source) moved only part of it, and rewriting it would widen or
// re-aim the session at every card.
export function filterAfter(op: TagOp, f: ReviewFilter | null, stillUsed: (tag: string) => boolean = () => false): ReviewFilter | null {
  if (!f?.tags || op.kind === 'add' || (op.kind === 'delete' && op.exact)) return f
  return cleanReviewFilter({ ...f, tags: f.tags.flatMap((t) => (stillUsed(t) ? [t] : applyOp(op, [t]))) })
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i])

export function retagDeck(db: Db, userId: string, deckId: string, op: TagOp, scope: TagScope = {}, now = new Date()): RetagResult {
  const clean = cleanOp(op)
  const onlyWith = scope.onlyWith === undefined ? undefined : tagArg('onlyWith', scope.onlyWith, true)
  return tx(db, () => {
    const deck = getDeck(db, userId, deckId)
    if (!deck) throw new HttpError(404, 'deck not found')
    const out: RetagResult = { deck: { id: deck.id, name: deck.name }, cards: 0, words: 0, facts: 0, merged: false }
    const at = now.toISOString()
    // Every tag of the deck once the op is done, for the filter.
    const after = new Set<string>()
    for (const table of ['words', 'facts'] as const) {
      const rows = db.prepare(`SELECT id, tags, import_ref FROM ${table} WHERE user_id = ? AND deck_id = ?`).all(userId, deck.id) as { id: string; tags: string; import_ref: string | null }[]
      const update = db.prepare(`UPDATE ${table} SET tags = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      for (const r of rows) {
        const tags = JSON.parse(r.tags) as string[]
        if (clean.kind === 'rename' && tags.some((t) => tagMatches(clean.to, t))) out.merged = true
        const inScope = !(onlyWith && !tags.some((t) => tagMatches(onlyWith, t))) && !(scope.source && (r.import_ref?.startsWith('pack:') ? 'pack' : 'own') !== scope.source)
        const next = inScope ? applyOp(clean, tags) : tags
        for (const t of next) after.add(t)
        if (same(tags, next)) continue
        update.run(JSON.stringify(next), at, r.id, userId)
        out[table]++
      }
    }
    out.cards = out.words + out.facts
    const filter = filterAfter(clean, deck.reviewFilter, (f) => [...after].some((t) => tagMatches(f, t)))
    if (JSON.stringify(filter) !== JSON.stringify(deck.reviewFilter)) {
      db.prepare('UPDATE decks SET review_filter = ? WHERE id = ? AND user_id = ?').run(filter ? JSON.stringify(filter) : null, deck.id, userId)
    }
    return out
  })
}
