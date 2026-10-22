// v3 → v4: new user/deck columns and bot_drafts, nothing else touched.
// v4 → v5: a word's source becomes a tag.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, openDb, schemaVersion, type Db } from '../src/db.ts'
import { listDecks, searchWords } from '../src/repo.ts'
import { applyReviews } from '../src/study.ts'
import { getUser } from '../src/users.ts'

const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null }
const NOW = new Date('2026-10-21T09:00:00Z')
const ENV = { ownerTelegramId: 100001, defaults: DEFAULTS, now: NOW, log: () => {} }
const state = (s: number) => JSON.stringify({ due: '2026-10-25T00:00:00.000Z', stability: 5, difficulty: 5, elapsedDays: 1, scheduledDays: 4, learningSteps: 0, reps: 1, lapses: 0, state: s, lastReview: '2026-10-20T00:00:00.000Z' })

// A schema-v3 database with two users, decks, words, cards, logs, a test and usage.
function v3(db: Db) {
  migrate(db, ENV, 3)
  expect(schemaVersion(db)).toBe(3)
  db.exec(`
    INSERT INTO users(id, telegram_id, name, time_zone, reminder_time, evening_reminder_time, bot_started_at, morning_sent_day, created_at) VALUES
      ('us_a', 100001, 'A', 'Europe/Moscow', '09:00', '20:00', '2026-10-01T00:00:00.000Z', '2026-10-21', '2026-07-01T00:00:00.000Z'),
      ('us_b', 111, 'B', 'Asia/Tokyo', '08:00', NULL, NULL, NULL, '2026-07-02T00:00:00.000Z');
    INSERT INTO decks(id, user_id, name, target_lang, native_lang, new_per_day, forward_enabled, reverse_enabled, reverse_after_days, created_at) VALUES
      ('dk_a', 'us_a', 'English', 'en', 'ru', 20, 1, 1, 7, '2026-07-01T00:00:00.000Z'),
      ('dk_b', 'us_b', 'English', 'en', 'ru', 15, 1, 0, NULL, '2026-07-02T00:00:00.000Z');
    INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, source, tags, freq_rank, cefr, status, created_by, dedupe_key, import_ref, created_at, updated_at) VALUES
      ('wd_1', 'us_a', 'dk_a', 'to frown', 'verb', '["хмуриться"]', 'fraʊn', '[{"text":"She frowned.","translation":null}]', NULL, 'book', '["vocab"]', 2500, 'B2', 'active', 'import', 'frown|verb', 'decks:a', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      ('wd_2', 'us_b', 'dk_b', 'bone', 'noun', '["кость"]', NULL, '[]', NULL, NULL, '[]', NULL, NULL, 'inbox', 'claude', 'bone|noun', NULL, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    INSERT INTO cards(id, word_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review) VALUES
      ('cd_1f', 'wd_1', 'forward', 0, '2026-10-25T00:00:00.000Z', 5, 5, 1, 4, 0, 1, 0, 2, '2026-10-20T00:00:00.000Z'),
      ('cd_1r', 'wd_1', 'reverse', 1, '2026-07-10T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL),
      ('cd_2f', 'wd_2', 'forward', 0, '2026-07-11T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL),
      ('cd_2r', 'wd_2', 'reverse', 0, '2026-07-11T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL);
    INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES
      ('log_1', 'cd_1f', 3, '2026-10-20T00:00:00.000Z', 4000, '${state(0)}', '${state(2)}');
    INSERT INTO autofill_usage(user_id, day, calls, input_tokens, output_tokens) VALUES ('us_a', '2026-10-21', 3, 900, 300);
    INSERT INTO vocab_tests(id, user_id, deck_id, items, answers, result, created_at, completed_at) VALUES ('vt_1', 'us_a', 'dk_a', '[]', NULL, NULL, '2026-10-01T00:00:00.000Z', NULL);
    INSERT INTO api_tokens(id, user_id, token_hash, name, created_at) VALUES ('tk_1', 'us_a', 'hash', 'cli', '2026-10-01T00:00:00.000Z');
    INSERT INTO settings(key, value) VALUES ('other', 'kept');
  `)
}

const TABLES = ['users', 'decks', 'words', 'cards', 'review_logs', 'autofill_usage', 'vocab_tests', 'api_tokens', 'settings', 'sessions', 'login_nonces']
const dump = (db: Db, table: string) => JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
const NEW_USER_COLUMNS = ['weekly_report', 'weekly_report_day', 'weekly_report_time', 'weekly_sent_week', 'weekly_last_estimate', 'request_retention',
  'fsrs_weights', 'fsrs_prev_weights', 'fsrs_trained_at', 'fsrs_reviews_used', 'fsrs_attempted_at', 'fsrs_result']
