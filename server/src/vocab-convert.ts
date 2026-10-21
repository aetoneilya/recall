// Turns old flashcards (front / back / extra / tags) into words. Shared by
// the v3 migration and the Decks importer so both give the same result.
// The v3 migration depends on these rules: change them only together with a
// frozen copy for that migration.
import { cleanIpa, type PartOfSpeech } from '@recall/core'

const CYRILLIC = /[Ѐ-ӿ]/g
const LATIN = /[A-Za-z]/g

const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0

// Share of Cyrillic among the letters; 0 for no letters.
function cyrillicShare(s: string): number {
  const c = count(s, CYRILLIC)
  const l = count(s, LATIN)
  return c + l ? c / (c + l) : 0
}

export function hasCyrillic(s: string): boolean {
  return count(s, CYRILLIC) > 0
}

// Which side is English: one side without Cyrillic and the other with it, or
// (both mixed) one mostly Latin and the other mostly Cyrillic. null = not an EN/RU pair.
export function englishSide(frontRaw: string, backRaw: string): 'front' | 'back' | null {
  // Parenthetical glosses ("inundated (заказами)") don't decide the language.
  const bare = (s: string) => s.replace(/\([^)]*\)/g, ' ').trim() || s
  const front = bare(frontRaw)
  const back = bare(backRaw)
  const f = cyrillicShare(front)
  const b = cyrillicShare(back)
  const fc = hasCyrillic(front)
  const bc = hasCyrillic(back)
  if (!fc && bc && count(front, LATIN) > 0) return 'front'
  if (fc && !bc && count(back, LATIN) > 0) return 'back'
  if (fc && bc) {
    if (f < 0.3 && b > 0.5) return 'front'
    if (b < 0.3 && f > 0.5) return 'back'
  }
  return null
}

// A deck the old vocabulary notes lived in: any deck with reversible notes,
// or one named like a vocabulary deck. Basic notes elsewhere (Q&A decks with
// Russian answers) are not words.
export function isVocabularyDeckName(name: string): boolean {
  return /vocab|словар|лексик/i.test(name)
}

