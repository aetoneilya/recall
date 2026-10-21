import { describe, expect, it } from 'vitest'
import { markTerm } from './mark.ts'

describe('markTerm', () => {
  it('marks the inflected term inside an example', () => {
    expect(markTerm('She frowned at him.', 'to frown')).toEqual([
      { text: 'She ', hit: false },
      { text: 'frowned', hit: true },
      { text: ' at him.', hit: false },
    ])
    expect(markTerm('Frowning, he left.', 'to frown')).toEqual([
      { text: 'Frowning', hit: true },
      { text: ', he left.', hit: false },
    ])
    expect(markTerm('He cried and cried', 'to cry').filter((p) => p.hit).map((p) => p.text)).toEqual(['cried', 'cried'])
    expect(markTerm('Nothing here.', 'to frown')).toEqual([{ text: 'Nothing here.', hit: false }])
  })
})
