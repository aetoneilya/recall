// Content packs: ready-made topic decks shipped as server/data/packs/*.json.
// A pack file describes itself — {id, name, description, kind: 'topic',
// format, items} — and its format says how items become facts:
//   'facts'            items are {key, front, back, tags?} (Markdown), as is;
//   'irregular-verbs'  items are {verb, past[], participle[], translation,
//                      example: {text, translation}, note, rank}; the fact's
//                      Markdown is generated here, and the verbs' forms are
//                      shown on matching word cards (verbForms).
// Items are in the order cards should be introduced (most frequent first).
// No database access here: repo.ts uses verbForms for word items, packs.ts
// adds packs to a user's collection.
import fs from 'node:fs'
import path from 'node:path'
import { formsLine, normalizeTerm, type PartOfSpeech, type VerbForms } from '@recall/core'
import { DEFAULT_DATA_DIR } from './config.ts'

export interface PackFact {
  // Stable within the pack: import_ref is `pack:<id>:<key>`.
  key: string
  front: string
  back: string
  tags: string[]
}

export interface IrregularVerb {
  verb: string
  past: string[]
  participle: string[]
  translation: string
  example: { text: string; translation: string | null }
  note: string | null
  rank: number | null
}

export interface Pack {
  id: string
  name: string
  description: string
  kind: 'topic'
  format: 'facts' | 'irregular-verbs'
  facts: PackFact[]
  // format 'irregular-verbs' only: by verb.
  verbs: Map<string, IrregularVerb> | null
}

export const PACK_FORMATS = ['facts', 'irregular-verbs'] as const

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isStr)
// Generated Markdown must not pick up formatting from the data.
const MARKUP = /[*_`#<>]|\[\[/

// The fact of one irregular verb: front = the verb in bold over its
// translation; back = the forms as one bold line (the card shows a lone bold
// first line large), the example in italics with its translation, the note.
export function irregularVerbFact(v: IrregularVerb): PackFact {
  const back = [`**${formsLine(v)}**`, `*${v.example.text}*${v.example.translation ? `\n${v.example.translation}` : ''}`]
  if (v.note) back.push(v.note)
  return { key: v.verb, front: `**to ${v.verb}**\n${v.translation}`, back: back.join('\n\n'), tags: [] }
}

function irregularVerb(x: unknown, i: number): IrregularVerb {
  const o = (x ?? {}) as Record<string, unknown>
  const where = `item ${i}${isStr(o.verb) ? ` (${o.verb})` : ''}`
  if (!isStr(o.verb) || !/^[a-z]+$/.test(o.verb)) throw new Error(`${where}: verb must be one lowercase word`)
  if (!strings(o.past) || !strings(o.participle)) throw new Error(`${where}: past and participle must be non-empty lists of forms`)
  if (!isStr(o.translation)) throw new Error(`${where}: translation is missing`)
  const ex = (o.example ?? {}) as Record<string, unknown>
  if (!isStr(ex.text)) throw new Error(`${where}: example.text is missing`)
  if (o.note !== null && o.note !== undefined && typeof o.note !== 'string') throw new Error(`${where}: note must be a string or null`)
  const v: IrregularVerb = {
    verb: o.verb,
    past: (o.past as string[]).map((s) => s.trim()),
    participle: (o.participle as string[]).map((s) => s.trim()),
    translation: o.translation.trim(),
    example: { text: ex.text.trim(), translation: isStr(ex.translation) ? ex.translation.trim() : null },
    note: isStr(o.note) ? o.note.trim() : null,
    rank: typeof o.rank === 'number' ? o.rank : null,
  }
  const text = [...v.past, ...v.participle, v.translation, v.example.text, v.example.translation ?? '', v.note ?? ''].join(' ')
  if (MARKUP.test(text)) throw new Error(`${where}: contains Markdown characters (* _ \` # < > [[)`)
  return v
}

