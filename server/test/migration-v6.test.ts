// v5 → v6: decks get kind and in_review, facts appear, cards may belong to a
// fact. decks and cards are rebuilt; every row and id is kept.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, openDb, schemaVersion, type Db } from '../src/db.ts'
import { listDecks, searchWords } from '../src/repo.ts'
import { applyReviews, buildQueue, wordLogs } from '../src/study.ts'
import { TZ } from './helpers.ts'

const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null }
const NOW = new Date('2026-10-21T09:00:00Z')
const ENV = { ownerTelegramId: 100001, defaults: DEFAULTS, now: NOW, log: () => {} }
const state = (s: number) => JSON.stringify({ due: '2026-10-25T00:00:00.000Z', stability: 5, difficulty: 5, elapsedDays: 1, scheduledDays: 4, learningSteps: 0, reps: 1, lapses: 0, state: s, lastReview: '2026-10-20T00:00:00.000Z' })

// A schema-v5 database with two users, decks, words, cards and logs.
function v5(db: Db) {
  migrate(db, ENV, 5)
  expect(schemaVersion(db)).toBe(5)
  db.exec(`
    INSERT INTO users(id, telegram_id, name, time_zone, reminder_time, evening_reminder_time, created_at) VALUES
      ('us_a', 100001, 'A', 'Europe/Moscow', '09:00', '20:00', '2026-07-01T00:00:00.000Z'),
      ('us_b', 111, 'B', 'Asia/Tokyo', '08:00', NULL, '2026-07-02T00:00:00.000Z');
    INSERT INTO decks(id, user_id, name, target_lang, native_lang, new_per_day, forward_enabled, reverse_enabled, reverse_after_days, type_answer, created_at) VALUES
      ('dk_a', 'us_a', 'English', 'en', 'ru', 20, 1, 1, 7, 'reverse', '2026-07-01T00:00:00.000Z'),
      ('dk_a2', 'us_a', 'Deutsch', 'de', 'ru', 5, 1, 0, NULL, 'off', '2026-07-03T00:00:00.000Z'),
      ('dk_b', 'us_b', 'English', 'en', 'ru', 15, 1, 0, NULL, 'off', '2026-07-02T00:00:00.000Z');
    INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, tags, freq_rank, cefr, status, created_by, dedupe_key, import_ref, created_at, updated_at) VALUES
      ('wd_1', 'us_a', 'dk_a', 'to frown', 'verb', '["хмуриться"]', 'fraʊn', '[]', NULL, '["vocab"]', 2500, 'B2', 'active', 'import', 'frown|verb', 'card_a,rcard_a', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      ('wd_2', 'us_b', 'dk_b', 'bone', 'noun', '["кость"]', NULL, '[]', NULL, '[]', NULL, NULL, 'inbox', 'claude', 'bone|noun', NULL, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    INSERT INTO cards(id, word_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review) VALUES
      ('cd_1f', 'wd_1', 'forward', 0, '2026-10-21T00:00:00.000Z', 5, 5, 1, 4, 0, 1, 0, 2, '2026-10-17T00:00:00.000Z'),
      ('cd_1r', 'wd_1', 'reverse', 1, '2026-07-10T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL),
      ('cd_2f', 'wd_2', 'forward', 0, '2026-07-11T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL),
      ('cd_2r', 'wd_2', 'reverse', 0, '2026-07-11T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL);
    INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES
      ('log_1', 'cd_1f', 3, '2026-10-17T00:00:00.000Z', 4000, '${state(0)}', '${state(2)}');
    INSERT INTO vocab_tests(id, user_id, deck_id, items, created_at) VALUES ('vt_1', 'us_a', 'dk_a', '[]', '2026-10-01T00:00:00.000Z');
  `)
}

const TABLES = ['users', 'words', 'review_logs', 'vocab_tests', 'settings']
const dump = (db: Db, table: string) => JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
const without = (rows: Record<string, unknown>[], cols: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))))
const sorted = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))

