import { describe, expect, it } from 'vitest'
import { checkExercise, cleanExercise, exerciseKey, exerciseRating, exerciseReadings, normalizeExercise } from './exercises.ts'

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
})

describe('exercise items', () => {
  it('validates the shape of each type', () => {
    expect(cleanExercise({ type: 'gap', prompt: ' She  ___ here. (live) ', answer: ' lives ', accepted: ['lives', 'resides', ''] }))
      .toEqual({ item: { type: 'gap', prompt: 'She ___ here. (live)', answer: 'lives', accepted: ['resides'], explain: null } })
    expect(cleanExercise({ type: 'gap', prompt: 'No gap here', answer: 'x' })).toEqual({ error: 'a gap prompt needs exactly one ___' })
    expect(cleanExercise({ type: 'rewrite', prompt: 'He left. → He has ___', answer: 'left' })).toMatchObject({ item: { type: 'rewrite' } })
    expect(cleanExercise({ type: 'rewrite', prompt: 'He left. He has ___', answer: 'left' })).toMatchObject({ error: expect.stringMatching(/rewrite/) })
    expect(cleanExercise({ type: 'fix', prompt: 'She go home.', answer: 'she go home' })).toEqual({ error: 'a fix answer must differ from its prompt' })
    expect(cleanExercise({ type: 'quiz' as never, prompt: 'x', answer: 'y' })).toMatchObject({ error: expect.stringMatching(/type/) })
    expect(exerciseKey('She ____ here.  (live)')).toBe(exerciseKey('she ___ here (live)'))
  })
})
