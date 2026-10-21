// Imports the Obsidian Decks plugin database (flashcards.db) into one user's
// collection:
// - vocabulary into the English deck as words, by the same rules as the v3
//   migration (vocab-convert.ts), so a fresh import gives what migrating an
//   old import gives;
// - Q&A decks whose name starts with the topics prefix ("Revolut — Java
//   Core") into topic decks ("Java Core") as facts.
//   node server/src/import-decks.ts --from <flashcards.db> --db <recall.db> [--user <telegram id>] [--topics <prefix>] [--dry-run]
// --user defaults to OWNER_TELEGRAM_ID; the user is created if missing.
// --topics defaults to "Revolut — "; an empty prefix imports no topics.
//
// Decks stores one row per card. Table rows of a `reverse: true` deck get a
// second `rcard_*` row with front/back swapped. Cloze cards, and Q&A cards
// outside topic decks, are skipped.
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dedupeKey, newCardState, type CardState, type Direction, type PartOfSpeech } from '@recall/core'
import { loadConfig } from './config.ts'
import { newId, openDb, type Db } from './db.ts'
import { loadLexicon, type Lexicon } from './lexicon.ts'
import { createFact, findDuplicateFact } from './facts.ts'
import { createTopicDeck, defaultDeck, findDeckByName, findDuplicate, HttpError, insertCard } from './repo.ts'
import { ensureUser, migrationEnv } from './users.ts'
import { convertPair, convertTags, englishSide, isVocabularyDeckName, looksLikeWordPair, mergeTranslations, parseExtra } from './vocab-convert.ts'

interface Flashcard {
  id: string
  deck_id: string
  deck_name: string
  front: string
  back: string
  type: string
  breadcrumb: string
  notes: string
  state: 'new' | 'review'
  due_date: string
  interval: number
  repetitions: number
  difficulty: number
  stability: number
  lapses: number
  last_reviewed: string | null
  created: string
  modified: string
  tags: string
  suspended_at: string | null
  template_row: string | null
}

interface DecksLog {
  id: string
  flashcard_id: string
  last_reviewed_at: string
  reviewed_at: string
  rating: number
  time_elapsed_ms: number | null
  old_state: 'new' | 'review'
  old_repetitions: number
  old_lapses: number
  old_stability: number
  old_difficulty: number
  new_state: 'new' | 'review'
  new_repetitions: number
  new_lapses: number
  new_stability: number
  new_difficulty: number
  old_interval_minutes: number
  new_interval_minutes: number
  old_due_at: string
  new_due_at: string
  elapsed_days: number
}

// One or two Decks rows that are the same word.
interface Planned {
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa: string | null
  note: string | null
  tags: string[]
  cards: Map<Direction, Flashcard>
  ids: string[]
  created: string
  modified: string
}

export interface TopicSummary {
  prefix: string
  // Topic deck names.
  decks: { created: string[]; existing: string[] }
  facts: { created: number; alreadyImported: number; duplicates: number }
  cards: { new: number; review: number; suspended: number }
  // Rows of topic decks that aren't Q&A (cloze, tables) or have an empty side.
  skipped: number
}

export interface ImportSummary {
  flashcards: number
  words: { created: number; merged: number; alreadyImported: number; duplicates: number }
  cards: { forward: number; reverse: number; new: number; review: number; suspended: number }
  logs: { imported: number; alreadyImported: number; orphaned: number }
  skipped: { cloze: number; notWords: number; unsupportedType: number }
  topics: TopicSummary
}

export const DEFAULT_TOPIC_PREFIX = 'Revolut — '

// "Revolut — " → "revolut": every imported fact is tagged with where it came from.
export function topicTag(prefix: string): string | null {
  return prefix.replace(/[\s\p{P}\p{S}]+$/u, '').trim().toLowerCase() || null
}

const PRONUNCIATION = /^(ipa|transcription|pronunciation)$/i

