// Content packs: ready-made topic decks shipped as server/data/packs/*.json.
// A pack file describes itself — {id, name, description, kind: 'topic',
// format, items} — and its format says how items become facts:
//   'facts'            items are {key, front, back, tags?} (Markdown), as is;
//   'irregular-verbs'  items are {verb, past[], participle[], translation,
//                      example: {text, translation}, note, rank}; the fact's
//                      Markdown is generated here, and the verbs' forms are
//                      shown on matching word cards (verbForms);
//   'grammar-handbook' items are topics {id, group, title, level, summary,
//                      cards: [{front, back}], exercises: [choose | spot],
//                      write?: [{prompt, rubric?}]}: per topic a rule fact
//                      (title → summary) with its exercise pool, plus the
//                      theory cards as plain facts (packs.ts).
// Items are in the order cards should be introduced (most frequent first).
// No database access here: repo.ts uses verbForms for word items, packs.ts
// adds packs to a user's collection.
import fs from 'node:fs'
import path from 'node:path'
import { CEFR_LEVELS, cleanExercise, exerciseKey, formsLine, normalizeTerm, type Cefr, type CleanExercise, type PartOfSpeech, type VerbForms } from '@recall/core'
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

// One topic of the grammar handbook.
export interface HandbookTopic {
  // lowercase-with-dashes, stable: import refs are built from it.
  id: string
  group: string
  title: string
  level: Cefr
  // The cheat sheet (Markdown): the rule fact's back.
  summary: string
  cards: { front: string; back: string }[]
  // Tap items (choose / spot), cleaned; in file order (import ref …:ex:<n>).
  exercises: CleanExercise[]
  // Write items as given (…:write:<n>); packs.ts tops them up to two.
  write: CleanExercise[]
}

export interface Pack {
  id: string
  name: string
  description: string
  kind: 'topic'
  format: 'facts' | 'irregular-verbs' | 'grammar-handbook'
  // Every fact the pack adds, in introduction order. For the handbook, per
  // topic: the rule (key = topic id) then its cards (key <topic>:card:<n>).
  facts: PackFact[]
  // format 'irregular-verbs' only: by verb.
  verbs: Map<string, IrregularVerb> | null
  // format 'grammar-handbook' only, in file order.
  topics: HandbookTopic[] | null
}

export const PACK_FORMATS = ['facts', 'irregular-verbs', 'grammar-handbook'] as const
export const HANDBOOK_CARDS = { min: 3, max: 6 }
// A rule reviews through its pool once it has MIN_POOL (3) tap items.
export const HANDBOOK_MIN_EXERCISES = 3
const TOPIC_TEXT_MAX = { title: 200, group: 100, summary: 20000, front: 2000, back: 20000 }

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