// A basic note only counts as a word if both sides look like a term and a
// gloss: one line each, no markdown, short, not a question.
export function looksLikeWordPair(english: string, russian: string): boolean {
  const plain = (s: string) => !/\n|\*\*|`|\[\[|^#|\|/.test(s)
  return (
    plain(english) && plain(russian) &&
    english.length <= 80 && english.split(/\s+/).length <= 10 && !/\?\s*$/.test(english) &&
    russian.length <= 200
  )
}

const POS_MARKERS: [RegExp, PartOfSpeech][] = [
  [/^(adj|adjective|прил)\.?$/i, 'adjective'],
  [/^(n|noun|сущ)\.?$/i, 'noun'],
  [/^(v|verb|гл)\.?$/i, 'verb'],
  [/^(adv|adverb|нареч)\.?$/i, 'adverb'],
  [/^(phr\.? ?v|phrasal verb)\.?$/i, 'phrasal_verb'],
  [/^(idiom)\.?$/i, 'idiom'],
  [/^(prep|preposition)\.?$/i, 'preposition'],
]

const PARTICLES = 'up|down|out|off|in|on|over|away|back|through|around|about|along|into|across|after|apart|by|forward|together|onto'

// Part of speech from the term itself: a "(adj.)" marker, "to …" for verbs
// ("to … up" for phrasal verbs), several words for phrases; one bare word is
// "other" (unknown) — Claude can fill it in later.
export function termAndPos(raw: string): { term: string; pos: PartOfSpeech } {
  let term = raw.replace(/\s+/g, ' ').trim()
  let pos: PartOfSpeech | null = null
  const m = term.match(/^(.*\S)\s*\(([^)]+)\)$/)
  if (m) {
    const hit = POS_MARKERS.find(([re]) => re.test(m[2]!.trim()))
    if (hit) {
      term = m[1]!
      pos = hit[1]
    }
  }
  if (!pos) {
    if (new RegExp(`^to \\S+ (${PARTICLES})$`, 'i').test(term)) pos = 'phrasal_verb'
    else if (/^to \S/i.test(term)) pos = 'verb'
    else if (term.replace(/\([^)]*\)/g, '').trim().split(/\s+/).length > 1) pos = 'phrase'
    else pos = 'other'
  }
  return { term, pos }
}

// "оптимизировать, упрощать" → two translations; "не так плохо, как о нём
// говорят" stays one. Splits on top-level ";" always and on "," when every
// part is short and none starts like a subordinate clause.
export function splitTranslations(raw: string): string[] {
  const top = (s: string, sep: string) => {
    const out: string[] = []
    let depth = 0
    let cur = ''
    for (const ch of s) {
      if (ch === '(' || ch === '[') depth++
      if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
      if (ch === sep && depth === 0) {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
    out.push(cur)
    return out.map((x) => x.trim()).filter(Boolean)
  }
  const CLAUSE = /^(как|что|чтобы|который|которая|которое|которые|где|когда|если|но|а|и|или|потому|хотя|чем)(?!\p{L})/iu
  const out: string[] = []
  for (const part of top(raw.replace(/\s+/g, ' ').trim(), ';')) {
    const pieces = top(part, ',')
    const ok = pieces.length > 1 && pieces.every((p) => p.split(' ').length <= 4 && !CLAUSE.test(p))
    for (const p of ok ? pieces : [part]) if (!out.includes(p)) out.push(p)
  }
  return out
}

// The importer wrote IPA into extra as "IPA: /…/" lines (or a bare "/…/"
// line); everything else becomes the usage note.
export function parseExtra(extra: string | null | undefined): { ipa: string | null; note: string | null } {
  let ipa: string | null = null
  const rest: string[] = []
  for (const line of (extra ?? '').split('\n')) {
    const t = line.trim()
    const m = t.match(/^(?:ipa|transcription|pronunciation)\s*:\s*(.+)$/i) ?? t.match(/^(\/[^/]+\/|\[[^\]]+\])$/)
    if (m && !ipa) ipa = cleanIpa(m[1])
    else rest.push(line)
  }
  const note = rest.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { ipa, note: note || null }
}

// Section tags that only said which way the old card went.
const DIRECTION_TAG = /^(english|russian|en|ru)\s*(→|->|—|-)\s*(english|russian|en|ru)$/i

export function isDirectionTag(tag: string): boolean {
  return DIRECTION_TAG.test(tag.trim())
}

// Breadcrumb section titles (book names, "leon notes — words") versus the
// plugin's own one-word tags ("vocab").
export function isBreadcrumbTag(tag: string): boolean {
  return !DIRECTION_TAG.test(tag) && !/^[a-z0-9_-]+$/.test(tag)
}

export function convertTags(tags: string[]): { source: string | null; tags: string[] } {
  const kept = tags.filter((t) => !DIRECTION_TAG.test(t.trim()))
  return { source: kept.find(isBreadcrumbTag) ?? null, tags: kept }
}

export interface ConvertedPair {
  term: string
  pos: PartOfSpeech
  translations: string[]
  // Which old side held the English term.
  englishOn: 'front' | 'back'
}

export function convertPair(front: string, back: string): ConvertedPair | null {
  const side = englishSide(front, back)
  if (!side) return null
  const english = side === 'front' ? front : back
  const russian = side === 'front' ? back : front
  const { term, pos } = termAndPos(english)
  const translations = splitTranslations(russian)
  if (!term || !translations.length) return null
  return { term, pos, translations, englishOn: side }
}

// Comma pieces of a translation without parentheticals, lowercased:
// "кстати говоря, учти (разг.)" → ["кстати говоря", "учти"].
function pieces(t: string): string[] {
  return t.replace(/\([^)]*\)/g, ' ').toLowerCase().split(/[,;]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

// Translations of `b` appended to `a`, unique, order kept. A translation is
// skipped when it is already there as one of the comma pieces of another, or
// when all its pieces are ("кстати говоря" next to "кстати говоря, учти").
export function mergeTranslations(a: string[], b: string[]): string[] {
  const out = [...a]
  for (const t of b) {
    const have = new Set(out.flatMap(pieces))
    const mine = pieces(t)
    if (out.some((x) => x.toLowerCase() === t.toLowerCase()) || (mine.length && mine.every((p) => have.has(p)))) continue
    out.push(t)
  }
  return out
}
