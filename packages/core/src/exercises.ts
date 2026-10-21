// Grammar exercises: a rule's fact reviews through fresh items drawn from a
// pool (see DESIGN.md "Exercises"). Two families:
// - tap (choose, spot): answered with taps, graded by identity — the types
//   the app serves;
// - typed (gap, fix, rewrite, legacy): graded strictly — no typo tolerance —
//   but forgiving about case, spacing, quotes, punctuation and contractions.

export type ExerciseType = 'choose' | 'spot' | 'gap' | 'fix' | 'rewrite'
export const EXERCISE_TYPES: readonly ExerciseType[] = ['choose', 'spot', 'gap', 'fix', 'rewrite']
export const TAP_TYPES: readonly ExerciseType[] = ['choose', 'spot']
export const isTapType = (t: ExerciseType) => t === 'choose' || t === 'spot'

// An option that means "nothing here": the zero article in choose, "delete
// the word" in spot.
export const NOTHING = '—'

// What the review screen needs for one item (answers included: grading runs
// on the device, offline too).
export interface ExerciseItem {
  id: string
  // choose: `prompt` has one "___"; tap one of `options`, `answer` is right.
  // spot: `prompt` is a sentence whose `wrong` tokens are the mistake; tap
  //   them, then the replacement among `options` (`answer`; "—" deletes).
  // gap / fix / rewrite (legacy, typed): the prompt has a "___" + hint / one
  //   mistake (answer = the corrected sentence) / "sentence → cue ___".
  type: ExerciseType
  // The sentence ("text" in files and tools).
  prompt: string
  answer: string
  // Typed types: other answers that are just as right.
  accepted: string[]
  // One line on why, shown after the check.
  explain: string | null
  // Tap types: the choices, the answer among them.
  options?: string[]
  // spot: the wrong token(s), once in the sentence.
  wrong?: string | null
}

// One item's outcome, sent with the review (ReviewInput.exercises).
export interface ExerciseAttempt {
  id: string
  given: string
  correct: boolean
  // "I was right": counted correct, the item is marked for a look.
  overridden?: boolean
  // "Bad item": the item leaves the pool; it isn't graded.
  bad?: boolean
}

// n't, 'm, 're, 've, 'll and pronoun + 's / 'd, each to its full readings.
const PRONOUN_S = new Set(['it', 'he', 'she', 'that', 'there', 'here', 'what', 'who', 'where', 'when', 'how', 'why', 'this'])
const SPECIAL: Record<string, string[]> = {
  "won't": ['will not'], "can't": ['can not'], cannot: ['can not'], "shan't": ['shall not'], "let's": ['let us'], "ain't": ['is not', 'are not', 'am not'],
}

function readings(token: string): string[] {
  if (SPECIAL[token]) return SPECIAL[token]!
  let m = /^(.+)n't$/.exec(token)
  if (m) return [`${m[1]} not`]
  m = /^(.+)'(m|re|ve|ll|d|s)$/.exec(token)
  if (!m) return [token]
  const [, w, c] = m as unknown as [string, string, string]
  switch (c) {
    case 'm':
      return [`${w} am`]
    case 're':
      return [`${w} are`]
    case 've':
      return [`${w} have`]
    case 'll':
      return [`${w} will`]
    case 'd':
      return [`${w} would`, `${w} had`]
    default:
      // "it's" is "it is" or "it has"; "John's" is a possessive and stays.
      return PRONOUN_S.has(w) ? [`${w} is`, `${w} has`] : [token]
  }
}

