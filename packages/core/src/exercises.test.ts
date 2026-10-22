import { describe, expect, it } from 'vitest'
import { checkExercise, cleanExercise, correctedParts, exerciseKey, exerciseRating, exerciseReadings, isTapType, isWriteType, normalizeExercise, spotSpan, spotTokens } from './exercises.ts'

describe('exercise grading', () => {
  const item = (answer: string, accepted: string[] = []) => ({ answer, accepted })

  it('ignores case, spacing, quotes and punctuation, but not typos', () => {
    expect(normalizeExercise('  The  Cat’s   “sat”, here! ')).toBe("the cat's sat here")
    expect(checkExercise('IS', item('is')).correct).toBe(true)
    expect(checkExercise('Each replica keeps its log.', item('each replica keeps its log')).correct).toBe(true)
    expect(checkExercise('keep', item('keeps')).correct).toBe(false)
    expect(checkExercise('', item('is'))).toEqual({ correct: false, expected: 'is' })
  })

  it('takes contractions as their full forms, both ways', () => {
    expect(checkExercise("didn't take the bus", item('did not take the bus')).correct).toBe(true)
    expect(checkExercise('do not', item("don't")).correct).toBe(true)
    expect(checkExercise("won't", item('will not')).correct).toBe(true)
    expect(checkExercise("it's not ready", item("it isn't ready")).correct).toBe(true)
    expect(checkExercise("it's been ages", item('it has been ages')).correct).toBe(true)
    expect(checkExercise("I'd gone", item('I had gone')).correct).toBe(true)
    expect(checkExercise("John's car", item('John is car')).correct).toBe(false)
    expect(exerciseReadings("we're")).toEqual(new Set(['we are']))
  })

  it('accepts any listed variant and reports which', () => {
    expect(checkExercise('whether the job finished', item('if the job finished', ['whether the job finished']))).toEqual({ correct: true, expected: 'whether the job finished' })
    expect(checkExercise('when the job finished', item('if the job finished', ['whether the job finished']))).toEqual({ correct: false, expected: 'if the job finished' })
  })

  it('rates a review from its items', () => {
    const r = (...c: boolean[]) => exerciseRating(c.map((correct) => ({ correct })))
    expect([r(true, true, true), r(true, false, true), r(false, false, true), r(false, false, false)]).toEqual([3, 2, 1, 1])
    expect(exerciseRating([{ correct: false, bad: true }, { correct: true }, { correct: true }])).toBe(3)
    expect(exerciseRating([{ correct: false, bad: true }, { correct: false }, { correct: true }])).toBe(2)
    expect(exerciseRating([{ correct: false, bad: true }])).toBe(3)
  })

  it('rates reviews of two or four items the same way', () => {
    const r = (...c: boolean[]) => exerciseRating(c.map((correct) => ({ correct })))
    expect([r(true, true), r(true, false), r(false, false)]).toEqual([3, 2, 1])
    expect([r(true, true, true, true), r(true, false, true, true), r(true, false, false, true)]).toEqual([3, 2, 1])
  })
})

describe('exercise items', () => {
  it('validates the shape of each type', () => {
    expect(cleanExercise({ type: 'gap', prompt: ' She  ___ here. (live) ', answer: ' lives ', accepted: ['lives', 'resides', ''] }))
      .toEqual({ item: { type: 'gap', prompt: 'She ___ here. (live)', answer: 'lives', accepted: ['resides'], explain: null, options: [], wrong: null, rubric: null } })
    expect(cleanExercise({ type: 'gap', prompt: 'No gap here', answer: 'x' })).toEqual({ error: 'a gap prompt needs exactly one ___' })
    expect(cleanExercise({ type: 'rewrite', prompt: 'He left. → He has ___', answer: 'left' })).toMatchObject({ item: { type: 'rewrite' } })
    expect(cleanExercise({ type: 'rewrite', prompt: 'He left. He has ___', answer: 'left' })).toMatchObject({ error: expect.stringMatching(/rewrite/) })
    expect(cleanExercise({ type: 'fix', prompt: 'She go home.', answer: 'she go home' })).toEqual({ error: 'a fix answer must differ from its prompt' })
    expect(cleanExercise({ type: 'quiz' as never, prompt: 'x', answer: 'y' })).toMatchObject({ error: expect.stringMatching(/type/) })
    expect(exerciseKey('She ____ here.  (live)')).toBe(exerciseKey('she ___ here (live)'))
  })
})

