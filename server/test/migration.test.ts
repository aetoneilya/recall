import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sessionUserId, sha256, verifyBearer } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { migrate, MIGRATIONS, openDb, schemaVersion, type Db } from '../src/db.ts'
import { ensureUser, getUserByTelegramId, listUsers } from '../src/users.ts'

const OWNER = 100001
const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: '20:00' }
const NOW = new Date('2026-10-21T09:00:00Z')
const state = (due: string, s: number) =>
  JSON.stringify({ due, stability: 3.1, difficulty: 5.2, elapsedDays: 1, scheduledDays: 3, learningSteps: 0, reps: 2, lapses: 1, state: s, lastReview: '2026-10-18T09:00:00.000Z' })

// A database as the single-user server (schema version 1) left it.
function v1(db: Db) {
  migrate(db, undefined, 1)
  expect(schemaVersion(db)).toBe(1)
  db.exec(`
    INSERT INTO decks VALUES ('dk_en', 'English', 'words', 10, '2026-07-01T00:00:00.000Z'), ('dk_sys', 'System design', '', 15, '2026-07-02T00:00:00.000Z');
    INSERT INTO notes VALUES
      ('nt_1', 'dk_en', 'reversible', '{"front":"to frown","back":"хмуриться"}', '["wuthering heights"]', 'active', 'import', 'decks:a,b', 'to frown', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
      ('nt_2', 'dk_sys', 'basic', '{"front":"What is a deadlock?","back":"Threads wait forever"}', '[]', 'active', 'user', NULL, 'what is a deadlock?', '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z'),
      ('nt_3', 'dk_sys', 'basic', '{"front":"CAP","back":"pick two"}', '[]', 'inbox', 'claude', NULL, 'cap', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
    INSERT INTO cards VALUES
      ('cd_1a', 'nt_1', 0, 0, '2026-10-21T05:00:00.000Z', 3.1, 5.2, 1, 3, 0, 2, 1, 2, '2026-10-18T09:00:00.000Z'),
      ('cd_1b', 'nt_1', 1, 1, '2026-11-01T00:00:00.000Z', 9.5, 4.0, 2, 10, 0, 3, 0, 2, '2026-10-10T09:00:00.000Z'),
      ('cd_2', 'nt_2', 0, 0, '2026-07-03T00:00:00.000Z', 0, 0, 0, 0, 0, 0, 0, 0, NULL);
    INSERT INTO review_logs VALUES
      ('log_1', 'cd_1a', 3, '2026-10-15T09:00:00.000Z', 4000, '${state('2026-10-15T09:00:00.000Z', 0)}', '${state('2026-10-18T09:00:00.000Z', 2)}'),
      ('log_2', 'cd_1a', 1, '2026-10-18T09:00:00.000Z', NULL, '${state('2026-10-18T09:00:00.000Z', 2)}', '${state('2026-10-21T05:00:00.000Z', 2)}');
    INSERT INTO sessions VALUES ('${sha256('cookie-token')}', '2026-10-01T00:00:00.000Z', '2026-12-30T00:00:00.000Z');
    INSERT INTO oauth_clients VALUES ('client-1', '{"client_id":"client-1","redirect_uris":["https://claude.ai/cb"]}', '2026-10-01T00:00:00.000Z');
    INSERT INTO oauth_codes VALUES ('code-hash', 'client-1', 'challenge', 'https://claude.ai/cb', '', NULL, '2026-10-21T09:05:00.000Z');
    INSERT INTO oauth_tokens VALUES
      ('${sha256('access-token')}', 'access', 'client-1', '', 'https://cards.example.com/mcp', '2026-10-21T10:00:00.000Z'),
      ('${sha256('refresh-token')}', 'refresh', 'client-1', '', NULL, '2027-01-01T00:00:00.000Z');
    INSERT INTO settings VALUES ('telegram_chat_id', '${OWNER}'), ('reminder_morning_day', '2026-10-21'), ('reminder_evening_day', '2026-10-20'), ('other', 'kept');
  `)
}

const all = (db: Db, sql: string) => JSON.parse(JSON.stringify(db.prepare(sql).all()))
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