const clean = (s: string | null | undefined) => (s ?? '').replace(/%%[\s\S]*?%%/g, '').trim()
const iso = (s: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}.000Z` : new Date(s).toISOString())

function breadcrumbTag(f: Flashcard): string | null {
  const rest = f.breadcrumb.split(' > ').slice(1).join(' > ').trim()
  return rest || null
}

function decksTags(f: Flashcard): string[] {
  return f.tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean)
}

// Front/back and extra lines of a table or header-paragraph card. Table rows
// carry all columns in template_row; a pronunciation column becomes an
// "IPA: …" line even when Decks put it second (and thus on the back).
function deriveFields(f: Flashcard): { front: string; back: string; extra: string[] } {
  let front = clean(f.front)
  let back = clean(f.back)
  const extra: string[] = []
  let cells: string[] = []
  if (f.template_row) {
    const row = JSON.parse(f.template_row) as { headers?: string[]; cells?: string[] }
    const headers = row.headers ?? []
    cells = (row.cells ?? []).map(clean)
    if (headers.length === cells.length && headers.length >= 2) {
      const content = headers.map((_, i) => i).filter((i) => !PRONUNCIATION.test(headers[i]!.trim()))
      if (content.length >= 2) {
        front = cells[content[0]!]!
        back = cells[content[1]!]!
        headers.forEach((h, i) => {
          if (i !== content[0] && i !== content[1] && cells[i]) extra.push(`${PRONUNCIATION.test(h.trim()) ? 'IPA' : h.trim()}: ${cells[i]}`)
        })
      }
    }
  }
  // Decks copies some columns into `notes` as well; keep only new text.
  const notes = clean(f.notes)
  if (notes && ![front, back, ...cells].includes(notes)) extra.push(notes)
  return { front, back, extra }
}

// Pairs Decks rows into words: an rcard with its forward row, or two
// one-way rows that mirror each other; the rest stay single.
function pairRows(rows: Flashcard[]): Flashcard[][] {
  const out: Flashcard[][] = []
  const byDeck = new Map<string, Flashcard[]>()
  for (const r of rows) byDeck.set(r.deck_id, [...(byDeck.get(r.deck_id) ?? []), r])
  for (const cards of byDeck.values()) {
    const forward = cards.filter((c) => !c.id.startsWith('rcard_'))
    const reverse = cards.filter((c) => c.id.startsWith('rcard_'))
    const paired = new Set<string>()
    const fwdIndex = new Map<string, Flashcard[]>()
    for (const f of forward) {
      const k = `${clean(f.front)}\u0000${clean(f.back)}\u0000${f.breadcrumb}`
      fwdIndex.set(k, [...(fwdIndex.get(k) ?? []), f])
    }
    for (const r of reverse) {
      const f = fwdIndex.get(`${clean(r.back)}\u0000${clean(r.front)}\u0000${r.breadcrumb}`)?.find((x) => !paired.has(x.id))
      if (!f) continue
      paired.add(f.id).add(r.id)
      out.push([f, r])
    }
    const rest = cards.filter((f) => !paired.has(f.id))
    const mirror = new Map<string, Flashcard[]>()
    for (const f of rest) {
      const d = deriveFields(f)
      const k = `${d.front}\u0000${d.back}`
      mirror.set(k, [...(mirror.get(k) ?? []), f])
    }
    for (const f of rest) {
      if (paired.has(f.id)) continue
      const d = deriveFields(f)
      const other = mirror.get(`${d.back}\u0000${d.front}`)?.find((x) => x.id !== f.id && !paired.has(x.id))
      if (!other) continue
      paired.add(f.id).add(other.id)
      out.push([f, other])
    }
    for (const f of rest) if (!paired.has(f.id)) out.push([f])
  }
  return out
}

function plan(rows: Flashcard[], s: ImportSummary): Planned[] {
  const plain = rows.filter((r) => r.type === 'table' || r.type === 'header-paragraph')
  s.skipped.cloze = rows.filter((r) => r.type === 'cloze').length
  s.skipped.unsupportedType = rows.length - plain.length - s.skipped.cloze
  const groups = pairRows(plain)
  // As in the migration: single rows count only in decks with pairs or a vocabulary name.
  const vocabDecks = new Set(groups.filter((g) => g.length === 2 || isVocabularyDeckName(g[0]!.deck_name)).map((g) => g[0]!.deck_id))
  const planned: Planned[] = []
  for (const group of groups) {
    const a = group[0]!
    const fa = deriveFields(a)
    const pair = convertPair(fa.front, fa.back)
    const english = pair ? (pair.englishOn === 'front' ? fa.front : fa.back) : ''
    const russian = pair ? (pair.englishOn === 'front' ? fa.back : fa.front) : ''
    if (!pair || (group.length === 1 && (!vocabDecks.has(a.deck_id) || !looksLikeWordPair(english, russian)))) {
      s.skipped.notWords += group.length
      continue
    }
    const cards = new Map<Direction, Flashcard>()
    for (const f of group) {
      // A row asks its front: forward when the front is the English side.
      const side = englishSide(clean(f.front), clean(f.back)) ?? (f === a ? pair.englishOn : pair.englishOn === 'front' ? 'back' : 'front')
      const dir: Direction = side === 'front' ? 'forward' : 'reverse'
      cards.set(cards.has(dir) ? (dir === 'forward' ? 'reverse' : 'forward') : dir, f)
    }
    const extraLines = [...fa.extra]
    for (const f of group.slice(1)) for (const l of deriveFields(f).extra) if (!extraLines.includes(l)) extraLines.push(l)
    const { ipa, note } = parseExtra(extraLines.join('\n'))
    // A pair made of two one-way sections keeps only the context both share.
    const crumbs = group.map(breadcrumbTag)
    const crumb = crumbs.every((c) => c === crumbs[0]) ? crumbs[0] : null
    const converted = convertTags([...new Set([crumb ?? '', ...group.flatMap(decksTags)].filter(Boolean))])
    const tags = converted.tags
    planned.push({
      term: pair.term, pos: pair.pos, translations: pair.translations, ipa, note, tags, cards,
      ids: group.map((f) => f.id),
      created: group.map((f) => iso(f.created)).sort()[0]!,
      modified: group.map((f) => iso(f.modified)).sort().at(-1)!,
    })
  }
  return planned
}

function cardState(f: Flashcard): CardState {
  if (f.state === 'new') return newCardState(new Date(iso(f.created)))
  return {
    due: new Date(f.due_date).toISOString(),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsedDays: 0,
    // Decks keeps intervals in minutes.
    scheduledDays: f.interval / 1440,
    learningSteps: 0,
    reps: f.repetitions,
    lapses: f.lapses,
    state: 2,
    lastReview: f.last_reviewed ? new Date(f.last_reviewed).toISOString() : null,
  }
}

function logStates(l: DecksLog): { before: CardState; after: CardState } {
  const wasNew = l.old_state === 'new'
  return {
    before: {
      due: new Date(l.old_due_at).toISOString(),
      stability: wasNew ? 0 : l.old_stability,
      difficulty: wasNew ? 0 : l.old_difficulty,
      elapsedDays: l.elapsed_days,
      scheduledDays: l.old_interval_minutes / 1440,
      learningSteps: 0,
      reps: l.old_repetitions,
      lapses: l.old_lapses,
      state: wasNew ? 0 : 2,
      lastReview: wasNew ? null : new Date(l.last_reviewed_at).toISOString(),
    },
    after: {
      due: new Date(l.new_due_at).toISOString(),
      stability: l.new_stability,
      difficulty: l.new_difficulty,
      elapsedDays: l.elapsed_days,
      scheduledDays: l.new_interval_minutes / 1440,
      learningSteps: 0,
      reps: l.new_repetitions,
      lapses: l.new_lapses,
      state: l.new_state === 'new' ? 0 : 2,
      lastReview: new Date(l.reviewed_at).toISOString(),
    },
  }
}

export interface ImportOptions {
  dryRun?: boolean
  now?: Date
  lexicon?: Lexicon | null
  // Decks decks whose name starts with this become topic decks; '' = none.
  topics?: string
}

export function importDecks(src: DatabaseSync, db: Db, userId: string, { dryRun = false, now = new Date(), lexicon = null, topics = DEFAULT_TOPIC_PREFIX }: ImportOptions = {}): ImportSummary {
  const all = src.prepare(`
    SELECT f.*, d.name AS deck_name, coalesce(f.suspended_at, o.suspended_at) AS suspended_at
    FROM flashcards f JOIN decks d ON d.id = f.deck_id LEFT JOIN card_state_overlays o ON o.flashcard_id = f.id
    ORDER BY f.created, f.id`).all() as unknown as Flashcard[]
  const isTopic = (f: Flashcard) => !!topics && f.deck_name.startsWith(topics) && !!f.deck_name.slice(topics.length).trim()
  const rows = all.filter((f) => !isTopic(f))
  const topicRows = all.filter(isTopic)
  const logs = src.prepare('SELECT * FROM review_logs ORDER BY reviewed_at, id').all() as unknown as DecksLog[]
  const logCount = new Map<string, number>()
  for (const l of logs) logCount.set(l.flashcard_id, (logCount.get(l.flashcard_id) ?? 0) + 1)

  const s: ImportSummary = {
    flashcards: all.length,
    words: { created: 0, merged: 0, alreadyImported: 0, duplicates: 0 },
    cards: { forward: 0, reverse: 0, new: 0, review: 0, suspended: 0 },
    logs: { imported: 0, alreadyImported: 0, orphaned: 0 },
    skipped: { cloze: 0, notWords: 0, unsupportedType: 0 },
    topics: { prefix: topics, decks: { created: [], existing: [] }, facts: { created: 0, alreadyImported: 0, duplicates: 0 }, cards: { new: 0, review: 0, suspended: 0 }, skipped: 0 },
  }
  const planned = plan(rows, s)

  db.exec('BEGIN IMMEDIATE')
  try {
    const deck = defaultDeck(db, userId, now)
    // Decks ids already in recall → that word's card per direction.
    const cardFor = new Map<string, string>()
    const imported = new Map<string, string>()
    for (const w of db.prepare('SELECT id, import_ref FROM words WHERE user_id = ? AND import_ref IS NOT NULL').all(userId) as { id: string; import_ref: string }[]) {
      for (const ref of w.import_ref.split(',')) imported.set(ref, w.id)
    }
    const cardOf = db.prepare('SELECT id FROM cards WHERE word_id = ? AND direction = ?')

    // Same word twice in the import: merge, keeping the card with more history per direction.
    const merged = new Map<string, Planned>()
    for (const p of planned) {
      const k = dedupeKey(p.term, p.pos)
      const had = merged.get(k)
      if (!had) {
        merged.set(k, { ...p, cards: new Map(p.cards) })
        continue
      }
      s.words.merged++
      had.translations = mergeTranslations(had.translations, p.translations)
      had.ipa ??= p.ipa
      had.note = [had.note, p.note].filter((x, i, a) => x && a.indexOf(x) === i).join('\n\n') || null
      had.tags = [...new Set([...had.tags, ...p.tags])]
      had.ids.push(...p.ids)
      for (const [dir, f] of p.cards) {
        const cur = had.cards.get(dir)
        if (!cur || (logCount.get(f.id) ?? 0) > (logCount.get(cur.id) ?? 0)) had.cards.set(dir, f)
      }
    }

    const insertWord = db.prepare(`INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, tags, freq_rank, status, created_by, dedupe_key, import_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'active', 'import', ?, ?, ?, ?)`)
    for (const p of merged.values()) {
      const known = p.ids.map((id) => imported.get(id)).find(Boolean)
      if (known) {
        s.words.alreadyImported++
        for (const [dir, f] of p.cards) cardFor.set(f.id, (cardOf.get(known, dir) as { id: string }).id)
        continue
      }
      if (findDuplicate(db, userId, deck.id, p.term, p.pos)) {
        s.words.duplicates++
        continue
      }
      const wordId = newId('wd')
      insertWord.run(wordId, userId, deck.id, p.term, p.pos, JSON.stringify(p.translations), p.ipa, p.note, JSON.stringify(p.tags),
        lexicon?.rank(p.term) ?? null, dedupeKey(p.term, p.pos), p.ids.join(','), p.created, p.modified)
      for (const dir of ['forward', 'reverse'] as const) {
        const f = p.cards.get(dir)
        const state = f ? cardState(f) : newCardState(new Date(p.created))
        const cardId = insertCard(db, wordId, dir, state, !!f?.suspended_at)
        if (f) cardFor.set(f.id, cardId)
        s.cards[dir]++
        s.cards[state.state === 0 ? 'new' : 'review']++
        if (f?.suspended_at) s.cards.suspended++
      }
      s.words.created++
    }

    importTopics(db, userId, topicRows, topics, s.topics, cardFor, now)

    // Log ids are Decks' own; importing the same Decks db for a second user
    // skips them as already imported.
    const insertLog = db.prepare('INSERT OR IGNORE INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const l of logs) {
      const cardId = cardFor.get(l.flashcard_id)
      if (!cardId) {
        s.logs.orphaned++
        continue
      }
      const { before, after } = logStates(l)
      const r = insertLog.run(l.id, cardId, l.rating, new Date(l.reviewed_at).toISOString(), l.time_elapsed_ms, JSON.stringify(before), JSON.stringify(after))
      if (r.changes) s.logs.imported++
      else s.logs.alreadyImported++
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return s
}

// Q&A rows of the topic decks → facts: front = question, back = the Markdown
// answer (wikilinks and all); the card takes the row's state, as words' do.
function importTopics(db: Db, userId: string, rows: Flashcard[], prefix: string, s: TopicSummary, cardFor: Map<string, string>, now: Date) {
  const tag = topicTag(prefix)
  const decks = new Map<string, string>()
  const deckFor = (decksName: string) => {
    const name = decksName.slice(prefix.length).trim()
    let id = decks.get(name)
    if (id) return id
    const existing = findDeckByName(db, userId, name)
    if (existing && existing.kind !== 'topic') throw new Error(`"${name}" is already a ${existing.kind} deck; rename it or pick another --topics prefix`)
    if (existing) s.decks.existing.push(name)
    else s.decks.created.push(name)
    id = existing?.id ?? createTopicDeck(db, userId, { name }, now).id
    decks.set(name, id)
    return id
  }
  const imported = db.prepare('SELECT c.id FROM cards c JOIN facts f ON f.id = c.fact_id WHERE f.user_id = ? AND f.import_ref = ?')
  for (const f of rows) {
    const front = clean(f.front)
    const back = clean(f.back)
    if (f.type !== 'header-paragraph' || !front || !back) {
      s.skipped++
      continue
    }
    const known = imported.get(userId, f.id) as { id: string } | undefined
    if (known) {
      s.facts.alreadyImported++
      cardFor.set(f.id, known.id)
      continue
    }
    const deckId = deckFor(f.deck_name)
    if (findDuplicateFact(db, userId, deckId, front)) {
      s.facts.duplicates++
      continue
    }
    const tags = [...new Set([tag, breadcrumbTag(f), ...decksTags(f)].filter((t): t is string => !!t))]
    const state = cardState(f)
    try {
      const { cardId } = createFact(db, userId, {
        deckId, fact: { front, back, tags }, status: 'active', createdBy: 'import', importRef: f.id,
        createdAt: new Date(iso(f.created)), card: { state, suspended: !!f.suspended_at },
      }, now)
      cardFor.set(f.id, cardId)
    } catch (e) {
      // Too long for a fact: left out, counted.
      if (e instanceof HttpError && e.status === 400) {
        s.skipped++
        continue
      }
      throw e
    }
    s.facts.created++
    s.cards[state.state === 0 ? 'new' : 'review']++
    if (f.suspended_at) s.cards.suspended++
  }
}

function main(argv: string[]) {
  const arg = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const from = arg('--from')
  const cfg = loadConfig(process.env, [])
  const dbPath = arg('--db') ?? cfg.dbPath
  const user = arg('--user') ?? (cfg.ownerTelegramId === null ? undefined : String(cfg.ownerTelegramId))
  if (!from || !user || !/^\d+$/.test(user)) {
    console.error('usage: node server/src/import-decks.ts --from <flashcards.db> --db <recall.db> [--user <telegram id>] [--topics <prefix>] [--dry-run]')
    console.error(`--user defaults to OWNER_TELEGRAM_ID; --topics to "${DEFAULT_TOPIC_PREFIX}" (Decks decks named "<prefix><topic>" become topic decks; "" for none)`)
    process.exit(2)
  }
  const src = new DatabaseSync(from, { readOnly: true })
  const db = openDb(dbPath, migrationEnv(cfg))
  const target = ensureUser(db, cfg, Number(user), new Date())
  console.error(`importing into user ${target.id} (Telegram ${target.telegramId})`)
  const summary = importDecks(src, db, target.id, { dryRun: argv.includes('--dry-run'), lexicon: loadLexicon(cfg.dataDir), topics: arg('--topics') ?? DEFAULT_TOPIC_PREFIX })
  src.close()
  db.close()
  console.log(JSON.stringify(summary, null, 2))
  if (argv.includes('--dry-run')) console.log('dry run: nothing written')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
