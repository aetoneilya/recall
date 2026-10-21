// v2 (flashcards) → v3 (words) on a fixture shaped like the real collection.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, openDb, schemaVersion, type Db } from '../src/db.ts'
import type { V3Report } from '../src/migrate-v3.ts'
import { listDecks, searchWords, wordCards } from '../src/repo.ts'
import { buildQueue, wordLogs } from '../src/study.ts'
import { TZ } from './helpers.ts'

const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null }
const NOW = new Date('2026-10-21T09:00:00Z')
const ENV = { ownerTelegramId: 100001, defaults: DEFAULTS, now: NOW, log: () => {} }

const st = (s: number, reps: number) => JSON.stringify({ due: '2026-10-25T00:00:00.000Z', stability: 5, difficulty: 5, elapsedDays: 1, scheduledDays: 4, learningSteps: 0, reps, lapses: 0, state: s, lastReview: '2026-10-20T00:00:00.000Z' })

// A schema-v2 database: two users, vocabulary in two decks (reversible notes
// with IPA in extra, RU→EN basic rows, a mirrored pair, duplicates across the
// decks), a Q&A deck with Russian answers, cloze notes, an empty deck.
function v2(db: Db) {
  migrate(db, ENV, 2)
  expect(schemaVersion(db)).toBe(2)
  db.exec(`
    INSERT INTO users(id, telegram_id, name, time_zone, reminder_time, created_at) VALUES
      ('us_a', 100001, 'A', 'Europe/Moscow', '09:00', '2026-07-01T00:00:00.000Z'),
      ('us_b', 111, 'B', 'Europe/Moscow', '09:00', '2026-07-01T00:00:00.000Z');
    INSERT INTO decks(id, user_id, name, description, new_per_day, created_at) VALUES
      ('dk_v', 'us_a', 'vocabulary', '', 20, '2026-07-01T00:00:00.000Z'),
      ('dk_e', 'us_a', 'English vocabulary deck', '', 10, '2026-07-02T00:00:00.000Z'),
      ('dk_q', 'us_a', 'Revolut — Concurrency', '', 15, '2026-07-03T00:00:00.000Z'),
      ('dk_r', 'us_a', 'English rules to review', '', 15, '2026-07-04T00:00:00.000Z'),
      ('dk_x', 'us_a', 'e2e test deck', '', 15, '2026-07-05T00:00:00.000Z'),
      ('dk_bv', 'us_b', 'vocabulary', '', 15, '2026-07-06T00:00:00.000Z');
  `)
  const note = db.prepare(`INSERT INTO notes(id, user_id, deck_id, type, fields, tags, status, created_by, source, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, '', ?, ?)`)
  const n = (id: string, user: string, deck: string, type: string, fields: object, tags: string[], at: string, status = 'active', source: string | null = null) =>
    note.run(id, user, deck, type, JSON.stringify(fields), JSON.stringify(tags), status, source, at, at)
  n('nt_r1', 'us_a', 'dk_v', 'reversible', { front: 'to frown', back: 'хмуриться', extra: 'IPA: /fraʊn/' }, ['wuthering heights', 'vocab'], '2026-07-10T00:00:00.000Z', 'active', 'decks:card_a,rcard_a')
  n('nt_r2', 'us_a', 'dk_v', 'reversible', { front: 'everyday (adj.)', back: 'повседневный', extra: '/ˈevrideɪ/' }, ['leon notes (спикинг) — words', 'vocab'], '2026-07-11T00:00:00.000Z')
  n('nt_b1', 'us_a', 'dk_v', 'basic', { front: 'накладные расходы', back: 'overheads', extra: '/ˈəʊvəhedz/' }, ['leon notes (спикинг) — words', 'vocab'], '2026-07-12T00:00:00.000Z')
  n('nt_i1', 'us_a', 'dk_v', 'reversible', { front: 'to streamline', back: 'оптимизировать, упрощать' }, [], '2026-10-20T00:00:00.000Z', 'inbox')
  n('nt_e1', 'us_a', 'dk_e', 'reversible', { front: 'сильная сторона', back: 'forte', extra: 'IPA: /ˈfɔːteɪ/\nне путать с forty' }, ['vocab'], '2026-07-13T00:00:00.000Z')
  n('nt_e2', 'us_a', 'dk_e', 'basic', { front: 'хмуриться, морщить лоб', back: 'to frown' }, ['Russian → English'], '2026-07-14T00:00:00.000Z')
  n('nt_e3', 'us_a', 'dk_e', 'basic', { front: 'forte', back: 'сильная сторона' }, ['English → Russian'], '2026-07-15T00:00:00.000Z')
  n('nt_q1', 'us_a', 'dk_q', 'basic', { front: 'What is a race condition?', back: 'Результат зависит от планировщика потоков' }, [], '2026-07-16T00:00:00.000Z')
  n('nt_q2', 'us_a', 'dk_q', 'basic', { front: 'Checked vs unchecked exceptions', back: '`Error` — **не ловить**' }, [], '2026-07-17T00:00:00.000Z')
  n('nt_c1', 'us_a', 'dk_r', 'cloze', { front: 'I am {{c1::well}}, thanks. (о состоянии)', back: '' }, ['Word choice'], '2026-07-18T00:00:00.000Z')
  n('nt_bf', 'us_b', 'dk_bv', 'basic', { front: 'to frown', back: 'хмуриться' }, [], '2026-07-19T00:00:00.000Z')
  n('nt_bc', 'us_b', 'dk_bv', 'cloze', { front: 'The {{c1::JVM}} runs bytecode', back: '' }, [], '2026-07-20T00:00:00.000Z')

  const card = db.prepare(`INSERT INTO cards(id, note_id, ordinal, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review)
    VALUES (?, ?, ?, ?, ?, ?, 5, 1, 4, 0, ?, ?, ?, ?)`)
  const fresh = (id: string, nt: string, ord: number) => card.run(id, nt, ord, 0, '2026-07-10T00:00:00.000Z', 0, 0, 0, 0, null)
  const seen = (id: string, nt: string, ord: number, reps: number, stability = 5, suspended = 0) =>
    card.run(id, nt, ord, suspended, '2026-10-25T00:00:00.000Z', stability, reps, 1, 2, '2026-10-20T00:00:00.000Z')
  seen('cd_r1a', 'nt_r1', 0, 2, 30)
  fresh('cd_r1b', 'nt_r1', 1)
  seen('cd_r2a', 'nt_r2', 0, 1, 3, 1)
  fresh('cd_r2b', 'nt_r2', 1)
  fresh('cd_b1', 'nt_b1', 0)
  seen('cd_e1a', 'nt_e1', 0, 1)
  seen('cd_e1b', 'nt_e1', 1, 2)
  seen('cd_e2', 'nt_e2', 0, 3)
  seen('cd_e3', 'nt_e3', 0, 1)
  seen('cd_q1', 'nt_q1', 0, 1)
  fresh('cd_q2', 'nt_q2', 0)
  seen('cd_c1', 'nt_c1', 1, 1)
  seen('cd_bf', 'nt_bf', 0, 1)
  fresh('cd_bc', 'nt_bc', 1)

  const log = db.prepare(`INSERT INTO review_logs(id, card_id, rating, reviewed_at, duration_ms, "before", "after") VALUES (?, ?, 3, ?, 4000, ?, ?)`)
  let i = 0
  const logs = (cardId: string, k: number) => {
    for (let j = 0; j < k; j++) log.run(`log_${++i}`, cardId, `2026-10-${10 + j}T09:00:00.000Z`, st(j ? 2 : 0, j), st(2, j + 1))
  }
  logs('cd_r1a', 2)
  logs('cd_r2a', 1)
  logs('cd_e1a', 1)
  logs('cd_e1b', 2)
  logs('cd_e2', 3)
  logs('cd_e3', 1)
  logs('cd_q1', 1)
  logs('cd_c1', 1)
  logs('cd_bf', 1)
}

