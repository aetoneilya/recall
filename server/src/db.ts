import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UserDefaults } from './users.ts'
import { vocabularyWords } from './migrate-v3.ts'

export type Db = DatabaseSync

// What a migration may need from the configuration.
export interface MigrationEnv {
  // Who owns the rows that predate users (OWNER_TELEGRAM_ID, or the dev pseudo id).
  ownerTelegramId: number | null
  defaults: UserDefaults
  now?: Date
  // Where pre-migration snapshots go; default <db dir>/backups.
  backupDir?: string
  // Migration progress and summaries; default console.log.
  log?: (line: string) => void
}

const NO_ENV: MigrationEnv = { ownerTelegramId: null, defaults: { timeZone: 'Europe/Moscow', reminderTime: '09:00', eveningReminderTime: null } }

type MigrationFn = (db: Db, env: MigrationEnv) => void
// `before` runs outside the transaction (VACUUM INTO can't run inside one).
type Migration = string | MigrationFn | { before?: MigrationFn; run: MigrationFn }

// Append only: each entry runs once, in order, tracked by PRAGMA user_version.
// Migrations run with foreign keys off (table rebuilds need it) and must
// leave PRAGMA foreign_key_check clean.
export const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE decks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    new_per_day INTEGER NOT NULL DEFAULT 15,
    created_at TEXT NOT NULL
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL REFERENCES decks(id),
    type TEXT NOT NULL,
    fields TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    source TEXT,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX notes_deck_status ON notes(deck_id, status);
  CREATE INDEX notes_dedupe ON notes(deck_id, dedupe_key);
  CREATE INDEX notes_source ON notes(source);
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
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
    UNIQUE(note_id, ordinal)
  );
  CREATE INDEX cards_state_due ON cards(state, due);
  CREATE TABLE review_logs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL,
    duration_ms INTEGER,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL
  );
  CREATE INDEX review_logs_card ON review_logs(card_id, reviewed_at);
  CREATE INDEX review_logs_at ON review_logs(reviewed_at);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    info TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oauth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  multiUser,
  { before: backupBefore(3), run: vocabularyWords },
  // v4: words from the bot (drafts behind inline buttons), the weekly report,
  // per-user FSRS parameters, typed answers per deck. Columns only, no rebuilds.
  `
  ALTER TABLE users ADD COLUMN weekly_report INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN weekly_report_day INTEGER NOT NULL DEFAULT 0 CHECK (weekly_report_day BETWEEN 0 AND 6);
  ALTER TABLE users ADD COLUMN weekly_report_time TEXT NOT NULL DEFAULT '19:00';
  ALTER TABLE users ADD COLUMN weekly_sent_week TEXT;
  ALTER TABLE users ADD COLUMN weekly_last_estimate INTEGER;
  ALTER TABLE users ADD COLUMN request_retention REAL NOT NULL DEFAULT 0.9;
  ALTER TABLE users ADD COLUMN fsrs_weights TEXT;
  ALTER TABLE users ADD COLUMN fsrs_prev_weights TEXT;
  ALTER TABLE users ADD COLUMN fsrs_trained_at TEXT;
  ALTER TABLE users ADD COLUMN fsrs_reviews_used INTEGER;
  ALTER TABLE users ADD COLUMN fsrs_attempted_at TEXT;
  ALTER TABLE users ADD COLUMN fsrs_result TEXT;
  ALTER TABLE decks ADD COLUMN type_answer TEXT NOT NULL DEFAULT 'off' CHECK (type_answer IN ('off', 'reverse', 'both'));
  CREATE TABLE bot_drafts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX bot_drafts_expires ON bot_drafts(expires_at);
  `,
  // v5: a word's source is just a tag; it joins the tags unless already there.
  `
  UPDATE words SET tags = json_insert(tags, '$[#]', substr(trim(source), 1, 100))
    WHERE trim(coalesce(source, '')) <> '' AND json_array_length(tags) < 30
      AND NOT EXISTS (SELECT 1 FROM json_each(words.tags) WHERE lower(value) = lower(trim(words.source)));
  ALTER TABLE words DROP COLUMN source;
  `,
]

// The file a connection works on; '' for :memory:.
export function dbFile(db: Db): string {
  const rows = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]
  return rows.find((r) => r.name === 'main')?.file ?? ''
}

