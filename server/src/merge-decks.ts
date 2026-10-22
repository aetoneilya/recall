// Merges decks into one, as tags: every word and fact of each source deck
// moves into the target with the source's name as a tag (cards, schedules,
// history and exercise pools kept); duplicates stay behind and are listed;
// emptied sources are deleted.
//   node server/src/merge-decks.ts --db <recall.db> [--user <telegram id>] --into <name> [--create-into] [--no-tag] [--dry-run] <deck name>…
// --user defaults to OWNER_TELEGRAM_ID. --create-into creates the target
// (without languages) when no deck has that name.
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { openDb, type Db } from './db.ts'
import { createDeck, findDeckByName, mergeDecks, type MergeResult } from './repo.ts'
import { ensureUser, migrationEnv } from './users.ts'

export interface MergeSummary {
  into: { name: string; created: boolean }
  merged: MergeResult[]
  // Source names with no such deck.
  missing: string[]
}

export function mergeByName(db: Db, userId: string, into: string, sources: string[], { create = false, tag = true, dryRun = false, now = new Date() } = {}): MergeSummary {
  const out: MergeSummary = { into: { name: into, created: false }, merged: [], missing: [] }
  db.exec('BEGIN IMMEDIATE')
  try {
    let target = findDeckByName(db, userId, into)
    if (!target) {
      if (!create) throw new Error(`no deck "${into}"; pass --create-into to create it`)
      target = createDeck(db, userId, { name: into }, now)
      out.into.created = true
    }
    out.into.name = target.name
    for (const name of sources) {
      const from = findDeckByName(db, userId, name)
      if (!from) {
        out.missing.push(name)
        continue
      }
      out.merged.push(mergeDecks(db, userId, from.id, target.id, { tag }, now))
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return out
}

function main(argv: string[]) {
  const flags = new Set(['--create-into', '--no-tag', '--dry-run'])
  const withValue = new Set(['--db', '--user', '--into'])
  const values: Record<string, string> = {}
  const names: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (withValue.has(a)) values[a] = argv[++i] ?? ''
    else if (!flags.has(a)) names.push(a)
  }
  const cfg = loadConfig(process.env, [])
  const user = values['--user'] ?? (cfg.ownerTelegramId === null ? undefined : String(cfg.ownerTelegramId))
  if (!values['--into'] || !names.length || !user || !/^\d+$/.test(user)) {
    console.error('usage: node server/src/merge-decks.ts --db <recall.db> [--user <telegram id>] --into <name> [--create-into] [--no-tag] [--dry-run] <deck name>…')
    process.exit(2)
  }
  const db = openDb(values['--db'] ?? cfg.dbPath, migrationEnv(cfg))
  const target = ensureUser(db, cfg, Number(user), new Date())
  const summary = mergeByName(db, target.id, values['--into'], names, {
    create: argv.includes('--create-into'), tag: !argv.includes('--no-tag'), dryRun: argv.includes('--dry-run'),
  })
  db.close()
  console.log(JSON.stringify(summary, null, 2))
  if (argv.includes('--dry-run')) console.log('dry run: nothing written')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
