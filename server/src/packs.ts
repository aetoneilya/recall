// Adding content packs (pack-data.ts) to a user's collection: one topic deck
// per pack, named after it, with the pack's facts active in pack order. The
// grammar handbook also brings each rule's exercise pool, and has a read API
// of its own (handbook()).
import { tagMatches, type ExerciseInput } from '@recall/core'
import type { Db } from './db.ts'
import { tx } from './db.ts'
import { addExercises } from './exercises.ts'
import { createFact, findDuplicateFact, HANDBOOK_REF, type FactRow } from './facts.ts'
import { currentPacks, GRAMMAR_TAG, type HandbookTopic, type Pack } from './pack-data.ts'
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
  // grammar-handbook only: exercise items the rules already added still lack.
  missingExercises?: number
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
  // Exercise items added to rules (grammar-handbook; 0 for other packs).
  exercises: number
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
      ...(p.topics ? { missingExercises: missingExercises(db, userId, p) } : {}),
      ...(deck ? { deckId: deck.id } : {}), deckName: deck?.name ?? p.name,
    }
  })
}

// ---------- grammar handbook ----------

// Every topic's rule gets at least this many write items.
export const HANDBOOK_WRITE = 2

// A topic's exercise items with their import refs: the tap items
// (…:ex:<n>), then the write items, topped up to HANDBOOK_WRITE with
// generic tasks naming the rule (…:write:<n>).
export function topicExercises(packId: string, t: HandbookTopic): (ExerciseInput & { importRef: string })[] {
  const base = `pack:${packId}:${t.id}`
  const generic = [`Напиши предложение, где нужно правило «${t.title}».`, `Напиши вопрос или отрицание, где нужно правило «${t.title}».`]
  const write: ExerciseInput[] = t.write.map((w) => ({ type: 'write', prompt: w.prompt, rubric: w.rubric }))
  for (const prompt of generic) {
    if (write.length >= HANDBOOK_WRITE) break
    write.push({ type: 'write', prompt, rubric: `Используй правило «${t.title}» правильно.` })
  }
  return [
    ...t.exercises.map((e, n) => ({ type: e.type, prompt: e.prompt, answer: e.answer, options: e.options, wrong: e.wrong, explain: e.explain, importRef: `${base}:ex:${n}` })),
    ...write.map((w, n) => ({ ...w, importRef: `${base}:write:${n}` })),
  ]
}

// The user's handbook rule facts, by topic id.
function ruleFacts(db: Db, userId: string, p: Pack): Map<string, FactRow> {
  const out = new Map<string, FactRow>()
  const byRef = db.prepare('SELECT * FROM facts WHERE user_id = ? AND import_ref = ?')
  for (const t of p.topics ?? []) {
    const r = byRef.get(userId, ref(p, t.id)) as FactRow | undefined
    if (r) out.set(t.id, r)
  }
  return out
}

function haveRefs(db: Db, factId: string): Set<string> {
  return new Set((db.prepare('SELECT import_ref FROM fact_exercises WHERE fact_id = ? AND import_ref IS NOT NULL').all(factId) as { import_ref: string }[]).map((r) => r.import_ref))
}

function missingExercises(db: Db, userId: string, p: Pack): number {
  let n = 0
  for (const [topicId, fact] of ruleFacts(db, userId, p)) {
    const have = haveRefs(db, fact.id)
    n += topicExercises(p.id, p.topics!.find((t) => t.id === topicId)!).filter((e) => !have.has(e.importRef)).length
  }
  return n
}

// Adds each rule's missing items (by import ref; a text the pool already has
// counts as there), a millisecond apart in file order.
function addTopicExercises(db: Db, userId: string, p: Pack, now: Date): number {
  let added = 0
  for (const [topicId, fact] of ruleFacts(db, userId, p)) {
    const have = haveRefs(db, fact.id)
    const fresh = topicExercises(p.id, p.topics!.find((t) => t.id === topicId)!).filter((e) => !have.has(e.importRef))
    if (fresh.length) added += addExercises(db, userId, fact.id, fresh, 'import', now).created.length
  }
  return added
}

export interface HandbookTopicInfo {
  id: string
  group: string
  title: string
  level: string
  summary: string
  // The topic's rule fact in this deck, if it has one.
  ruleFactId: string | null
  cardFactIds: string[]
  // Active exercise items of the rule.
  exercises: number
}

export interface HandbookMine {
  factId: string
  title: string
  rule: string
  exercises: number
}