// VACUUM INTO <db dir>/backups/pre-v<N>-<timestamp>.db before a destructive
// migration, unless the database is in memory or holds no notes yet.
function backupBefore(version: number): MigrationFn {
  return (db, env) => {
    const file = dbFile(db)
    if (!file) return
    const hasNotes = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get()
      && db.prepare('SELECT 1 FROM notes LIMIT 1').get()
    if (!hasNotes) return
    const dir = env.backupDir ?? path.join(path.dirname(file), 'backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = (env.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
    const out = path.join(dir, `pre-v${version}-${stamp}.db`)
    db.prepare('VACUUM INTO ?').run(out)
    ;(env.log ?? console.log)(`backup before migration to v${version}: ${out}`)
  }
}

// v2: users. Every deck and note gets a user_id (notes denormalised, kept
// equal to the deck's by a composite foreign key); sessions, OAuth codes
// and tokens are bound to a user. Rows that predate users go to the owner.
function multiUser(db: Db, env: MigrationEnv) {
  const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  const collection = count('decks') + count('notes')
  const now = (env.now ?? new Date()).toISOString()

  db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    time_zone TEXT NOT NULL,
    reminder_time TEXT NOT NULL,
    evening_reminder_time TEXT,
    bot_started_at TEXT,
    morning_sent_day TEXT,
    evening_sent_day TEXT,
    created_at TEXT NOT NULL
  );`)

  let owner: string | null = null
  if (env.ownerTelegramId !== null && (collection > 0 || count('sessions') + count('oauth_tokens') + count('settings') > 0)) {
    owner = newId('us')
    const d = env.defaults
    db.prepare('INSERT INTO users(id, telegram_id, time_zone, reminder_time, evening_reminder_time, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, env.ownerTelegramId, d.timeZone, d.reminderTime, d.eveningReminderTime, now)
    // The bot used to keep one chat and the last reminder days in settings.
    if (getSetting(db, 'telegram_chat_id')) db.prepare('UPDATE users SET bot_started_at = ? WHERE id = ?').run(now, owner)
    db.prepare('UPDATE users SET morning_sent_day = ?, evening_sent_day = ? WHERE id = ?')
      .run(getSetting(db, 'reminder_morning_day'), getSetting(db, 'reminder_evening_day'), owner)
  } else if (collection > 0) {
    throw new Error(
      `the database holds ${count('decks')} decks and ${count('notes')} notes from before users existed; ` +
      'set OWNER_TELEGRAM_ID to the Telegram id they belong to and restart',
    )
  }
  db.exec("DELETE FROM settings WHERE key IN ('telegram_chat_id', 'reminder_morning_day', 'reminder_evening_day')")

  // Create new, copy, drop old, rename: renaming the old table instead would
  // make SQLite repoint the children's foreign keys at it.
  db.exec(`
  CREATE TABLE decks_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    new_per_day INTEGER NOT NULL DEFAULT 15,
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id)
  );
  CREATE TABLE notes_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    deck_id TEXT NOT NULL,
    type TEXT NOT NULL,
    fields TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    created_by TEXT NOT NULL,
    source TEXT,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (deck_id, user_id) REFERENCES decks(id, user_id)
  );
  CREATE TABLE sessions_v2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_tokens_v2 (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at TEXT NOT NULL
  );`)
  db.prepare('INSERT INTO decks_v2(id, user_id, name, description, new_per_day, created_at) SELECT id, ?, name, description, new_per_day, created_at FROM decks').run(owner)
  db.prepare(`INSERT INTO notes_v2(id, user_id, deck_id, type, fields, tags, status, created_by, source, dedupe_key, created_at, updated_at)
    SELECT id, ?, deck_id, type, fields, tags, status, created_by, source, dedupe_key, created_at, updated_at FROM notes`).run(owner)
  if (owner) {
    db.prepare('INSERT INTO sessions_v2(id, user_id, created_at, expires_at) SELECT id, ?, created_at, expires_at FROM sessions').run(owner)
    db.prepare(`INSERT INTO oauth_tokens_v2(token_hash, kind, user_id, client_id, scopes, resource, expires_at)
      SELECT token_hash, kind, ?, client_id, scopes, resource, expires_at FROM oauth_tokens`).run(owner)
  }
  db.exec(`
  DROP TABLE notes;
  DROP TABLE decks;
  DROP TABLE sessions;
  DROP TABLE oauth_tokens;
  DROP TABLE oauth_codes;
  ALTER TABLE decks_v2 RENAME TO decks;
  ALTER TABLE notes_v2 RENAME TO notes;
  ALTER TABLE sessions_v2 RENAME TO sessions;
  ALTER TABLE oauth_tokens_v2 RENAME TO oauth_tokens;

  CREATE UNIQUE INDEX decks_user_name ON decks(user_id, name COLLATE NOCASE);
  CREATE INDEX notes_user_status ON notes(user_id, status, created_at);
  CREATE INDEX notes_deck_status ON notes(deck_id, status);
  CREATE INDEX notes_dedupe ON notes(deck_id, dedupe_key);
  CREATE INDEX notes_source ON notes(user_id, source);
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);

  -- Codes live 10 minutes; in-flight ones from before the upgrade are dropped.
  CREATE TABLE oauth_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT,
    expires_at TEXT NOT NULL
  );
  -- Personal API tokens (Claude Code, scripts).
  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX api_tokens_user ON api_tokens(user_id);
  -- "Log in with Telegram": a nonce confirmed through the bot's /start link.
  CREATE TABLE login_nonces (
    nonce_hash TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    used_at TEXT
  );
  `)
}

export function openDb(path: string, env: MigrationEnv = NO_ENV): Db {
  const db = new DatabaseSync(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL')
  try {
    migrate(db, env)
  } catch (e) {
    db.close()
    throw e
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function schemaVersion(db: Db): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

// Applies pending migrations up to `target`, each in its own transaction.
export function migrate(db: Db, env: MigrationEnv = NO_ENV, target = MIGRATIONS.length) {
  const current = schemaVersion(db)
  if (current >= target) return
  // Can't be changed inside a transaction.
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    for (let v = current; v < target; v++) {
      const m = MIGRATIONS[v]!
      try {
        if (typeof m === 'object') m.before?.(db, env)
        tx(db, () => {
          if (typeof m === 'string') db.exec(m)
          else if (typeof m === 'function') m(db, env)
          else m.run(db, env)
          const broken = db.prepare('PRAGMA foreign_key_check').all()
          if (broken.length) throw new Error(`${broken.length} rows break foreign keys, e.g. ${JSON.stringify(broken[0])}`)
          db.exec(`PRAGMA user_version = ${v + 1}`)
        })
      } catch (e) {
        throw new Error(`database migration to version ${v + 1} failed, nothing was changed: ${(e as Error).message}`, { cause: e })
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

// node:sqlite has no transaction helper. Nested calls join the outer one.
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

// "nt_k3j9x0q2mz" — prefix + 10 base36 chars (~51 bits).
export function newId(prefix: string, length = 10): string {
  const bytes = randomBytes(length)
  let s = ''
  for (const b of bytes) s += ALPHABET[b % 36]
  return `${prefix}_${s}`
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
