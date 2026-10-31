import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { migrate, openDb, schemaVersion } from '../src/db.ts'
import { createWord, defaultDeck } from '../src/repo.ts'
import { buildQueue } from '../src/study.ts'
import { ensureUser } from '../src/users.ts'
import { TZ } from './helpers.ts'

it('upgrades a v11 collection without changing cards and retains the daily plan after reopening the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-plan-'))
  const file = path.join(dir, 'test.db')
  const now = new Date('2026-10-31T09:00:00Z')
  const env = { ownerTelegramId: null, defaults: { ...TZ, reminderTime: '09:00', eveningReminderTime: null }, now, log: () => {} }
  let db = new DatabaseSync(file)
  try {
    migrate(db, env, 11)
    const user = ensureUser(db, env.defaults, 1001, now)
    const deck = defaultDeck(db, user.id, now)
    for (const [term, cefr] of [['advanced', 'C2'], ['beginner', 'A1']] as const) createWord(db, user.id, {
      deckId: deck.id, word: { term, pos: 'noun', translations: [term], cefr }, status: 'active', createdBy: 'user',
    }, now)
    const before = db.prepare('SELECT * FROM cards ORDER BY id').all()
    migrate(db, env)
    expect(schemaVersion(db)).toBe(12)
    expect(db.prepare('SELECT * FROM cards ORDER BY id').all()).toEqual(before)
    const first = buildQueue(db, user.id, TZ, now).items.map((it) => it.card.id)
    db.close()
    db = openDb(file, env)
    // An edit does not invalidate the snapshot when the process restarts.
    db.prepare("UPDATE words SET cefr = 'A1' WHERE term = 'advanced'").run()
    expect(buildQueue(db, user.id, TZ, now).items.map((it) => it.card.id)).toEqual(first)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.prepare('DELETE FROM words WHERE deck_id = ?').run(deck.id)
    db.prepare('DELETE FROM decks WHERE id = ?').run(deck.id)
    expect(db.prepare('SELECT * FROM daily_new_plans').all()).toEqual([])
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