const without = (rows: Record<string, unknown>[], cols: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))))

describe('migration to v4', () => {
  it('adds the weekly report, FSRS and typeAnswer columns and bot_drafts, keeping every row', () => {
    const db = new DatabaseSync(':memory:')
    v3(db)
    const before = Object.fromEntries(TABLES.map((t) => [t, dump(db, t)]))
    migrate(db, ENV, 4)
    expect(schemaVersion(db)).toBe(4)
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })

    for (const t of TABLES) {
      const after = dump(db, t)
      if (t === 'users') expect(without(after, NEW_USER_COLUMNS)).toEqual(before[t])
      else if (t === 'decks') expect(without(after, ['type_answer'])).toEqual(before[t])
      else expect(after).toEqual(before[t])
    }
    const fresh = { weekly_report: 1, weekly_report_day: 0, weekly_report_time: '19:00', weekly_sent_week: null, weekly_last_estimate: null, request_retention: 0.9,
      fsrs_weights: null, fsrs_prev_weights: null, fsrs_trained_at: null, fsrs_reviews_used: null, fsrs_attempted_at: null, fsrs_result: null }
    expect(dump(db, 'users').map((u: Record<string, unknown>) => Object.fromEntries(NEW_USER_COLUMNS.map((c) => [c, u[c]])))).toEqual([fresh, fresh])
    expect(dump(db, 'bot_drafts')).toEqual([])

    // The app reads it as before, with the new fields.
    expect(getUser(db, 'us_a')).toMatchObject({ name: 'A', eveningReminderTime: '20:00', morningSentDay: '2026-10-21', weeklyReport: true, weeklyReportDay: 0,
      weeklyReportTime: '19:00', requestRetention: 0.9, fsrsWeights: null })
    // The rest of the app reads the current schema (v6: deck kinds, study_cards).
    migrate(db, ENV)
    expect(listDecks(db, 'us_a')).toMatchObject([{ id: 'dk_a', newPerDay: 20, reverseAfterDays: 7, typeAnswer: 'off' }])
    expect(searchWords(db, 'us_b', {}, NOW).words).toMatchObject([{ id: 'wd_2', status: 'active', cards: { reverse: { enabled: false } } }])
    expect(applyReviews(db, 'us_a', [{ id: 'r2', cardId: 'cd_1f', rating: 3, reviewedAt: '2026-10-25T09:00:00.000Z' }])).toMatchObject({ applied: 1 })
    expect(() => db.exec("UPDATE decks SET type_answer = 'sometimes'")).toThrow(/CHECK/)
  })

  it('opens a v3 file in place', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-v4-'))
    const file = path.join(dir, 'recall.db')
    const raw = new DatabaseSync(file)
    v3(raw)
    raw.close()
    const db = openDb(file, ENV)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect((db.prepare('SELECT count(*) AS n FROM words').get() as { n: number }).n).toBe(2)
    db.close()
    fs.rmSync(dir, { recursive: true })
  })
})

describe('migration to v5', () => {
  it('moves the source into the tags and drops the column', () => {
    const db = new DatabaseSync(':memory:')
    v3(db)
    migrate(db, ENV, 4)
    db.exec(`
      INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, source, tags, freq_rank, cefr, status, created_by, dedupe_key, import_ref, created_at, updated_at) VALUES
        ('wd_3', 'us_a', 'dk_a', 'moor', 'noun', '["пустошь"]', NULL, '[]', NULL, 'Wuthering Heights', '["wuthering heights","vocab"]', NULL, NULL, 'active', 'import', 'moor|noun', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
        ('wd_4', 'us_a', 'dk_a', 'bleak', 'adjective', '["мрачный"]', NULL, '[]', NULL, '  ', '[]', NULL, NULL, 'active', 'user', 'bleak|adjective', NULL, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    `)
    const before = dump(db, 'words')
    migrate(db, ENV, 5)
    expect(schemaVersion(db)).toBe(5)
    const after = dump(db, 'words')
    expect(after.every((w: Record<string, unknown>) => !('source' in w))).toBe(true)
    expect(after.map((w: Record<string, unknown>) => [w.id, JSON.parse(w.tags as string)])).toEqual([
      ['wd_1', ['vocab', 'book']], ['wd_2', []], ['wd_3', ['wuthering heights', 'vocab']], ['wd_4', []],
    ])
    expect(without(after, ['tags'])).toEqual(without(before, ['tags', 'source']))
    migrate(db, ENV)
    expect(searchWords(db, 'us_a', { tag: 'book' }, NOW).words.map((w) => w.id)).toEqual(['wd_1'])
  })
})