describe('migration to multi-user (v1 → v2)', () => {
  it('assigns every existing row to the owner and loses nothing', () => {
    const db = new DatabaseSync(':memory:')
    v1(db)
    const before = {
      cards: all(db, 'SELECT * FROM cards ORDER BY id'),
      logs: all(db, 'SELECT * FROM review_logs ORDER BY id'),
      notes: all(db, 'SELECT * FROM notes ORDER BY id'),
      decks: all(db, 'SELECT * FROM decks ORDER BY id'),
      clients: all(db, 'SELECT * FROM oauth_clients'),
    }

    migrate(db, { ownerTelegramId: OWNER, defaults: DEFAULTS, now: NOW }, 2)
    expect(schemaVersion(db)).toBe(2)
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })

    const users = listUsers(db)
    expect(users).toHaveLength(1)
    const owner = users[0]!
    expect(owner).toMatchObject({
      telegramId: OWNER, timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: '20:00',
      botStartedAt: NOW.toISOString(), morningSentDay: '2026-10-21', eveningSentDay: '2026-10-20',
    })

    // Same rows, plus user_id.
    expect(all(db, 'SELECT * FROM cards ORDER BY id')).toEqual(before.cards)
    expect(all(db, 'SELECT * FROM review_logs ORDER BY id')).toEqual(before.logs)
    expect(all(db, 'SELECT * FROM notes ORDER BY id')).toEqual(before.notes.map((n: object) => ({ ...n, user_id: owner.id })))
    expect(all(db, 'SELECT * FROM decks ORDER BY id')).toEqual(before.decks.map((d: object) => ({ ...d, user_id: owner.id })))
    expect(all(db, 'SELECT * FROM oauth_clients')).toEqual(before.clients)

    // Sessions and OAuth tokens still work, as the owner; pending codes are dropped.
    expect(sessionUserId(db, 'cookie-token', NOW)).toBe(owner.id)
    const ctx = { db, cfg: loadConfig({ OWNER_TELEGRAM_ID: String(OWNER) }, []), now: () => NOW, telegram: { botUsername: null } }
    expect(verifyBearer(ctx, 'access-token')).toMatchObject({ kind: 'oauth', user: { id: owner.id }, resource: 'https://cards.example.com/mcp' })
    expect(all(db, "SELECT kind, user_id FROM oauth_tokens ORDER BY kind")).toEqual([{ kind: 'access', user_id: owner.id }, { kind: 'refresh', user_id: owner.id }])
    expect(count(db, 'oauth_codes')).toBe(0)
    expect(all(db, 'SELECT * FROM settings')).toEqual([{ key: 'other', value: 'kept' }])

    // Deck names are unique per user now, case-insensitively.
    const other = ensureUser(db, DEFAULTS, 111, NOW)
    db.prepare("INSERT INTO decks(id, user_id, name, created_at) VALUES ('dk_o', ?, 'english', '')").run(other.id)
    expect(() => db.prepare("INSERT INTO decks(id, user_id, name, created_at) VALUES ('dk_x', ?, 'ENGLISH', '')").run(owner.id)).toThrow(/UNIQUE/)
    // A note can't point at another user's deck.
    expect(() => db.prepare(`INSERT INTO notes(id, user_id, deck_id, type, fields, status, created_by, dedupe_key, created_at, updated_at)
      VALUES ('nt_x', ?, 'dk_en', 'basic', '{}', 'active', 'user', 'x', '', '')`).run(other.id)).toThrow(/FOREIGN KEY/)
    // Cascades survived the rebuild.
    db.prepare("DELETE FROM notes WHERE id = 'nt_1'").run()
    expect(count(db, 'cards')).toBe(1)
    expect(count(db, 'review_logs')).toBe(0)
  })

  it('refuses to start without OWNER_TELEGRAM_ID when there is data, changing nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-mig-'))
    const file = path.join(dir, 'recall.db')
    const db = new DatabaseSync(file)
    v1(db)
    db.close()
    expect(() => openDb(file, { ownerTelegramId: null, defaults: DEFAULTS, backupDir: path.join(dir, 'backups') })).toThrow(/version 2 failed, nothing was changed: .*2 decks and 3 notes.*set OWNER_TELEGRAM_ID/)
    const again = new DatabaseSync(file)
    expect(schemaVersion(again)).toBe(1)
    expect(count(again, 'notes')).toBe(3)
    expect(count(again, 'settings')).toBe(4)
    again.close()

    // With the owner set, the same file opens, migrated (on to the latest version), with foreign keys on.
    const ok = openDb(file, { ownerTelegramId: OWNER, defaults: DEFAULTS, backupDir: path.join(dir, 'backups'), log: () => {} })
    expect(schemaVersion(ok)).toBe(MIGRATIONS.length)
    expect(ok.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(getUserByTelegramId(ok, OWNER)).not.toBeNull()
    // to frown (reversible) is a word; the Q&A notes are gone.
    expect(count(ok, 'words')).toBe(1)
    ok.close()
    fs.rmSync(dir, { recursive: true })
  })

  it('migrates an empty database without an owner', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, undefined, 1)
    migrate(db, { ownerTelegramId: null, defaults: DEFAULTS })
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(count(db, 'users')).toBe(0)
    expect(count(db, 'decks')).toBe(0)
  })
})

