// Imports grammar rules with exercise pools (a JSON file kept outside the
// repo: the owner's private notes) into one user's topic deck.
//   node server/src/import-exercises.ts --file <rules.json> --db <recall.db> [--user <telegram id>] [--deck <name>] [--tag "Grammar"] [--replace] [--dry-run]
// A file is a list of rules {id, group, title, rule (Markdown), fromNotes:
// string[], items}. Items are tap items — {type: 'choose', text, options,
// answer, explain} or {type: 'spot', text, wrong, options, answer, explain} —
// or legacy typed ones {type: gap|fix|rewrite, prompt, answer, accepted,
// explain}. Next to rules.json, rules.choice.json (then rules.reviewed.json)
// is read instead when it exists.
//
// One fact per rule, into --deck (default: the English deck): front = title;
// back = the rule, then "From your notes" as a list (Obsidian ==highlights==
// become bold); tags = [--tag ("Grammar"), group];
// import_ref rules:<id>. Its items go to the pool with import_ref
// <id>:tap:<n> (tap items) or <id>:<n> (legacy). Idempotent: a rule already
// imported keeps its fact as it is and only gets the items it lacks; new
// rules are added. New cards come in file order. --replace: an imported
// rule's legacy typed items are flagged out of the pool before its new ones
// go in; the fact, its card, schedule and history stay.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isTapType, type ExerciseInput } from '@recall/core'
import { loadConfig } from './config.ts'
import { openDb, type Db } from './db.ts'
import { addExercises } from './exercises.ts'
import { createFact } from './facts.ts'
import { createDeck, defaultDeck, findDeckByName } from './repo.ts'
import { ensureUser, migrationEnv } from './users.ts'

export interface RuleFile {
  id: string
  group: string
  title: string
  rule: string
  fromNotes: string[]
  items: ExerciseInput[]
}