// Validates a parsed pack file; throws with what is wrong.
export function parsePack(data: unknown): Pack {
  const o = (data ?? {}) as Record<string, unknown>
  if (!isStr(o.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.id)) throw new Error('id must be lowercase-with-dashes')
  if (!isStr(o.name)) throw new Error('name is missing')
  if (o.kind !== 'topic') throw new Error('kind must be "topic"')
  const format = (o.format ?? 'facts') as Pack['format']
  if (!PACK_FORMATS.includes(format)) throw new Error(`format must be one of ${PACK_FORMATS.join(', ')}`)
  if (!Array.isArray(o.items) || !o.items.length) throw new Error('items must be a non-empty list')
  let facts: PackFact[]
  let verbs: Map<string, IrregularVerb> | null = null
  if (format === 'irregular-verbs') {
    const list = o.items.map(irregularVerb)
    verbs = new Map(list.map((v) => [v.verb, v]))
    facts = list.map(irregularVerbFact)
  } else {
    facts = o.items.map((x, i) => {
      const f = (x ?? {}) as Record<string, unknown>
      if (!isStr(f.key) || !isStr(f.front) || !isStr(f.back)) throw new Error(`item ${i}: key, front and back are required`)
      const tags = Array.isArray(f.tags) ? f.tags.filter(isStr) : []
      return { key: f.key.trim(), front: f.front, back: f.back, tags }
    })
  }
  const seen = new Set<string>()
  for (const f of facts) {
    if (seen.has(f.key)) throw new Error(`item "${f.key}" appears twice`)
    seen.add(f.key)
  }
  return { id: o.id, name: o.name.trim(), description: isStr(o.description) ? o.description.trim() : '', kind: 'topic', format, facts, verbs }
}

const RECHECK_MS = 30_000

// Every valid pack in <dir>/packs, by file name; re-read when the files
// change (checked at most every 30 s). A broken file is logged and skipped.
export function packLoader(dir: string): () => Pack[] {
  const folder = path.join(dir, 'packs')
  let checkedAt = -Infinity
  let stamp = ''
  let packs: Pack[] = []
  return () => {
    const now = Date.now()
    if (now - checkedAt < RECHECK_MS) return packs
    checkedAt = now
    let files: string[]
    try {
      files = fs.readdirSync(folder).filter((f) => f.endsWith('.json')).sort()
    } catch {
      files = []
    }
    const s = files.map((f) => `${f}:${fs.statSync(path.join(folder, f)).mtimeMs}`).join('|')
    if (s === stamp) return packs
    stamp = s
    const out: Pack[] = []
    for (const f of files) {
      try {
        const p = parsePack(JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')))
        if (out.some((x) => x.id === p.id)) throw new Error(`pack id ${p.id} is used twice`)
        out.push(p)
      } catch (e) {
        console.error(`cannot load pack ${f}: ${(e as Error).message}`)
      }
    }
    if (out.length) console.log(`loaded packs: ${out.map((p) => `${p.id} (${p.facts.length})`).join(', ')}`)
    packs = out
    return packs
  }
}

// The packs the server offers: from DATA_DIR once main sets it (usePackDir),
// else the bundled server/data. Tests may install their own (setPacks).
let source: () => Pack[] = packLoader(DEFAULT_DATA_DIR)

export function usePackDir(dir: string) {
  source = packLoader(dir)
}

export function setPacks(packs: Pack[]) {
  source = () => packs
}

export function currentPacks(): Pack[] {
  return source()
}

let tableFor: Pack[] | null = null
let table = new Map<string, IrregularVerb>()

function verbTable(): Map<string, IrregularVerb> {
  const packs = currentPacks()
  if (packs !== tableFor) {
    tableFor = packs
    table = new Map()
    for (const p of packs) for (const [k, v] of p.verbs ?? []) if (!table.has(k)) table.set(k, v)
  }
  return table
}

// The past and participle of an irregular verb, for a word in a language
// deck: a verb whose term (without "to ") is in an irregular-verbs pack, or
// a phrasal verb whose first word is ("give up" → gave up · given up).
// null otherwise. Computed on read, never stored.
export function verbForms(term: string, pos: PartOfSpeech): VerbForms | null {
  if (pos !== 'verb' && pos !== 'phrasal_verb') return null
  const words = normalizeTerm(term).split(' ')
  if (pos === 'verb' && words.length !== 1) return null
  if (pos === 'phrasal_verb' && (words.length < 2 || words.length > 3)) return null
  const v = verbTable().get(words[0]!)
  if (!v) return null
  const rest = words.slice(1).join(' ')
  const add = (f: string) => (rest ? `${f} ${rest}` : f)
  return { past: v.past.map(add), participle: v.participle.map(add) }
}
