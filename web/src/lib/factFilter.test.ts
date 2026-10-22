import { describe, expect, it } from 'vitest'
import { duplicateFact, factMatches } from './factFilter.ts'
import type { CardSummary, FactItem } from './types.ts'

const card = (p: Partial<CardSummary>): CardSummary => ({
  id: 'cd', direction: 'forward', enabled: true, suspended: false, state: 'new', due: '', stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, retrievability: null, ...p,
})
let n = 0
const fact = (deckId: string, front: string, p: Partial<FactItem> = {}): FactItem => ({
  id: `ft_${++n}`, deckId, deckName: deckId === 'dk_c' ? 'Concurrency' : 'Java Core', front, back: 'answer', tags: [], status: 'active', createdBy: 'import',
  createdAt: `2026-07-0${n}T00:00:00.000Z`, updatedAt: '', card: card({}), ...p,
})

describe('facts on the device', () => {
  const all = [
    fact('dk_j', 'What is the JMM?', { back: 'Happens-before **ordering**.' }),
    fact('dk_c', 'What is a deadlock?', { card: card({ state: 'review', retrievability: 0.95 }), tags: ['locks'] }),
    fact('dk_c', 'What is a livelock?', { card: card({ state: 'review', retrievability: 0.6 }) }),
    fact('dk_c', 'What is CAS?', { card: card({ suspended: true }) }),
    fact('dk_j', 'What is a record?', { status: 'rejected' }),
  ]

  it('searches question, answer and tags, every word anywhere', () => {
    expect(all.filter((x) => factMatches(x, 'ORDERING jmm')).map((x) => x.front)).toEqual(['What is the JMM?'])
    expect(all.filter((x) => factMatches(x, 'locks')).map((x) => x.front)).toEqual(['What is a deadlock?'])
  })

  it('finds a duplicate question in the same deck only', () => {
    expect(duplicateFact(all, 'dk_c', '  what is a DEADLOCK ')?.front).toBe('What is a deadlock?')
    expect(duplicateFact(all, 'dk_j', 'What is a deadlock?')).toBeNull()
    expect(duplicateFact(all, 'dk_c', 'What is a deadlock?', all[1]!.id)).toBeNull()
    expect(duplicateFact(all, 'dk_c', '   ')).toBeNull()
  })
})
