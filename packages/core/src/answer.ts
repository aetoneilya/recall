// Typed answers: compares what the learner typed with a word's accepted
// answers. reverse (RU→EN) expects the term or one of its alternative forms
// ("grey/gray", "take (it) easy"); forward (EN→RU) expects any translation.
// Small slips are forgiven by a length-scaled Damerau–Levenshtein tolerance.
import type { Direction, Word } from './types.ts'
import { blankTerm } from './words.ts'

export type AnswerVerdict = 'exact' | 'close' | 'wrong' | 'empty'

export interface AnswerCheck {
  // exact: equal after normalisation; close: a typo within the tolerance or
  // an inflected form of the term; wrong: anything else; empty: nothing typed ("I don't know").
  verdict: AnswerVerdict
  // Edit distance between the normalised input and the closest accepted
  // answer; for an empty input, that answer's length.
  distance: number
  // The accepted answer closest to the input, as written in the word; null
  // when the word has nothing to compare against.
  matched: string | null
  // exact → Good, close → Hard, wrong / empty → Again.
  suggestedRating: 1 | 2 | 3
}

type AnswerWord = Pick<Word, 'term' | 'translations'>

const PLACEHOLDERS: Record<string, string> = {
  sb: 'someone', smb: 'someone', somebody: 'someone',
  sth: 'something', smth: 'something',
}

// Lowercase, ё → е, apostrophes and punctuation dropped, hyphens and
// slashes as spaces, whitespace collapsed. English answers also lose a
// leading infinitive "to" and article (a/an/the), and "smb"/"sth"-style
// placeholders read as "someone"/"something".
export function normalizeAnswer(s: string, english: boolean): string {
  let t = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/…|\.\.\./g, ' ')
    .replace(/[’‘`´']/g, '')
    .replace(/[\p{Pd}_/]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (english) {
    t = t.split(' ').map((w) => PLACEHOLDERS[w] ?? w).join(' ')
    for (let prev = ''; prev !== t; ) {
      prev = t
      t = t.replace(/^(to|a|an|the) (?=\S)/, '')
    }
  }
  return t
}

interface Candidate {
  display: string
  norm: string
}

// "take (it) easy" → "take it easy" and "take easy"; "кипеть (от злости)" → both.
function parenVariants(s: string): string[] {
  if (!/\(/.test(s)) return [s]
  return [s.replace(/[()]/g, ''), s.replace(/\([^)]*\)/g, ' ')]
}

function candidates(word: AnswerWord, direction: Direction): Candidate[] {
  const english = direction === 'reverse'
  // reverse: the term, split into alternative forms on "/" and ";".
  // forward: every translation as a whole and its ","/";" pieces.
  const pieces = english
    ? [word.term, ...word.term.split(/[/;]/)]
    : word.translations.flatMap((t) => [t, ...t.split(/[,;]/)])
  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const p of pieces) {
    const display = p.replace(/\s+/g, ' ').trim()
    if (!display) continue
    for (const v of parenVariants(display)) {
      const norm = normalizeAnswer(v, english)
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      out.push({ display, norm })
    }
  }
  return out
}

// Optimal string alignment distance: insertions, deletions, substitutions
// and transpositions of adjacent characters each cost 1.
export function editDistance(a: string, b: string): number {
  const A = [...a]
  const B = [...b]
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => {
    const row = new Array<number>(B.length + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= B.length; j++) d[0]![j] = j
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1)
      d[i]![j] = v
    }
  }
  return d[A.length]![B.length]!
}

// Typos forgiven for an answer of this many characters: none up to 3,
// then one per ~5 characters (4–6 → 1, 7–10 → 2, 11–15 → 3, …).
export function answerTolerance(length: number): number {
  if (length <= 3) return 0
  if (length <= 6) return 1
  if (length <= 10) return 2
  return Math.ceil(length / 5)
}

export function checkAnswer(input: string, word: AnswerWord, direction: Direction): AnswerCheck {
  const english = direction === 'reverse'
  const cands = candidates(word, direction)
  const typed = normalizeAnswer(input, english)
  if (!cands.length) {
    return typed
      ? { verdict: 'wrong', distance: [...typed].length, matched: null, suggestedRating: 1 }
      : { verdict: 'empty', distance: 0, matched: null, suggestedRating: 1 }
  }
  if (!typed) return { verdict: 'empty', distance: [...cands[0]!.norm].length, matched: cands[0]!.display, suggestedRating: 1 }

  let best = cands[0]!
  let bestD = Infinity
  for (const c of cands) {
    const d = editDistance(typed, c.norm)
    if (d < bestD) {
      best = c
      bestD = d
    }
  }
  if (bestD === 0) return { verdict: 'exact', distance: 0, matched: best.display, suggestedRating: 3 }
  if (bestD <= answerTolerance([...best.norm].length)) return { verdict: 'close', distance: bestD, matched: best.display, suggestedRating: 2 }
  // "frowned" for "to frown": the right word in the wrong form.
  if (english) {
    for (const c of cands) {
      if (blankTerm(typed, c.norm) === '___') return { verdict: 'close', distance: editDistance(typed, c.norm), matched: c.display, suggestedRating: 2 }
    }
  }
  return { verdict: 'wrong', distance: bestD, matched: best.display, suggestedRating: 1 }
}

export interface DiffPart {
  text: string
  // false: this stretch differs from the other string.
  same: boolean
}

const fold = (c: string) => c.toLowerCase().replace('ё', 'е')

// Character diff for showing a typed answer against the expected one; case
// and ё/е don't count as differences. A leading "to " or article that only
// the expected side has is left out of it.
export function answerDiff(input: string, expected: string): { input: DiffPart[]; expected: DiffPart[] } {
  const a = input.trim()
  let b = expected.trim()
  const lead = /^(to|a|an|the)\s+/i
  if (lead.test(b) && !lead.test(a)) b = b.replace(lead, '')
  const A = [...a]
  const B = [...b]
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) => {
    const row = new Array<number>(B.length + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= B.length; j++) d[0]![j] = j
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      const cost = fold(A[i - 1]!) === fold(B[j - 1]!) ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
    }
  }
  const sa: boolean[] = []
  const sb: boolean[] = []
  let i = A.length
  let j = B.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (fold(A[i - 1]!) === fold(B[j - 1]!) ? 0 : 1)) {
      const same = fold(A[i - 1]!) === fold(B[j - 1]!)
      sa.unshift(same)
      sb.unshift(same)
      i--
      j--
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      sa.unshift(false)
      i--
    } else {
      sb.unshift(false)
      j--
    }
  }
  const parts = (chars: string[], flags: boolean[]): DiffPart[] => {
    const out: DiffPart[] = []
    chars.forEach((c, k) => {
      const last = out.at(-1)
      if (last && last.same === flags[k]) last.text += c
      else out.push({ text: c, same: flags[k]! })
    })
    return out
  }
  return { input: parts(A, sa), expected: parts(B, sb) }
}
