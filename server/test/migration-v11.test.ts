// v10 → v11: the bot's allowlist and access requests are new tables; users
// get onboarded / coach_seen, set for everyone who already has cards.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, MIGRATIONS, schemaVersion, type Db } from '../src/db.ts'
import { getUser } from '../src/users.ts'
import { listen, makeCtx, send } from './helpers.ts'

const DEFAULTS = { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null }
const ENV = { ownerTelegramId: 100001, defaults: DEFAULTS, now: new Date('2026-10-21T09:00:00Z'), log: () => {} }
const T = '2026-10-01T00:00:00.000Z'

function v10(db: Db) {
  migrate(db, ENV, 10)
  expect(schemaVersion(db)).toBe(10)
  db.exec(`
    INSERT INTO users(id, telegram_id, name, time_zone, reminder_time, evening_reminder_time, created_at) VALUES
      ('us_words', 100001, 'A', 'Europe/Moscow', '09:00', NULL, '${T}'),
      ('us_facts', 111, 'B', 'Europe/Moscow', '09:00', NULL, '${T}'),
      ('us_new', 222, 'C', 'Europe/Moscow', '09:00', NULL, '${T}');
    INSERT INTO decks(id, user_id, name, target_lang, native_lang, new_per_day, forward_enabled, reverse_enabled, reverse_after_days, type_answer, created_at) VALUES
      ('dk_a', 'us_words', 'English', 'en', 'ru', 15, 1, 1, NULL, 'off', '${T}'),
      ('dk_b', 'us_facts', 'Notes', NULL, NULL, 5, 1, 1, NULL, 'off', '${T}'),
      ('dk_c', 'us_new', 'English', 'en', 'ru', 15, 1, 1, NULL, 'off', '${T}');
    INSERT INTO words(id, user_id, deck_id, term, pos, translations, ipa, examples, note, tags, freq_rank, cefr, status, created_by, dedupe_key, import_ref, created_at, updated_at) VALUES
      ('wd_1', 'us_words', 'dk_a', 'to frown', 'verb', '["хмуриться"]', NULL, '[]', NULL, '[]', NULL, NULL, 'rejected', 'user', 'frown|verb', NULL, '${T}', '${T}');
    INSERT INTO facts(id, user_id, deck_id, front, back, tags, status, created_by, dedupe_key, import_ref, created_at, updated_at) VALUES
      ('ft_1', 'us_facts', 'dk_b', 'Q?', 'A', '[]', 'active', 'user', 'q', NULL, '${T}', '${T}');
  `)
}

describe('migration to v11', () => {
  it('marks everyone with cards as onboarded and adds the access tables', () => {
    const db = new DatabaseSync(':memory:')
    v10(db)
    const before = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY rowid').all()))
    migrate(db, ENV, 11)
    expect(schemaVersion(db)).toBe(11)
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(11)
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const after = db.prepare('SELECT id, onboarded, coach_seen FROM users ORDER BY rowid').all()
    expect(after.map((r) => ({ ...r }))).toEqual([
      { id: 'us_words', onboarded: 1, coach_seen: 1 },
      { id: 'us_facts', onboarded: 1, coach_seen: 1 },
      { id: 'us_new', onboarded: 0, coach_seen: 0 },
    ])
    // Nothing else about the users changed.
    const rows = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM users ORDER BY rowid').all())) as Record<string, unknown>[]
    expect(rows.map(({ onboarded: _o, coach_seen: _c, ...r }) => r)).toEqual(before)
    expect(getUser(db, 'us_new')).toMatchObject({ onboarded: false, coachSeen: false })
    expect(db.prepare('SELECT count(*) AS n FROM allowed_users').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT count(*) AS n FROM access_requests').get()).toEqual({ n: 0 })
  })
})

describe('the onboarded flags in /api/me', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('starts false for a new account and is set with PATCH', async () => {
    const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' })
    const s = await listen(ctx)
    close = s.close
    expect(await (await fetch(`${s.url}/api/me`)).json()).toMatchObject({ onboarded: false, coachSeen: false })
    const r = await send(`${s.url}/api/me`, 'PATCH', { onboarded: true })
    expect(await r.json()).toMatchObject({ onboarded: true, coachSeen: false })
    expect(await (await send(`${s.url}/api/me`, 'PATCH', { coachSeen: true })).json()).toMatchObject({ onboarded: true, coachSeen: true })
    expect((await send(`${s.url}/api/me`, 'PATCH', { onboarded: 'yes' })).status).toBe(400)
  })
})