// Case, quotes, punctuation (an apostrophe inside a word stays), dashes and
// spacing don't count.
export function normalizeExercise(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(/(^|[^\p{L}])'|'(?![\p{L}])/gu, '$1 ')
    .replace(/[\p{Pd}]/gu, ' ')
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const MAX_READINGS = 32

// Every full-form reading of an answer, normalised: "it's done" →
// {"it is done", "it has done"}.
export function exerciseReadings(s: string): Set<string> {
  let out = ['']
  for (const t of normalizeExercise(s).split(' ').filter(Boolean)) {
    const rs = readings(t)
    const next: string[] = []
    for (const prefix of out) for (const r of rs) if (next.length < MAX_READINGS) next.push(prefix ? `${prefix} ${r}` : r)
    out = next
  }
  return new Set(out.filter(Boolean))
}

export interface ExerciseCheck {
  correct: boolean
  // The accepted answer it matched, else the expected one.
  expected: string
}

// Right when the input has a reading in common with the answer or any of
// the accepted variants. Empty input is wrong.
export function checkExercise(input: string, item: Pick<ExerciseItem, 'answer' | 'accepted'>): ExerciseCheck {
  const typed = exerciseReadings(input)
  for (const a of [item.answer, ...item.accepted]) {
    const want = exerciseReadings(a)
    for (const r of typed) if (want.has(r)) return { correct: true, expected: a }
  }
  return { correct: false, expected: item.answer }
}

// A review's rating from its items: all right → Good, one wrong (of two or
// more) → Hard, else Again. Items marked bad don't count; with none graded,
// Good.
export function exerciseRating(attempts: Pick<ExerciseAttempt, 'correct' | 'bad'>[]): 1 | 2 | 3 {
  const graded = attempts.filter((a) => !a.bad)
  const right = graded.filter((a) => a.correct).length
  if (!graded.length || right === graded.length) return 3
  if (graded.length >= 2 && right === graded.length - 1) return 2
  return 1
}

// The dedupe key of an item: its sentence, normalised. The tap family has its
// own keys, so a choose item may reuse a legacy gap sentence.
export function exerciseKey(prompt: string, type: ExerciseType = 'gap'): string {
  const k = normalizeExercise(prompt.replace(/_{2,}/g, ' ___ ')).replace(/\s+/g, ' ')
  return isTapType(type) ? `tap:${k}` : k
}

export interface ExerciseInput {
  type: ExerciseType
  // The sentence; `text` is the same field under the name files and tools use.
  prompt?: string
  text?: string
  answer: string
  accepted?: string[]
  explain?: string | null
  options?: string[]
  wrong?: string | null
}

export interface CleanExercise {
  type: ExerciseType
  prompt: string
  answer: string
  accepted: string[]
  explain: string | null
  options: string[]
  wrong: string | null
}

export const EXERCISE_LIMITS = { prompt: 500, answer: 300, accepted: 10, explain: 500, option: 100 }

const words = (s: string) => s.split(' ').filter(Boolean)
// A token of a sentence without the punctuation around it: "rains." → "rains".
const core = (t: string) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')

// Where the wrong tokens are in a spot sentence: the first token index and
// how many, matching whole space-separated tokens (punctuation around a
// token doesn't count). null unless they occur exactly once.
export function spotSpan(text: string, wrong: string): { start: number; length: number } | null {
  const t = words(text).map(core)
  const w = words(wrong).map(core)
  if (!w.length || w.some((x) => !x)) return null
  let found: number | null = null
  for (let i = 0; i + w.length <= t.length; i++) {
    if (w.every((x, k) => t[i + k] === x)) {
      if (found !== null) return null
      found = i
    }
  }
  return found === null ? null : { start: found, length: w.length }
}

export interface SentencePart {
  text: string
  // The tokens that changed (the replacement; empty when deleted).
  changed: boolean
}

// A spot sentence with its mistake replaced ("—" deletes it), the change
// marked: "His shoes gets wet." → [His shoes ][get][ wet.].
export function correctedParts(text: string, wrong: string, replacement: string): SentencePart[] {
  const toks = words(text)
  const span = spotSpan(text, wrong)
  if (!span) return [{ text, changed: false }]
  const before = toks.slice(0, span.start)
  const gone = toks.slice(span.start, span.start + span.length)
  const after = toks.slice(span.start + span.length)
  // Punctuation stuck to the wrong tokens ("gets," → "get,") stays.
  const lead = gone[0]!.match(/^[^\p{L}\p{N}']*/u)![0]
  const trail = gone.at(-1)!.match(/[^\p{L}\p{N}']*$/u)![0]
  const out: SentencePart[] = []
  const head = before.join(' ')
  if (replacement === NOTHING) {
    out.push({ text: [head, lead + trail].filter(Boolean).join(' ').replace(/ ([,.;:!?])/g, '$1'), changed: false })
    out.push({ text: '', changed: true })
  } else {
    out.push({ text: head ? `${head} ${lead}` : lead, changed: false })
    out.push({ text: replacement, changed: true })
    out.push({ text: trail, changed: false })
  }
  const tail = after.join(' ')
  if (tail) out.push({ text: ` ${tail}`, changed: false })
  return out.filter((p, i) => p.text || p.changed || i === 0)
}

// The sentence's tokens, for tapping: each knows whether it is part of the mistake.
export function spotTokens(text: string, wrong: string): { text: string; wrong: boolean }[] {
  const span = spotSpan(text, wrong)
  return words(text).map((t, i) => ({ text: t, wrong: !!span && i >= span.start && i < span.start + span.length }))
}

function cleanOptions(input: ExerciseInput): string[] {
  const out: string[] = []
  for (const o of input.options ?? []) {
    const t = (o ?? '').replace(/\s+/g, ' ').trim()
    const v = t === '-' || t === '–' ? NOTHING : t
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// Validates one item. Tap types: choose has one "___" in its text and 2–4
// options with the answer among them; spot names its wrong token(s), found
// exactly once in the text, and 1–4 replacement options with the answer
// (never the wrong token itself). Typed (legacy): the gap and rewrite
// prompts need their "___", a fix answer must differ from its prompt.
export function cleanExercise(input: ExerciseInput): { item: CleanExercise } | { error: string } {
  const type = input.type
  if (!EXERCISE_TYPES.includes(type)) return { error: `type must be one of ${EXERCISE_TYPES.join(', ')}` }
  const prompt = (input.prompt ?? input.text ?? '').replace(/\s+/g, ' ').trim()
  const rawAnswer = (input.answer ?? '').replace(/\s+/g, ' ').trim()
  const answer = rawAnswer === '-' || rawAnswer === '–' ? NOTHING : rawAnswer
  if (!prompt) return { error: 'text is empty' }
  if (!answer) return { error: 'answer is empty' }
  if (prompt.length > EXERCISE_LIMITS.prompt) return { error: `prompt is longer than ${EXERCISE_LIMITS.prompt} characters` }
  if (answer.length > EXERCISE_LIMITS.answer) return { error: `answer is longer than ${EXERCISE_LIMITS.answer} characters` }
  const gaps = (prompt.match(/_{3,}/g) ?? []).length
  const explainText = input.explain?.replace(/\s+/g, ' ').trim() || null
  if (explainText && explainText.length > EXERCISE_LIMITS.explain) return { error: `explain is longer than ${EXERCISE_LIMITS.explain} characters` }
  if (isTapType(type)) {
    const options = cleanOptions(input)
    if (options.some((o) => o.length > EXERCISE_LIMITS.option)) return { error: `an option is longer than ${EXERCISE_LIMITS.option} characters` }
    if (!options.includes(answer)) return { error: 'the answer must be one of the options' }
    if (type === 'choose') {
      if (gaps !== 1) return { error: 'a choose text needs exactly one ___' }
      if (options.length < 2 || options.length > 4) return { error: 'choose needs 2–4 options' }
      return { item: { type, prompt, answer, accepted: [], explain: explainText, options, wrong: null } }
    }
    const wrong = (input.wrong ?? '').replace(/\s+/g, ' ').trim()
    if (!wrong) return { error: 'spot needs the wrong token(s)' }
    if (gaps) return { error: 'a spot text has no ___' }
    if (!spotSpan(prompt, wrong)) return { error: 'the wrong token(s) must occur exactly once in the text, as whole words' }
    if (options.length < 1 || options.length > 4) return { error: 'spot needs 1–4 replacement options' }
    if (options.some((o) => o.toLowerCase() === wrong.toLowerCase())) return { error: 'an option repeats the wrong token(s)' }
    return { item: { type, prompt, answer, accepted: [], explain: explainText, options, wrong } }
  }
  if (type === 'gap' && gaps !== 1) return { error: 'a gap prompt needs exactly one ___' }
  if (type === 'rewrite' && (gaps !== 1 || !prompt.includes('→'))) return { error: 'a rewrite prompt is "sentence → cue ___"' }
  if (type === 'fix' && exerciseKey(prompt) === exerciseKey(answer)) return { error: 'a fix answer must differ from its prompt' }
  const accepted: string[] = []
  for (const a of input.accepted ?? []) {
    const t = (a ?? '').replace(/\s+/g, ' ').trim()
    if (t && t !== answer && !accepted.includes(t)) accepted.push(t)
  }
  if (accepted.length > EXERCISE_LIMITS.accepted) return { error: `at most ${EXERCISE_LIMITS.accepted} accepted variants` }
  return { item: { type, prompt, answer, accepted, explain: explainText, options: [], wrong: null } }
}