// A topic's group from its facts' tags: "Grammar/Tenses" → "Tenses"; facts
// added before tags were paths carry it flat, next to Grammar / Grammar theory.
function groupOf(tags: string[]): string {
  const under = tags.find((x) => x.startsWith(`${GRAMMAR_TAG}/`))
  return under ? under.slice(GRAMMAR_TAG.length + 1) : tags.find((x) => x !== GRAMMAR_TAG && x !== 'Grammar theory') ?? ''
}

const activeExercises = (db: Db, factId: string) =>
  (db.prepare("SELECT count(*) AS n FROM fact_exercises WHERE fact_id = ? AND status = 'active'").get(factId) as { n: number }).n

// The grammar of one deck: the handbook topics it holds (found by import
// ref; in pack order, with group / level / summary from the pack, or from
// the facts when the pack file is gone), and the user's own rules — facts
// tagged Grammar or under it that don't come from the handbook — oldest first.
export function handbook(db: Db, userId: string, deckId: string): { topics: HandbookTopicInfo[]; mine: HandbookMine[] } {
  const rows = db.prepare("SELECT * FROM facts WHERE user_id = ? AND deck_id = ? AND status = 'active' ORDER BY created_at, id").all(userId, deckId) as unknown as FactRow[]
  const fromBook = rows.filter((r) => r.import_ref?.startsWith(HANDBOOK_REF))
  const topicOf = (r: FactRow) => r.import_ref!.slice(HANDBOOK_REF.length).split(':')[0]!
  const ids = [...new Set(fromBook.map(topicOf))]
  const p = currentPacks().find((x) => x.format === 'grammar-handbook' && `pack:${x.id}:` === HANDBOOK_REF)
  const order = new Map((p?.topics ?? []).map((t, i) => [t.id, i]))
  ids.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
  const topics = ids.map((id): HandbookTopicInfo => {
    const own = fromBook.filter((r) => topicOf(r) === id)
    const rule = own.find((r) => r.import_ref === `${HANDBOOK_REF}${id}`) ?? null
    const cards = own.filter((r) => r !== rule && /:card:\d+$/.test(r.import_ref!))
    const t = p?.topics?.find((x) => x.id === id)
    const tags = JSON.parse((rule ?? cards[0]!).tags) as string[]
    return {
      id,
      group: t?.group ?? groupOf(tags),
      title: t?.title ?? rule?.front ?? id,
      level: t?.level ?? '',
      summary: t?.summary ?? rule?.back ?? '',
      ruleFactId: rule?.id ?? null,
      cardFactIds: cards.map((c) => c.id),
      exercises: rule ? activeExercises(db, rule.id) : 0,
    }
  })
  const mine = rows
    .filter((r) => !r.import_ref?.startsWith(HANDBOOK_REF) && (JSON.parse(r.tags) as string[]).some((x) => tagMatches(GRAMMAR_TAG, x)))
    .map((r) => ({ factId: r.id, title: r.front, rule: r.back, exercises: activeExercises(db, r.id) }))
  return { topics, mine }
}

// The deck a pack goes to unless one is chosen: irregular verbs and the
// grammar handbook into the user's English deck, other packs into a deck
// named after them (made when it is added).
export function defaultPackDeck(db: Db, userId: string, p: Pack, now: Date, create = true): DeckInfo | null {
  if (p.format === 'irregular-verbs' || p.format === 'grammar-handbook') return create ? defaultDeck(db, userId, now) : resolveDeck(db, userId, 'en')
  return findDeckByName(db, userId, p.name) ?? (create ? createDeck(db, userId, { name: p.name }, now) : null)
}

// Adds what the user doesn't have yet, into `deckId` (or the deck earlier
// items went to, or the pack's default deck), each fact tagged with the
// pack's name (the handbook's carry their own tags instead). Facts are
// active, createdBy 'import', import_ref
// pack:<id>:<key>, and created a millisecond apart in pack order — the
// queue introduces new cards by creation time, so they come most frequent
// first. Items added on a later run (a grown pack) come after those. The
// handbook's rules then get the exercise items they lack (by import ref),
// including rules added on an earlier run.
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
    const out: AddPackResult = { deck: deck!, added: 0, alreadyAdded: 0, duplicates: 0, exercises: 0 }
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
      const tags = p.topics ? f.tags : [p.name, ...f.tags.filter((t) => t !== p.name)]
      createFact(db, userId, {
        deckId: into.id, fact: { front: f.front, back: f.back, tags }, status: 'active', createdBy: 'import',
        importRef: ref(p, f.key), createdAt: new Date(now.getTime() + i++),
      }, now)
      out.added++
    }
    if (p.topics) out.exercises = addTopicExercises(db, userId, p, now)
    return out
  })
}
