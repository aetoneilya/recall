// Grammar exercises: a rule's fact reviews through fresh items drawn from a
// pool (see DESIGN.md "Exercises"). Grading here is strict — the form is the
// point, so no typo tolerance — but forgiving about what doesn't matter:
// case, spacing, quotes, punctuation, and contractions vs full forms.

export type ExerciseType = 'gap' | 'fix' | 'rewrite'
export const EXERCISE_TYPES: readonly ExerciseType[] = ['gap', 'fix', 'rewrite']

// What the review screen needs for one item (answers included: grading runs
// on the device, offline too).
export interface ExerciseItem {
  id: string
  // gap: the prompt has one "___" and a hint in parentheses, answer fills it.
  // fix: the prompt is a sentence with one mistake, answer is the corrected sentence.
  // rewrite: "sentence → cue ___", answer completes the cue.
  type: ExerciseType
  prompt: string
  answer: string
  // Other answers that are just as right.
  accepted: string[]
  // One line on why, shown after the check.
  explain: string | null
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

// The dedupe key of an item: its prompt, normalised.
export function exerciseKey(prompt: string): string {
  return normalizeExercise(prompt.replace(/_{2,}/g, ' ___ ')).replace(/\s+/g, ' ')
}

export interface ExerciseInput {
  type: ExerciseType
  prompt: string
  answer: string
  accepted?: string[]
  explain?: string | null
}

export const EXERCISE_LIMITS = { prompt: 500, answer: 300, accepted: 10, explain: 500 }

// Validates one item: the gap and rewrite prompts need their "___", a fix
// answer must differ from its prompt. Returns the cleaned item or a problem.
export function cleanExercise(input: ExerciseInput): { item: Required<ExerciseInput> } | { error: string } {
  const type = input.type
  if (!EXERCISE_TYPES.includes(type)) return { error: `type must be one of ${EXERCISE_TYPES.join(', ')}` }
  const prompt = (input.prompt ?? '').replace(/\s+/g, ' ').trim()
  const answer = (input.answer ?? '').replace(/\s+/g, ' ').trim()
  if (!prompt) return { error: 'prompt is empty' }
  if (!answer) return { error: 'answer is empty' }
  if (prompt.length > EXERCISE_LIMITS.prompt) return { error: `prompt is longer than ${EXERCISE_LIMITS.prompt} characters` }
  if (answer.length > EXERCISE_LIMITS.answer) return { error: `answer is longer than ${EXERCISE_LIMITS.answer} characters` }
  const gaps = (prompt.match(/_{3,}/g) ?? []).length
  if (type === 'gap' && gaps !== 1) return { error: 'a gap prompt needs exactly one ___' }
  if (type === 'rewrite' && (gaps !== 1 || !prompt.includes('→'))) return { error: 'a rewrite prompt is "sentence → cue ___"' }
  if (type === 'fix' && exerciseKey(prompt) === exerciseKey(answer)) return { error: 'a fix answer must differ from its prompt' }
  const accepted: string[] = []
  for (const a of input.accepted ?? []) {
    const t = (a ?? '').replace(/\s+/g, ' ').trim()
    if (t && t !== answer && !accepted.includes(t)) accepted.push(t)
  }
  if (accepted.length > EXERCISE_LIMITS.accepted) return { error: `at most ${EXERCISE_LIMITS.accepted} accepted variants` }
  const explain = input.explain?.replace(/\s+/g, ' ').trim() || null
  if (explain && explain.length > EXERCISE_LIMITS.explain) return { error: `explain is longer than ${EXERCISE_LIMITS.explain} characters` }
  return { item: { type, prompt, answer, accepted, explain } }
}
