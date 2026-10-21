import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.ts'
import { importDecks } from '../src/import-decks.ts'
import { searchWords, wordCards } from '../src/repo.ts'
import { wordLogs } from '../src/study.ts'
import { ensureUser } from '../src/users.ts'
import { testLexicon } from './helpers.ts'

const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null }
const userOf = (db: Db, telegramId = 1) => ensureUser(db, DEFAULTS, telegramId, new Date('2026-10-21T09:00:00Z')).id

// The subset of the Decks plugin schema the importer reads.
function decksDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE flashcards (
      id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL, type TEXT NOT NULL,
      breadcrumb TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', cloze_text TEXT, cloze_order INTEGER,
      state TEXT NOT NULL, due_date TEXT NOT NULL, interval REAL NOT NULL, repetitions INTEGER NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 5.0, stability REAL NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
      last_reviewed TEXT, created TEXT NOT NULL, modified TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
      suspended_at TEXT, template_row TEXT);
    CREATE TABLE card_state_overlays (flashcard_id TEXT PRIMARY KEY, suspended_at TEXT, buried_until TEXT, modified TEXT NOT NULL);
    CREATE TABLE review_logs (
      id TEXT PRIMARY KEY, flashcard_id TEXT NOT NULL, last_reviewed_at TEXT NOT NULL, reviewed_at TEXT NOT NULL,
      rating INTEGER NOT NULL, time_elapsed_ms INTEGER, old_state TEXT NOT NULL, old_repetitions INTEGER NOT NULL,
      old_lapses INTEGER NOT NULL, old_stability REAL NOT NULL, old_difficulty REAL NOT NULL, new_state TEXT NOT NULL,
      new_repetitions INTEGER NOT NULL, new_lapses INTEGER NOT NULL, new_stability REAL NOT NULL, new_difficulty REAL NOT NULL,
      old_interval_minutes INTEGER NOT NULL, new_interval_minutes INTEGER NOT NULL, old_due_at TEXT NOT NULL,
      new_due_at TEXT NOT NULL, elapsed_days REAL NOT NULL);
    INSERT INTO decks VALUES ('deck_v', 'vocabulary'), ('deck_r', 'rules'), ('deck_q', 'questions');
  `)
  const card = db.prepare(`INSERT INTO flashcards(id, deck_id, front, back, type, breadcrumb, notes, cloze_text, cloze_order, state,
    due_date, interval, repetitions, difficulty, stability, lapses, last_reviewed, created, modified, tags, template_row)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-07-28 19:36:36', '2026-07-28 19:36:36', ?, ?)`)
  const row = (cells: string[]) => JSON.stringify({ headers: ['English', 'Russian', 'IPA'], cells })
  const fresh = ['new', '2026-07-28T19:36:35.978Z', 0, 0, 5, 2.5, 0, null] as const
  // A table row of a `reverse: true` deck, its rcard twin (reviewed), and an orphan rcard.
  card.run('card_a', 'deck_v', 'to frown', 'хмуриться', 'table', 'vocabulary > wuthering heights', '/fraʊn/', null, null, ...fresh, 'vocab', row(['to frown', 'хмуриться', '/fraʊn/']))
  card.run('rcard_a', 'deck_v', 'хмуриться', 'to frown', 'table', 'vocabulary > wuthering heights', '/fraʊn/', null, null,
    'review', '2026-08-13T16:48:18.453Z', 23605.9, 2, 5.1, 16.39, 0, '2026-07-28T07:22:22.786Z', 'vocab', null)
  card.run('rcard_orphan', 'deck_v', 'ставка', 'bid', 'table', 'vocabulary > words', '', null, null, ...fresh, 'vocab', null)
  // Two cloze cards over one text.
  const text = 'I am ==well==, thanks.\n\nIt is ==theirs==.'
  card.run('ccard_1', 'deck_r', 'Word choice', text, 'cloze', 'rules', 'explanations', 'well', 0, ...fresh, '', null)
  card.run('ccard_2', 'deck_r', 'Word choice', text, 'cloze', 'rules', 'explanations', 'theirs', 1, ...fresh, '', null)
  card.run('card_q', 'deck_q', 'What is a deadlock?', 'Threads wait for each other **forever**.', 'header-paragraph', 'questions', '', null, null, ...fresh, '', null)

  const log = db.prepare(`INSERT INTO review_logs VALUES (?, ?, '2026-07-08T14:20:03.344Z', ?, 3, 5000, 'new', 0, 0, 2.5, 5, 'review', 1, 0, 2.3, 2.1, 0, 3321, '2026-07-08T14:20:03.344Z', '2026-07-11T01:00:00.000Z', 0)`)
  log.run('log_1', 'rcard_a', '2026-07-08T14:21:17.485Z')
  log.run('log_deleted_card', 'card_gone', '2026-07-09T14:21:17.485Z')
  return db
}