function handbookTopic(x: unknown, i: number): HandbookTopic {
  const o = (x ?? {}) as Record<string, unknown>
  const where = `topic ${i}${isStr(o.id) ? ` (${o.id})` : ''}`
  if (!isStr(o.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.id)) throw new Error(`${where}: id must be lowercase-with-dashes`)
  for (const k of ['group', 'title', 'summary'] as const) {
    if (!isStr(o[k])) throw new Error(`${where}: ${k} is missing`)
    if ((o[k] as string).length > TOPIC_TEXT_MAX[k]) throw new Error(`${where}: ${k} is longer than ${TOPIC_TEXT_MAX[k]} characters`)
  }
  if (!(CEFR_LEVELS as readonly unknown[]).includes(o.level)) throw new Error(`${where}: level must be one of ${CEFR_LEVELS.join(', ')}`)
  const cards = Array.isArray(o.cards) ? o.cards : []
  if (cards.length < HANDBOOK_CARDS.min || cards.length > HANDBOOK_CARDS.max) throw new Error(`${where}: needs ${HANDBOOK_CARDS.min}–${HANDBOOK_CARDS.max} cards`)
  const cleanCards = cards.map((c: unknown, n: number) => {
    const f = (c ?? {}) as Record<string, unknown>
    if (!isStr(f.front) || !isStr(f.back)) throw new Error(`${where}: card ${n} needs front and back`)
    if (f.front.length > TOPIC_TEXT_MAX.front || f.back.length > TOPIC_TEXT_MAX.back) throw new Error(`${where}: card ${n} is too long`)
    return { front: f.front.trim(), back: f.back.trim() }
  })
  const fronts = new Set<string>()
  for (const c of [o.title as string, ...cleanCards.map((c) => c.front)]) {
    const k = c.trim().toLowerCase()
    if (fronts.has(k)) throw new Error(`${where}: "${c}" is both the title and a card, or two cards`)
    fronts.add(k)
  }
  const items = (list: unknown, kind: 'exercise' | 'write'): CleanExercise[] => {
    const keys = new Set<string>()
    return (Array.isArray(list) ? list : []).map((e: unknown, n: number) => {
      const input = (e ?? {}) as Record<string, unknown>
      const type = kind === 'write' ? 'write' : input.type
      if (kind === 'exercise' && type !== 'choose' && type !== 'spot') throw new Error(`${where}: exercise ${n} must be choose or spot`)
      const r = cleanExercise({ ...(input as object), type } as Parameters<typeof cleanExercise>[0])
      if ('error' in r) throw new Error(`${where}: ${kind} ${n}: ${r.error}`)
      const k = exerciseKey(r.item.prompt, r.item.type)
      if (keys.has(k)) throw new Error(`${where}: ${kind} ${n} repeats an earlier text`)
      keys.add(k)
      return r.item
    })
  }
  const exercises = items(o.exercises, 'exercise')
  if (exercises.length < HANDBOOK_MIN_EXERCISES) throw new Error(`${where}: needs at least ${HANDBOOK_MIN_EXERCISES} exercises`)
  if (o.write !== undefined && !Array.isArray(o.write)) throw new Error(`${where}: write must be a list`)
  return {
    id: o.id, group: (o.group as string).trim(), title: (o.title as string).trim(), level: o.level as Cefr, summary: (o.summary as string).trim(),
    cards: cleanCards, exercises, write: items(o.write, 'write'),
  }
}

// The root of the grammar tags: rules and theory cards sit under
// "Grammar/<group>" (the card type tells them apart).
export const GRAMMAR_TAG = 'Grammar'

// The handbook's facts: per topic the rule (front = title, back = the
// summary), then its theory cards, all tagged Grammar/<group>.
export function handbookFacts(topics: HandbookTopic[]): PackFact[] {
  return topics.flatMap((t) => {
    const tags = [`${GRAMMAR_TAG}/${t.group}`]
    return [
      { key: t.id, front: t.title, back: t.summary, tags },
      ...t.cards.map((c, n) => ({ key: `${t.id}:card:${n}`, front: c.front, back: c.back, tags })),
    ]
  })
}

// Validates a parsed pack file; throws with what is wrong.
export function parsePack(data: unknown): Pack {
  const o = (data ?? {}) as Record<string, unknown>
  if (!isStr(o.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.id)) throw new Error('id must be lowercase-with-dashes')
  if (!isStr(o.name)) throw new Error('name is missing')
  if (o.kind !== undefined && o.kind !== 'topic') throw new Error('kind must be "topic"')
  const format = (o.format ?? 'facts') as Pack['format']
  if (!PACK_FORMATS.includes(format)) throw new Error(`format must be one of ${PACK_FORMATS.join(', ')}`)
  if (!Array.isArray(o.items) || !o.items.length) throw new Error('items must be a non-empty list')
  let facts: PackFact[]
  let verbs: Map<string, IrregularVerb> | null = null
  let topics: HandbookTopic[] | null = null
  if (format === 'irregular-verbs') {
    const list = o.items.map(irregularVerb)
    verbs = new Map(list.map((v) => [v.verb, v]))
    facts = list.map(irregularVerbFact)
  } else if (format === 'grammar-handbook') {
    topics = o.items.map(handbookTopic)
    facts = handbookFacts(topics)
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
    if (seen.has(f.key)) throw new Error(`${topics ? 'topic' : 'item'} "${f.key}" appears twice`)
    seen.add(f.key)
  }
  return { id: o.id, name: o.name.trim(), description: isStr(o.description) ? o.description.trim() : '', kind: 'topic', format, facts, verbs, topics }
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
