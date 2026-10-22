// Renames, deletes or adds tags on every word and fact of one deck (and in
// its review filter), one step or a mapping file of steps, in one transaction.
//   node server/src/retag.ts --db <recall.db> [--user <telegram id>] --deck <name>
//     (--from <tag> --to <tag> [--only-with <tag>] | --delete <tag> [--only-with <tag>] | --map <file.json>) [--dry-run]
// --user defaults to OWNER_TELEGRAM_ID. The mapping file:
//   {"deck"?: "English", "steps": [{from, to} | {delete, exact?} | {add}, each with onlyWith?, source?: 'own'|'pack']}
// (src/tags.ts says what each does); "deck" overrides --deck.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.ts'
import { openDb, type Db } from './db.ts'
import { findDeckByName } from './repo.ts'
import { retagDeck, type TagOp, type TagScope } from './tags.ts'
import { ensureUser, migrationEnv } from './users.ts'

export type RetagStep = (
  | { from: string; to: string }
  | { delete: string; exact?: boolean }
  | { add: string }
) & TagScope

export interface RetagMap {
  // A note for the reader; ignored.
  about?: string
  deck?: string
  steps: RetagStep[]
}

export interface RetagSummary {
  deck: { id: string; name: string }
  steps: { step: RetagStep; cards: number; words: number; facts: number }[]
}

function opOf(s: RetagStep): TagOp {
  const kinds = ['from', 'delete', 'add'].filter((k) => k in s)
  if (kinds.length > 1) throw new Error(`one of from + to, delete or add per step: ${JSON.stringify(s)}`)
  if ('from' in s && 'to' in s) return { kind: 'rename', from: s.from, to: s.to }
  if ('delete' in s) return { kind: 'delete', tag: s.delete, exact: s.exact }
  if ('add' in s) return { kind: 'add', tag: s.add }
  throw new Error(`a step needs from + to, delete or add: ${JSON.stringify(s)}`)
}

const STEP_KEYS = new Set(['from', 'to', 'delete', 'exact', 'add', 'onlyWith', 'source'])

// Validates a parsed mapping file; throws with what is wrong. Unknown keys
// are refused: a misspelt "onlyWith" would silently widen a step.
export function parseRetagMap(data: unknown): RetagMap {
  const o = data as RetagMap
  if (!o || typeof o !== 'object' || !Array.isArray(o.steps) || !o.steps.length) throw new Error('the mapping needs a non-empty "steps" list')
  if (o.deck !== undefined && typeof o.deck !== 'string') throw new Error('"deck" must be a string')
  const extra = Object.keys(o).filter((k) => !['deck', 'steps', 'about'].includes(k))
  if (extra.length) throw new Error(`unknown keys in the mapping: ${extra.join(', ')}`)
  for (const s of o.steps) {
    const bad = Object.keys(s ?? {}).filter((k) => !STEP_KEYS.has(k))
    if (bad.length) throw new Error(`unknown keys ${bad.join(', ')} in step ${JSON.stringify(s)}`)
    const op = opOf(s)
    const strs = Object.entries(s).filter(([k]) => k !== 'exact')
    if (strs.some(([, v]) => typeof v !== 'string')) throw new Error(`tags must be strings: ${JSON.stringify(s)}`)
    if ('exact' in s && op.kind !== 'delete') throw new Error(`exact only goes with delete: ${JSON.stringify(s)}`)
    if (s.source !== undefined && s.source !== 'own' && s.source !== 'pack') throw new Error(`source must be own or pack: ${JSON.stringify(s)}`)
  }
  return o
}

export function retagByName(db: Db, userId: string, deckName: string, steps: RetagStep[], { dryRun = false, now = new Date() } = {}): RetagSummary {
  db.exec('BEGIN IMMEDIATE')
  try {
    const deck = findDeckByName(db, userId, deckName)
    if (!deck) throw new Error(`no deck "${deckName}"`)
    const out: RetagSummary = { deck: { id: deck.id, name: deck.name }, steps: [] }
    for (const step of steps) {
      const r = retagDeck(db, userId, deck.id, opOf(step), { onlyWith: step.onlyWith, source: step.source }, now)
      out.steps.push({ step, cards: r.cards, words: r.words, facts: r.facts })
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function main(argv: string[]) {
  const withValue = new Set(['--db', '--user', '--deck', '--from', '--to', '--only-with', '--delete', '--map'])
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) if (withValue.has(argv[i]!)) values[argv[i]!] = argv[++i] ?? ''
  const cfg = loadConfig(process.env, [])
  const user = values['--user'] ?? (cfg.ownerTelegramId === null ? undefined : String(cfg.ownerTelegramId))
  const onlyWith = values['--only-with']
  let map: RetagMap | null = null
  if (values['--map']) map = parseRetagMap(JSON.parse(readFileSync(values['--map'], 'utf8')))
  else if (values['--from'] && values['--to']) map = { steps: [{ from: values['--from'], to: values['--to'], onlyWith }] }
  else if (values['--delete']) map = { steps: [{ delete: values['--delete'], onlyWith }] }
  const deck = map?.deck ?? values['--deck']
  if (!map || !deck || !user || !/^\d+$/.test(user)) {
    console.error('usage: node server/src/retag.ts --db <recall.db> [--user <telegram id>] --deck <name> (--from <tag> --to <tag> [--only-with <tag>] | --delete <tag> [--only-with <tag>] | --map <file.json>) [--dry-run]')
    process.exit(2)
  }
  const db = openDb(values['--db'] ?? cfg.dbPath, migrationEnv(cfg))
  const target = ensureUser(db, cfg, Number(user), new Date())
  const summary = retagByName(db, target.id, deck, map.steps, { dryRun: argv.includes('--dry-run') })
  db.close()
  console.log(JSON.stringify(summary, null, 2))
  if (argv.includes('--dry-run')) console.log('dry run: nothing written')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
