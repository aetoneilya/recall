import { describe, expect, it } from 'vitest'
import { emptyForm, formFrom, formToInput, guessPos, newTranslations, withContext, withDraftTags } from './wordForm.ts'

describe('word form', () => {
  it('replaces an autofilled topic when the sense changes, keeping provenance and manual topics', () => {
    expect(withDraftTags('Books/Novel', [], ['Topic/Travel']))
      .toEqual({ tags: 'Books/Novel, Topic/Travel', autoTags: ['Topic/Travel'] })
    expect(withDraftTags('Books/Novel, Topic/Travel', ['Topic/Travel'], ['Topic/Education']))
      .toEqual({ tags: 'Books/Novel, Topic/Education', autoTags: ['Topic/Education'] })
    expect(withDraftTags('Books/Novel, Topic/Travel', [], ['Topic/Travel']))
      .toEqual({ tags: 'Books/Novel, Topic/Travel', autoTags: [] })
    expect(withDraftTags('Books/Novel, Topic/Custom', [], ['Topic/Education']))
      .toEqual({ tags: 'Books/Novel, Topic/Custom', autoTags: [] })
    expect(formToInput(formFrom({ term: 'ticket', pos: 'noun', translations: ['билет'], ipa: null, examples: [], note: null, cefr: 'A1', tags: ['Topic/Travel'] })).tags)
      .toEqual(['Topic/Travel'])
  })

  it('guesses a part of speech for manual entry', () => {
    expect(guessPos('to frown')).toBe('verb')
    expect(guessPos('to put up')).toBe('phrasal_verb')
    expect(guessPos('a far cry from')).toBe('phrase')
    expect(guessPos('moor')).toBe('noun')
  })

  it('round-trips a draft and drops empty fields', () => {
    const f = formFrom({ term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'She frowned.', translation: null }], note: null, cefr: 'B2', tags: ['Wuthering Heights'] })
    expect(f.tags).toBe('Wuthering Heights')
    f.examples.push({ text: '  ', translation: 'x' })
    f.translations.push(' ')
    f.ipa = '/fraʊn/'
    expect(formToInput(f)).toEqual({
      term: 'to frown', pos: 'verb', translations: ['хмуриться'], ipa: 'fraʊn', examples: [{ text: 'She frowned.', translation: null }],
      note: null, tags: ['Wuthering Heights'], cefr: 'B2',
    })
    expect(formToInput(emptyForm('x')).cefr).toBeNull()
  })

  it('puts the context sentence first', () => {
    const ex = [{ text: 'A.', translation: 'а' }, { text: 'She frowned at me.', translation: 'Она нахмурилась.' }]
    expect(withContext(ex, ' she frowned at me. ')).toEqual([{ text: 'she frowned at me.', translation: 'Она нахмурилась.' }, { text: 'A.', translation: 'а' }])
    expect(withContext(ex, '')).toBe(ex)
  })

  it('finds the translations an existing word lacks', () => {
    expect(newTranslations(['Хмуриться'], ['хмуриться', 'морщить лоб', ''])).toEqual(['морщить лоб'])
  })
})
