// v3: from generic flashcards to language vocabulary.
//
// Per user: one "English" deck (en → ru). Vocabulary notes become words with
// two cards (forward EN→RU, reverse RU→EN) that keep their FSRS state and
// review history; everything else (cloze notes, Q&A decks) is deleted with
// its cards and logs, as are the old decks. A snapshot is taken first
// (db.ts backupBefore). The summary goes to the log and to settings
// `migration.v3`.
import { dedupeKey, newCardState, type CardState, type Direction, type FsrsState, type PartOfSpeech, type WordStatus } from '@recall/core'
import { newId, type Db, type MigrationEnv } from './db.ts'
import { convertPair, convertTags, isVocabularyDeckName, looksLikeWordPair, mergeTranslations, parseExtra } from './vocab-convert.ts'

interface OldNote {
  id: string
  user_id: string
  deck_id: string
  deck_name: string
  deck_created_at: string
  new_per_day: number
  type: string
  fields: string
  tags: string
  status: string
  created_by: string
  source: string | null
  created_at: string
  updated_at: string
}

interface OldCard {
  id: string
  note_id: string
  ordinal: number
  suspended: number
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review: string | null
  logs: number
}

interface Candidate {
  note: OldNote
  term: string
  pos: PartOfSpeech
  translations: string[]
  ipa: string | null
  note_text: string | null
  source: string | null
  tags: string[]
  cards: Map<Direction, OldCard>
}

export interface V3Report {
  users: number
  decksCreated: number
  words: number
  wordsByStatus: Record<string, number>
  merges: { term: string; pos: string; notes: string[]; kept: Partial<Record<Direction, string>>; droppedCards: string[] }[]
  cards: { forward: number; reverse: number; forwardWithHistory: number; reverseWithHistory: number; created: number }
  deleted: { notes: number; notesByReason: Record<string, number>; cards: number; decks: number; deckNames: string[] }
  logs: { before: number; kept: number; dropped: number; droppedInMerges: number }
  perUser: Record<string, { words: number; deletedNotes: number; deck: string }>
}

const other = (d: Direction): Direction => (d === 'forward' ? 'reverse' : 'forward')

function oldState(c: OldCard): CardState {
  return {
    due: c.due, stability: c.stability, difficulty: c.difficulty, elapsedDays: c.elapsed_days, scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps, reps: c.reps, lapses: c.lapses, state: c.state as FsrsState, lastReview: c.last_review,
  }
}

// More review history wins; then more reps; then the earlier note.
const better = (a: OldCard, b: OldCard) => b.logs > a.logs || (b.logs === a.logs && b.reps > a.reps)