const NOW = new Date('2026-10-21T09:00:00Z')

describe('Decks importer', () => {
  it('imports word pairs as words with per-direction cards and history, skips the rest, and is idempotent', () => {
    const src = decksDb()
    // The same word again in a second deck, Russian first: merged into one word.
    src.exec("INSERT INTO decks VALUES ('deck_e', 'English vocabulary deck')")
    src.prepare(`INSERT INTO flashcards(id, deck_id, front, back, type, breadcrumb, state, due_date, interval, created, modified, tags)
      VALUES ('card_e', 'deck_e', 'хмуриться, морщить лоб', 'to frown', 'header-paragraph', 'English vocabulary deck > Russian → English', 'new', '2026-07-28T19:36:35.978Z', 0, '2026-07-29 10:00:00', '2026-07-29 10:00:00', '')`).run()
    const db = openDb(':memory:')
    const uid = userOf(db)
    const s = importDecks(src, db, uid, { now: NOW, lexicon: testLexicon() })
    expect(s).toEqual({
      flashcards: 7,
      words: { created: 2, merged: 1, alreadyImported: 0, duplicates: 0 },
      cards: { forward: 2, reverse: 2, new: 3, review: 1, suspended: 0 },
      logs: { imported: 1, alreadyImported: 0, orphaned: 1 },
      skipped: { cloze: 2, notWords: 1, unsupportedType: 0 },
    })

    const words = searchWords(db, uid, { sort: 'alpha', limit: 100 }, NOW).words
    expect(words.map((w) => [w.term, w.pos])).toEqual([['bid', 'other'], ['to frown', 'verb']])
    const frown = words.find((w) => w.term === 'to frown')!
    expect(frown).toMatchObject({
      deckName: 'English', status: 'active', createdBy: 'import', translations: ['хмуриться', 'морщить лоб'], ipa: 'fraʊn',
      source: 'wuthering heights', tags: ['wuthering heights', 'vocab'], freqRank: 2500, createdAt: '2026-07-28T19:36:36.000Z',
    })
    const [fwd, rev] = wordCards(db, uid, frown.id)
    expect(fwd!.schedule.state).toBe(0)
    // The rcard asked "хмуриться → to frown": the reverse direction, with its state and log.
    expect(rev!.schedule).toMatchObject({ state: 2, reps: 2, stability: 16.39, due: '2026-08-13T16:48:18.453Z' })
    expect(rev!.schedule.scheduledDays).toBeCloseTo(23605.9 / 1440)
    const logs = wordLogs(db, uid, frown.id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ id: 'log_1', cardId: rev!.id, rating: 3, durationMs: 5000, before: { state: 0 }, after: { state: 2, reps: 1 } })
    // The orphan rcard (ставка → bid) is a word whose only card is the reverse one.
    expect(words.find((w) => w.term === 'bid')).toMatchObject({ translations: ['ставка'], source: 'words', tags: ['words', 'vocab'] })

    const again = importDecks(src, db, uid, { now: NOW })
    expect(again.words).toMatchObject({ created: 0, alreadyImported: 2 })
    expect(again.logs).toEqual({ imported: 0, alreadyImported: 1, orphaned: 1 })
    expect(searchWords(db, uid, {}, NOW).total).toBe(2)
  })

  it('writes nothing on a dry run', () => {
    const db = openDb(':memory:')
    const uid = userOf(db)
    const s = importDecks(decksDb(), db, uid, { dryRun: true })
    expect(s.words.created).toBe(2)
    expect(searchWords(db, uid, {}, NOW).total).toBe(0)
  })
})