const all = (db: Db, sql: string, ...args: string[]) => JSON.parse(JSON.stringify(db.prepare(sql).all(...args)))
const STATE = 'id, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review'

describe('migration to words (v2 → v3)', () => {
  it('turns vocabulary into words, keeps card states and logs per direction, merges duplicates and drops the rest', () => {
    const db = new DatabaseSync(':memory:')
    v2(db)
    const before = new Map(all(db, `SELECT ${STATE} FROM cards`).map((c: { id: string }) => [c.id, c]))
    const logsBefore = all(db, 'SELECT * FROM review_logs ORDER BY id')

    migrate(db, ENV)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('notes', 'decks_v3', 'cards_v3')").all()).toEqual([])

    // One English deck per user; newPerDay = the largest of the vocabulary decks'.
    expect(listDecks(db, 'us_a')).toMatchObject([{ name: 'English', targetLang: 'en', nativeLang: 'ru', newPerDay: 20, forwardEnabled: true, reverseEnabled: true, reverseAfterDays: null }])
    expect(listDecks(db, 'us_b')).toMatchObject([{ name: 'English', newPerDay: 15 }])

    const words = searchWords(db, 'us_a', { sort: 'alpha', limit: 100 }, NOW).words
    expect(words.map((w) => [w.term, w.pos, w.status])).toEqual([
      ['everyday', 'adjective', 'active'],
      ['forte', 'other', 'active'],
      ['overheads', 'other', 'active'],
      ['to frown', 'verb', 'active'],
      ['to streamline', 'verb', 'inbox'],
    ])
    const w = (term: string) => words.find((x) => x.term === term)!
    const cards = (term: string) => Object.fromEntries(wordCards(db, 'us_a', w(term).id).map((c) => [c.direction, c.id]))

    // Merged across decks: translations unioned, the card with more history kept per direction.
    expect(w('to frown')).toMatchObject({ translations: ['хмуриться', 'морщить лоб'], ipa: 'fraʊn', tags: ['wuthering heights', 'vocab'], createdAt: '2026-07-10T00:00:00.000Z' })
    expect(cards('to frown')).toEqual({ forward: 'cd_r1a', reverse: 'cd_e2' })
    // A Russian front (reversible or basic) means ordinal 0 was the reverse direction.
    expect(cards('forte')).toEqual({ forward: 'cd_e1b', reverse: 'cd_e1a' })
    expect(w('forte')).toMatchObject({ ipa: 'ˈfɔːteɪ', note: 'не путать с forty', translations: ['сильная сторона'], tags: ['vocab'] })
    expect(w('everyday')).toMatchObject({ ipa: 'ˈevrideɪ', tags: expect.arrayContaining(['leon notes (спикинг) — words']) })
    expect(cards('everyday')).toEqual({ forward: 'cd_r2a', reverse: 'cd_r2b' })
    // RU→EN basic: its card is the reverse one; forward is new.
    expect(cards('overheads').reverse).toBe('cd_b1')
    expect(wordCards(db, 'us_a', w('overheads').id)[0]!.schedule.state).toBe(0)
    expect(w('to streamline').translations).toEqual(['оптимизировать', 'упрощать'])
    expect(wordCards(db, 'us_a', w('to streamline').id).map((c) => c.schedule.state)).toEqual([0, 0])

    // Kept cards are byte-identical (state, suspension), logs follow them.
    for (const id of ['cd_r1a', 'cd_e2', 'cd_e1a', 'cd_e1b', 'cd_r2a', 'cd_r2b', 'cd_b1']) {
      expect(all(db, `SELECT ${STATE} FROM cards WHERE id = ?`, id)[0]).toEqual(before.get(id))
    }
    expect(wordCards(db, 'us_a', w('everyday').id)[0]!.suspended).toBe(true)
    const kept = new Set(['cd_r1a', 'cd_r2a', 'cd_e1a', 'cd_e1b', 'cd_e2', 'cd_bf'])
    expect(all(db, 'SELECT * FROM review_logs ORDER BY id')).toEqual(logsBefore.filter((l: { card_id: string }) => kept.has(l.card_id)))
    expect(wordLogs(db, 'us_a', w('to frown').id).map((l) => l.cardId).sort()).toEqual(['cd_e2', 'cd_e2', 'cd_e2', 'cd_r1a', 'cd_r1a'])

    // The second user is migrated on their own: no merge with A's frown.
    const b = searchWords(db, 'us_b', {}, NOW).words
    expect(b.map((x) => [x.term, x.pos])).toEqual([['to frown', 'verb']])
    expect(Object.fromEntries(wordCards(db, 'us_b', b[0]!.id).map((c) => [c.direction, c.id]))).toMatchObject({ forward: 'cd_bf' })
    expect(wordLogs(db, 'us_b', b[0]!.id)).toHaveLength(1)

    const report = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'migration.v3'").get() as { value: string }).value) as V3Report
    expect(report).toMatchObject({
      users: 2,
      decksCreated: 2,
      words: 6,
      wordsByStatus: { active: 5, inbox: 1 },
      cards: { forward: 6, reverse: 6, created: 4 },
      deleted: { notes: 4, notesByReason: { cloze: 2, 'basic outside vocabulary decks': 2 }, decks: 6 },
      logs: { before: 13, kept: 10, dropped: 3, droppedInMerges: 1 },
    })
    expect(report.merges.map((m) => [m.term, m.kept, m.droppedCards])).toEqual([
      ['to frown', { forward: 'cd_r1a', reverse: 'cd_e2' }, ['cd_r1b']],
      ['forte', { forward: 'cd_e1b', reverse: 'cd_e1a' }, ['cd_e3']],
    ])

    // The collection is studyable: the frown cards are not due, the new ones are.
    const q = buildQueue(db, 'us_a', TZ, NOW)
    expect(q.items.every((i) => i.word.status === 'active')).toBe(true)
    expect(q.counts.new).toBeGreaterThan(0)
  })

  it('takes a backup before migrating a file database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-v3-'))
    const file = path.join(dir, 'recall.db')
    const raw = new DatabaseSync(file)
    v2(raw)
    raw.close()
    const db = openDb(file, ENV)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    db.close()
    const backups = fs.readdirSync(path.join(dir, 'backups'))
    expect(backups).toEqual([`pre-v3-${NOW.toISOString().replace(/[:.]/g, '-')}.db`])
    const snap = new DatabaseSync(path.join(dir, 'backups', backups[0]!), { readOnly: true })
    expect(schemaVersion(snap)).toBe(2)
    expect((snap.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(12)
    snap.close()
    fs.rmSync(dir, { recursive: true })
  })
})