export function vocabularyWords(db: Db, env: MigrationEnv) {
  const log = env.log ?? console.log
  const now = (env.now ?? new Date()).toISOString()

  db.exec(`
  CREATE TABLE decks_v3 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    native_lang TEXT NOT NULL,
    new_per_day INTEGER NOT NULL DEFAULT 15,
    forward_enabled INTEGER NOT NULL DEFAULT 1,
    reverse_enabled INTEGER NOT NULL DEFAULT 1,
    reverse_after_days REAL,
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id)
  );
  CREATE TABLE words (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    deck_id TEXT NOT NULL,
    term TEXT NOT NULL,
    pos TEXT NOT NULL,
    translations TEXT NOT NULL,
    ipa TEXT,
    examples TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    source TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    freq_rank INTEGER,
    cefr TEXT,
    status TEXT NOT NULL CHECK (status IN ('inbox', 'active', 'rejected')),
    created_by TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    import_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (deck_id, user_id) REFERENCES decks_v3(id, user_id)
  );
  CREATE TABLE cards_v3 (
    id TEXT PRIMARY KEY,
    word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('forward', 'reverse')),
    suspended INTEGER NOT NULL DEFAULT 0,
    due TEXT NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    learning_steps INTEGER NOT NULL,
    reps INTEGER NOT NULL,
    lapses INTEGER NOT NULL,
    state INTEGER NOT NULL,
    last_review TEXT,
    UNIQUE (word_id, direction)
  );`)

  const notes = db.prepare(`
    SELECT n.*, d.name AS deck_name, d.created_at AS deck_created_at, d.new_per_day
    FROM notes n JOIN decks d ON d.id = n.deck_id ORDER BY n.created_at, n.id`).all() as unknown as OldNote[]
  const cards = db.prepare(`
    SELECT c.*, (SELECT count(*) FROM review_logs l WHERE l.card_id = c.id) AS logs FROM cards c`).all() as unknown as OldCard[]
  const cardsByNote = new Map<string, OldCard[]>()
  for (const c of cards) cardsByNote.set(c.note_id, [...(cardsByNote.get(c.note_id) ?? []), c])
  const vocabDecks = new Set(notes.filter((n) => n.type === 'reversible' || isVocabularyDeckName(n.deck_name)).map((n) => n.deck_id))

  const report: V3Report = {
    users: 0, decksCreated: 0, words: 0, wordsByStatus: {}, merges: [],
    cards: { forward: 0, reverse: 0, forwardWithHistory: 0, reverseWithHistory: 0, created: 0 },
    deleted: { notes: 0, notesByReason: {}, cards: 0, decks: 0, deckNames: [] },
    logs: { before: (db.prepare('SELECT count(*) AS n FROM review_logs').get() as { n: number }).n, kept: 0, dropped: 0, droppedInMerges: 0 },
    perUser: {},
  }
  const drop = (n: OldNote, reason: string) => {
    report.deleted.notes++
    report.deleted.notesByReason[reason] = (report.deleted.notesByReason[reason] ?? 0) + 1
    const u = report.perUser[n.user_id]
    if (u) u.deletedNotes++
  }

  const users = (db.prepare('SELECT id FROM users UNION SELECT user_id FROM decks ORDER BY 1').all() as { id: string }[]).map((r) => r.id)
  const insertDeck = db.prepare(`INSERT INTO decks_v3(id, user_id, name, target_lang, native_lang, new_per_day, created_at) VALUES (?, ?, 'English', 'en', 'ru', ?, ?)`)
  const insertWord = db.prepare(`INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, source, tags, status, created_by, dedupe_key, import_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertCard = db.prepare(`INSERT INTO cards_v3(id, word_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  for (const userId of users) {
    report.users++
    report.perUser[userId] = { words: 0, deletedNotes: 0, deck: '' }
    const mine = notes.filter((n) => n.user_id === userId)

    const candidates: Candidate[] = []
    for (const n of mine) {
      const f = JSON.parse(n.fields) as { front?: string; back?: string; extra?: string }
      if (n.type === 'cloze') {
        drop(n, 'cloze')
        continue
      }
      if (n.type !== 'reversible' && n.type !== 'basic') {
        drop(n, `type ${n.type}`)
        continue
      }
      if (n.type === 'basic' && !vocabDecks.has(n.deck_id)) {
        drop(n, 'basic outside vocabulary decks')
        continue
      }
      const pair = convertPair(f.front ?? '', f.back ?? '')
      if (!pair) {
        drop(n, n.type === 'basic' ? 'basic without an English/Russian pair' : 'reversible without an English/Russian pair')
        continue
      }
      const english = pair.englishOn === 'front' ? f.front! : f.back!
      const russian = pair.englishOn === 'front' ? f.back! : f.front!
      if (n.type === 'basic' && !looksLikeWordPair(english.trim(), russian.trim())) {
        drop(n, 'basic that is not a word pair')
        continue
      }
      // Ordinal 0 asked front → back: forward when the front is English.
      const dir0: Direction = pair.englishOn === 'front' ? 'forward' : 'reverse'
      const byDir = new Map<Direction, OldCard>()
      for (const c of cardsByNote.get(n.id) ?? []) {
        if (c.ordinal === 0) byDir.set(dir0, c)
        else if (c.ordinal === 1 && n.type === 'reversible') byDir.set(other(dir0), c)
      }
      const { ipa, note } = parseExtra(f.extra)
      const { source, tags } = convertTags(JSON.parse(n.tags) as string[])
      candidates.push({ note: n, term: pair.term, pos: pair.pos, translations: pair.translations, ipa, note_text: note, source, tags, cards: byDir })
    }

    const groups = new Map<string, Candidate[]>()
    for (const c of candidates) {
      const k = dedupeKey(c.term, c.pos)
      groups.set(k, [...(groups.get(k) ?? []), c])
    }

    const contributing = new Map(candidates.map((c) => [c.note.deck_id, c.note]))
    const newPerDay = contributing.size ? Math.max(...[...contributing.values()].map((n) => n.new_per_day)) : 15
    const deckCreated = [...contributing.values()].map((n) => n.deck_created_at).sort()[0] ?? now
    const deckId = newId('dk')
    insertDeck.run(deckId, userId, newPerDay, deckCreated)
    report.decksCreated++
    report.perUser[userId]!.deck = deckId

    for (const [key, group] of groups) {
      const base = group[0]!
      let translations = base.translations
      const notesText: string[] = []
      const tags: string[] = []
      let ipa: string | null = null
      let source: string | null = null
      const refs: string[] = []
      for (const c of group) {
        translations = mergeTranslations(translations, c.translations)
        if (c.note_text && !notesText.includes(c.note_text)) notesText.push(c.note_text)
        for (const t of c.tags) if (!tags.includes(t)) tags.push(t)
        ipa ??= c.ipa
        source ??= c.source
        if (c.note.source?.startsWith('decks:')) refs.push(c.note.source.slice('decks:'.length))
      }
      const statuses = group.map((c) => c.note.status)
      // 'inbox' still existed then; v9 makes it active.
      const status: WordStatus | 'inbox' = statuses.includes('active') ? 'active' : statuses.includes('inbox') ? 'inbox' : 'rejected'
      const created = group.map((c) => c.note.created_at).sort()[0]!
      const updated = group.map((c) => c.note.updated_at).sort().at(-1)!
      const wordId = newId('wd')
      insertWord.run(wordId, userId, deckId, base.term, base.pos, JSON.stringify(translations), ipa, notesText.join('\n\n') || null, source,
        JSON.stringify(tags), status, base.note.created_by, key, refs.join(',') || null, created, updated)
      report.words++
      report.perUser[userId]!.words++
      report.wordsByStatus[status] = (report.wordsByStatus[status] ?? 0) + 1

      const kept: Partial<Record<Direction, string>> = {}
      const droppedCards: string[] = []
      for (const dir of ['forward', 'reverse'] as const) {
        let best: OldCard | null = null
        for (const c of group) {
          const card = c.cards.get(dir)
          if (!card) continue
          if (!best || better(best, card)) {
            if (best) droppedCards.push(best.id)
            best = card
          } else droppedCards.push(card.id)
        }
        if (best) {
          insertCard.run(best.id, wordId, dir, best.suspended, ...Object.values(stateRow(oldState(best))))
          kept[dir] = best.id
          if (best.logs > 0) report.cards[dir === 'forward' ? 'forwardWithHistory' : 'reverseWithHistory']++
        } else {
          insertCard.run(newId('cd'), wordId, dir, 0, ...Object.values(stateRow(newCardState(new Date(created)))))
          report.cards.created++
        }
        report.cards[dir]++
      }
      if (group.length > 1) {
        const droppedLogs = droppedCards.reduce((s, id) => s + (cards.find((c) => c.id === id)?.logs ?? 0), 0)
        report.logs.droppedInMerges += droppedLogs
        report.merges.push({ term: base.term, pos: base.pos, notes: group.map((c) => c.note.id), kept, droppedCards })
        log(`v3 merge: "${base.term}" (${base.pos}) from ${group.map((c) => `${c.note.id}@${c.note.deck_name}`).join(' + ')}; ` +
          `kept forward=${kept.forward ?? 'new'} reverse=${kept.reverse ?? 'new'}${droppedCards.length ? `, dropped ${droppedCards.join(', ')} (${droppedLogs} logs)` : ''}`)
      }
    }
  }

  const oldDecks = db.prepare('SELECT name FROM decks ORDER BY name').all() as { name: string }[]
  report.deleted.decks = oldDecks.length
  report.deleted.deckNames = oldDecks.map((d) => d.name)
  report.deleted.cards = cards.length - (db.prepare('SELECT count(*) AS n FROM cards_v3 WHERE id IN (SELECT id FROM cards)').get() as { n: number }).n
  report.logs.dropped = Number(db.prepare('DELETE FROM review_logs WHERE card_id NOT IN (SELECT id FROM cards_v3)').run().changes)
  report.logs.kept = (db.prepare('SELECT count(*) AS n FROM review_logs').get() as { n: number }).n

  // Create new, copy, drop old, rename (as in v2): review_logs keeps pointing at "cards".
  db.exec(`
  DROP TABLE cards;
  DROP TABLE notes;
  DROP TABLE decks;
  ALTER TABLE decks_v3 RENAME TO decks;
  ALTER TABLE cards_v3 RENAME TO cards;

  CREATE UNIQUE INDEX decks_user_name ON decks(user_id, name COLLATE NOCASE);
  CREATE UNIQUE INDEX decks_user_lang ON decks(user_id, target_lang);
  CREATE UNIQUE INDEX words_dedupe ON words(deck_id, dedupe_key);
  CREATE INDEX words_user_status ON words(user_id, status, created_at);
  CREATE INDEX words_deck_status ON words(deck_id, status);
  CREATE INDEX words_import_ref ON words(user_id, import_ref);
  CREATE INDEX cards_state_due ON cards(state, due);

  -- ✨ autofill calls per user per study day, with token usage.
  CREATE TABLE autofill_usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  -- Yes/No vocabulary tests: items (with the answer key), answers and the scored result.
  CREATE TABLE vocab_tests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id TEXT,
    items TEXT NOT NULL,
    answers TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX vocab_tests_user ON vocab_tests(user_id, created_at);
  `)

  db.prepare("INSERT INTO settings(key, value) VALUES ('migration.v3', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ at: now, ...report }))
  log(`v3: ${report.users} users, ${report.words} words (${JSON.stringify(report.wordsByStatus)}), ${report.merges.length} merges; ` +
    `cards forward ${report.cards.forward} (${report.cards.forwardWithHistory} with history), reverse ${report.cards.reverse} (${report.cards.reverseWithHistory} with history), ${report.cards.created} new; ` +
    `deleted ${report.deleted.notes} notes ${JSON.stringify(report.deleted.notesByReason)}, ${report.deleted.cards} cards, ${report.deleted.decks} decks; ` +
    `review logs ${report.logs.before} → kept ${report.logs.kept}, dropped ${report.logs.dropped} (${report.logs.droppedInMerges} in merges)`)
}

function stateRow(s: CardState) {
  return {
    due: s.due, stability: s.stability, difficulty: s.difficulty, elapsed: s.elapsedDays, scheduled: s.scheduledDays,
    steps: s.learningSteps, reps: s.reps, lapses: s.lapses, state: s.state, last: s.lastReview,
  }
}