describe('tap exercises', () => {
  const choose = (over: object = {}) => ({ type: 'choose' as const, text: 'The backup runs ___ 3 a.m.', options: ['at', 'in', 'on'], answer: 'at', explain: 'at + clock time', ...over })
  const spot = (over: object = {}) => ({ type: 'spot' as const, text: 'His shoes gets wet every time it rains.', wrong: 'gets', options: ['get', 'getting', 'got'], answer: 'get', explain: 'shoes — мн. ч.', ...over })

  it('validates choose', () => {
    expect(cleanExercise(choose())).toEqual({ item: { type: 'choose', prompt: 'The backup runs ___ 3 a.m.', answer: 'at', accepted: [], explain: 'at + clock time', options: ['at', 'in', 'on'], wrong: null, rubric: null } })
    expect(cleanExercise(choose({ text: 'No gap at 3 a.m.' }))).toEqual({ error: 'a choose text needs exactly one ___' })
    expect(cleanExercise(choose({ options: ['at'] }))).toEqual({ error: 'choose needs 2–4 options' })
    expect(cleanExercise(choose({ options: ['at', 'in', 'on', 'by', 'for'] }))).toEqual({ error: 'choose needs 2–4 options' })
    expect(cleanExercise(choose({ answer: 'by' }))).toEqual({ error: 'the answer must be one of the options' })
    // "—" (also typed as "-") is the zero article; repeated options collapse.
    expect(cleanExercise(choose({ text: 'She plays ___ piano.', options: ['the', '-', 'a', 'the'], answer: 'the' }))).toMatchObject({ item: { options: ['the', '—', 'a'] } })
  })

  it('validates spot', () => {
    expect(cleanExercise(spot())).toMatchObject({ item: { type: 'spot', wrong: 'gets', options: ['get', 'getting', 'got'], answer: 'get' } })
    expect(cleanExercise(spot({ wrong: 'get' }))).toMatchObject({ error: expect.stringMatching(/exactly once/) })
    expect(cleanExercise(spot({ text: 'It gets cold and it gets dark.' }))).toMatchObject({ error: expect.stringMatching(/exactly once/) })
    expect(cleanExercise(spot({ wrong: '' }))).toEqual({ error: 'spot needs the wrong token(s)' })
    expect(cleanExercise(spot({ options: ['gets', 'get'] }))).toEqual({ error: 'an option repeats the wrong token(s)' })
    expect(cleanExercise(spot({ text: 'See you on next week.', wrong: 'on', options: ['—', 'in'], answer: '—' }))).toMatchObject({ item: { answer: '—' } })
    expect(cleanExercise(spot({ text: 'I am agree with you.', wrong: 'am agree', options: ['agree', 'agreed'], answer: 'agree' }))).toMatchObject({ item: { wrong: 'am agree' } })
  })

  it('finds and replaces the mistake by whole tokens', () => {
    expect(spotSpan('His shoes gets wet every time it rains.', 'rains')).toEqual({ start: 7, length: 1 })
    expect(spotSpan('The user hasn’t logged in.', 'in')).toEqual({ start: 4, length: 1 })
    expect(spotSpan('Getting gets old.', 'gets')).toEqual({ start: 1, length: 1 })
    expect(spotSpan('I am agree with you.', 'am agree')).toEqual({ start: 1, length: 2 })
    expect(spotTokens('He go home.', 'go')).toEqual([{ text: 'He', wrong: false }, { text: 'go', wrong: true }, { text: 'home.', wrong: false }])
    const join = (p: { text: string }[]) => p.map((x) => x.text).join('')
    expect(join(correctedParts('His shoes gets wet.', 'gets', 'get'))).toBe('His shoes get wet.')
    expect(correctedParts('His shoes gets wet.', 'gets', 'get').filter((p) => p.changed)).toEqual([{ text: 'get', changed: true }])
    expect(join(correctedParts('It ends on Friday, gets.', 'gets', 'too'))).toBe('It ends on Friday, too.')
    expect(join(correctedParts('See you on next week.', 'on', '—'))).toBe('See you next week.')
    // The first word deleted: the next one starts the sentence.
    expect(join(correctedParts('The life is short.', 'The', '—'))).toBe('Life is short.')
    expect(join(correctedParts('I am agree with you.', 'am agree', 'agree'))).toBe('I agree with you.')
  })

  it('keeps tap and typed keys apart', () => {
    expect(exerciseKey('She ___ here.', 'choose')).toBe(`tap:${exerciseKey('She ___ here.')}`)
  })
})

describe('write exercises', () => {
  it('keeps a task and a rubric, nothing to check against', () => {
    expect(cleanExercise({ type: 'write', prompt: '  Напиши предложение  о погоде. ', rubric: ' Use the past simple. ', answer: 'ignored', options: ['x'] }))
      .toEqual({ item: { type: 'write', prompt: 'Напиши предложение о погоде.', answer: '', accepted: [], explain: null, options: [], wrong: null, rubric: 'Use the past simple.' } })
    expect(cleanExercise({ type: 'write', text: 'Напиши вопрос.' })).toMatchObject({ item: { prompt: 'Напиши вопрос.', rubric: null } })
    expect(cleanExercise({ type: 'write', prompt: ' ' })).toEqual({ error: 'the task is empty' })
    expect(cleanExercise({ type: 'write', prompt: 'x'.repeat(501) })).toMatchObject({ error: expect.stringMatching(/500/) })
    expect(cleanExercise({ type: 'write', prompt: 'x', rubric: 'y'.repeat(501) })).toMatchObject({ error: expect.stringMatching(/rubric/) })
  })

  it('is its own family', () => {
    expect(isWriteType('write')).toBe(true)
    expect(isTapType('write')).toBe(false)
    expect(exerciseKey('Напиши  вопрос.', 'write')).toBe(`write:${exerciseKey('напиши вопрос')}`)
    expect(exerciseKey('x', 'write')).not.toBe(exerciseKey('x', 'choose'))
  })
})