export interface ExerciseImportSummary {
  deck: { name: string; created: boolean }
  rules: { created: number; existing: number }
  exercises: { created: number; existing: number; duplicates: number; replaced: number; invalid: { rule: string; index: number; error: string }[] }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

// Validates the file's shape; throws with the first problem.
export function parseRules(data: unknown): RuleFile[] {
  if (!Array.isArray(data) || !data.length) throw new Error('expected a non-empty list of rules')
  const seen = new Set<string>()
  return data.map((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>
    const where = `rule ${i}${isStr(r.id) ? ` (${r.id})` : ''}`
    if (!isStr(r.id) || !isStr(r.title) || !isStr(r.rule)) throw new Error(`${where}: id, title and rule are required`)
    if (seen.has(r.id)) throw new Error(`${where}: id appears twice`)
    seen.add(r.id)
    if (!Array.isArray(r.items)) throw new Error(`${where}: items must be a list`)
    return {
      id: r.id,
      group: isStr(r.group) ? r.group.trim() : '',
      title: r.title.trim(),
      rule: r.rule.trim(),
      fromNotes: Array.isArray(r.fromNotes) ? r.fromNotes.filter(isStr).map((n) => n.trim()) : [],
      items: r.items as ExerciseInput[],
    }
  })
}

// The fact's answer side: the rule, then where it came from.
export function ruleBack(r: RuleFile): string {
  if (!r.fromNotes.length) return r.rule
  const notes = r.fromNotes.map((n) => `- ${n.replace(/==([^=\n]+)==/g, '**$1**')}`)
  return `${r.rule}\n\n**From your notes**\n${notes.join('\n')}`
}

// Rules go into `deckName` (made if missing, without languages) or, by
// default, the user's English deck; each is tagged `tag` ("Grammar") and its group.
export function importExercises(db: Db, userId: string, rules: RuleFile[], { deckName = '', tag = 'Grammar', dryRun = false, replace = false, now = new Date() } = {}): ExerciseImportSummary {
  const s: ExerciseImportSummary = {
    deck: { name: deckName, created: false },
    rules: { created: 0, existing: 0 },
    exercises: { created: 0, existing: 0, duplicates: 0, replaced: 0, invalid: [] },
  }
  const flagLegacy = db.prepare("UPDATE fact_exercises SET status = 'flagged' WHERE fact_id = ? AND status = 'active' AND type IN ('gap', 'fix', 'rewrite')")
  db.exec('BEGIN IMMEDIATE')
  try {
    let found = deckName ? findDeckByName(db, userId, deckName) : defaultDeck(db, userId, now)
    if (!found) {
      found = createDeck(db, userId, { name: deckName }, now)
      s.deck.created = true
    }
    const deck = found
    s.deck.name = deck.name
    const factOf = db.prepare('SELECT id FROM facts WHERE user_id = ? AND import_ref = ?')
    const haveRef = db.prepare('SELECT 1 FROM fact_exercises WHERE fact_id = ? AND import_ref = ?')
    rules.forEach((r, i) => {
      const ref = `rules:${r.id}`
      let factId = (factOf.get(userId, ref) as { id: string } | undefined)?.id
      if (factId) {
        s.rules.existing++
        // Only a rule that brings tap items gives up its typed ones.
        if (replace && r.items.some((it) => isTapType(it.type))) s.exercises.replaced += Number(flagLegacy.run(factId).changes)
      } else {
        factId = createFact(db, userId, {
          deckId: deck.id, fact: { front: r.title, back: ruleBack(r), tags: [...new Set([tag, r.group].filter(Boolean))] }, status: 'active', createdBy: 'import',
          importRef: ref, createdAt: new Date(now.getTime() + i),
        }, now).fact.id
        s.rules.created++
      }
      const fresh: (ExerciseInput & { importRef: string })[] = []
      r.items.forEach((it, n) => {
        const itemRef = isTapType(it.type) ? `${r.id}:tap:${n}` : `${r.id}:${n}`
        if (haveRef.get(factId, itemRef)) s.exercises.existing++
        else fresh.push({ ...it, importRef: itemRef })
      })
      if (!fresh.length) return
      const out = addExercises(db, userId, factId, fresh, 'import', now)
      s.exercises.created += out.created.length
      s.exercises.duplicates += out.duplicates.length
      for (const e of out.errors) s.exercises.invalid.push({ rule: r.id, index: Number(fresh[e.index]!.importRef.split(':').at(-1)), error: e.error })
    })
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return s
}

// rules.json → rules.choice.json, else rules.reviewed.json, when they exist;
// a path naming one of those is read as given.
export function preferReviewed(file: string): string {
  if (/\.(choice|reviewed)\.json$/.test(file)) return file
  const base = path.join(path.dirname(file), path.basename(file, '.json'))
  for (const v of [`${base}.choice.json`, `${base}.reviewed.json`]) if (fs.existsSync(v)) return v
  return file
}

function main(argv: string[]) {
  const arg = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const given = arg('--file')
  const cfg = loadConfig(process.env, [])
  const user = arg('--user') ?? (cfg.ownerTelegramId === null ? undefined : String(cfg.ownerTelegramId))
  if (!given || !user || !/^\d+$/.test(user)) {
    console.error('usage: node server/src/import-exercises.ts --file <rules.json> --db <recall.db> [--user <telegram id>] [--deck <name>] [--tag "Grammar"] [--replace] [--dry-run]')
    console.error('--user defaults to OWNER_TELEGRAM_ID; <name>.choice.json, then <name>.reviewed.json next to the file is preferred;')
    console.error('--replace flags out the legacy typed items of rules already imported before adding the new ones')
    process.exit(2)
  }
  const file = preferReviewed(given)
  if (file !== given) console.error(`reading the reviewed copy ${file}`)
  const rules = parseRules(JSON.parse(fs.readFileSync(file, 'utf8')))
  const db = openDb(arg('--db') ?? cfg.dbPath, migrationEnv(cfg))
  const target = ensureUser(db, cfg, Number(user), new Date())
  console.error(`importing ${rules.length} rules into user ${target.id} (Telegram ${target.telegramId})`)
  const summary = importExercises(db, target.id, rules, { deckName: arg('--deck') ?? '', tag: arg('--tag') ?? 'Grammar', dryRun: argv.includes('--dry-run'), replace: argv.includes('--replace') })
  db.close()
  console.log(JSON.stringify(summary, null, 2))
  if (argv.includes('--dry-run')) console.log('dry run: nothing written')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