describe('migration to v6', () => {
  it('rebuilds decks and cards keeping every row, adds facts and study_cards', () => {
    const db = new DatabaseSync(':memory:')
    v5(db)
    const before = Object.fromEntries([...TABLES, 'decks', 'cards'].map((t) => [t, dump(db, t)]))
    migrate(db, ENV, 6)
    expect(schemaVersion(db)).toBe(6)
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })

    for (const t of TABLES) expect(dump(db, t)).toEqual(before[t])
    const decks = dump(db, 'decks')
    expect(sorted(without(decks, ['kind', 'in_review']))).toEqual(sorted(before.decks))
    expect(decks.every((d: Record<string, unknown>) => d.kind === 'language' && d.in_review === 1)).toBe(true)
    const cards = dump(db, 'cards')
    expect(sorted(without(cards, ['fact_id']))).toEqual(sorted(before.cards))
    expect(cards.every((c: Record<string, unknown>) => c.fact_id === null)).toBe(true)
    expect(dump(db, 'facts')).toEqual([])
    expect((db.prepare('SELECT count(*) AS n FROM study_cards').get() as { n: number }).n).toBe(4)

    // Children follow the rebuilt tables: logs still cascade from cards, words still need a deck.
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'review_logs'").get()).toMatchObject({ sql: expect.stringMatching(/REFERENCES "?cards"?\(id\) ON DELETE CASCADE/) })
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'words'").get()).toMatchObject({ sql: expect.stringMatching(/REFERENCES "?decks"?\(id, user_id\)/) })
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'facts'").get()).toMatchObject({ sql: expect.stringMatching(/REFERENCES "?decks"?\(id, user_id\)/) })

    // The app reads it as before.
    expect(listDecks(db, 'us_a')).toMatchObject([
      { id: 'dk_a', kind: 'language', inReview: true, newPerDay: 20, reverseAfterDays: 7, typeAnswer: 'reverse' },
      { id: 'dk_a2', kind: 'language', targetLang: 'de' },
    ])
    expect(searchWords(db, 'us_b', {}, NOW).words).toMatchObject([{ id: 'wd_2', status: 'inbox', cards: { reverse: { enabled: false } } }])
    expect(buildQueue(db, 'us_a', TZ, NOW).items.map((i) => i.card.id)).toEqual(['cd_1f'])
    expect(applyReviews(db, 'us_a', [{ id: 'r2', cardId: 'cd_1f', rating: 3, reviewedAt: '2026-10-21T09:00:00.000Z' }])).toMatchObject({ applied: 1 })
    expect(wordLogs(db, 'us_a', 'wd_1').map((l) => l.id)).toEqual(['r2', 'log_1'])

    // The new constraints hold.
    expect(() => db.exec("INSERT INTO decks(id, user_id, kind, name, created_at) VALUES ('dk_x', 'us_a', 'language', 'Broken', '2026-10-21')")).toThrow(/CHECK/)
    expect(() => db.exec("INSERT INTO decks(id, user_id, kind, name, target_lang, native_lang, created_at) VALUES ('dk_x', 'us_a', 'topic', 'Broken', 'en', 'ru', '2026-10-21')")).toThrow(/CHECK/)
    expect(() => db.exec("INSERT INTO decks(id, user_id, name, target_lang, native_lang, created_at) VALUES ('dk_x', 'us_a', 'English 2', 'en', 'ru', '2026-10-21')")).toThrow(/UNIQUE/)
    db.exec("INSERT INTO decks(id, user_id, kind, name, created_at) VALUES ('dk_t', 'us_a', 'topic', 'Java Core', '2026-10-21')")
    expect(() => db.exec("INSERT INTO decks(id, user_id, kind, name, created_at) VALUES ('dk_t2', 'us_a', 'topic', 'java core', '2026-10-21')")).toThrow(/UNIQUE/)
    db.exec(`INSERT INTO facts(id, user_id, deck_id, front, back, status, created_by, dedupe_key, created_at, updated_at)
      VALUES ('ft_1', 'us_a', 'dk_t', 'Q?', 'A.', 'active', 'user', 'q', '2026-10-21', '2026-10-21')`)
    const card = (id: string, word: string | null, fact: string | null, dir = 'forward') =>
      `INSERT INTO cards(id, word_id, fact_id, direction, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state)
       VALUES ('${id}', ${word ? `'${word}'` : 'NULL'}, ${fact ? `'${fact}'` : 'NULL'}, '${dir}', '2026-10-21', 0, 0, 0, 0, 0, 0, 0, 0)`
    expect(() => db.exec(card('cd_x', 'wd_1', 'ft_1'))).toThrow(/CHECK/)
    expect(() => db.exec(card('cd_x', null, null))).toThrow(/CHECK/)
    expect(() => db.exec(card('cd_x', null, 'ft_1', 'reverse'))).toThrow(/CHECK/)
    db.exec(card('cd_f', null, 'ft_1'))
    expect(() => db.exec(card('cd_f2', null, 'ft_1'))).toThrow(/UNIQUE/)
    expect(db.prepare("SELECT kind, item_id, deck_id, user_id FROM study_cards WHERE id = 'cd_f'").get()).toEqual({ kind: 'fact', item_id: 'ft_1', deck_id: 'dk_t', user_id: 'us_a' })
    db.exec("DELETE FROM facts WHERE id = 'ft_1'")
    expect(db.prepare("SELECT 1 FROM cards WHERE id = 'cd_f'").get()).toBeUndefined()
  })

  it('opens a v5 file in place, with a backup first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-v6-'))
    const file = path.join(dir, 'recall.db')
    const raw = new DatabaseSync(file)
    v5(raw)
    raw.close()
    const db = openDb(file, ENV)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect((db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(4)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
    const backups = fs.readdirSync(path.join(dir, 'backups'))
    expect(backups).toEqual([`pre-v6-${NOW.toISOString().replace(/[:.]/g, '-')}.db`])
    const snap = new DatabaseSync(path.join(dir, 'backups', backups[0]!), { readOnly: true })
    expect(schemaVersion(snap)).toBe(5)
    expect((snap.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(4)
    snap.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('migration to v7', () => {
  it('adds the exercise tables, touching nothing else', () => {
    const db = new DatabaseSync(':memory:')
    v5(db)
    migrate(db, ENV, 6)
    const before = Object.fromEntries([...TABLES, 'decks', 'cards', 'facts'].map((t) => [t, dump(db, t)]))
    migrate(db, ENV, 7)
    expect(schemaVersion(db)).toBe(7)
    for (const t of Object.keys(before)) expect(dump(db, t)).toEqual(before[t])
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(dump(db, 'fact_exercises')).toEqual([])
    expect(() => db.exec("INSERT INTO fact_exercises(id, fact_id, type, prompt, answer, created_by, dedupe_key, created_at) VALUES ('ex_1', 'ft_none', 'gap', 'p', 'a', 'user', 'p', 'now')")).toThrow(/FOREIGN KEY/)
  })
})
