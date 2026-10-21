import { describe, expect, it } from 'vitest'
import { duplicateFact, emptyFactFilter, filterFacts, groupByDeck } from './factFilter.ts'
import type { CardSummary, FactItem } from './types.ts'

const card = (p: Partial<CardSummary>): CardSummary => ({
  id: 'cd', direction: 'forward', enabled: true, suspended: false, state: 'new', due: '', stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, retrievability: null, ...p,
})
let n = 0
const fact = (deckId: string, front: string, p: Partial<FactItem> = {}): FactItem => ({
  id: `ft_${++n}`, deckId, deckName: deckId === 'dk_c' ? 'Concurrency' : 'Java Core', front, back: 'answer', tags: [], status: 'active', createdBy: 'import',
  createdAt: `2026-07-0${n}T00:00:00.000Z`, updatedAt: '', card: card({}), ...p,
})

describe('filterFacts', () => {
  const all = [
    fact('dk_j', 'What is the JMM?', { back: 'Happens-before **ordering**.' }),
    fact('dk_c', 'What is a deadlock?', { card: card({ state: 'review', retrievability: 0.95 }), tags: ['locks'] }),
    fact('dk_c', 'What is a livelock?', { card: card({ state: 'review', retrievability: 0.6 }) }),
    fact('dk_c', 'What is CAS?', { status: 'inbox', card: card({ suspended: true }) }),
    fact('dk_j', 'What is a record?', { status: 'rejected' }),
  ]
  const fronts = (xs: FactItem[]) => xs.map((x) => x.front)

  it('searches question, answer and tags, every word anywhere', () => {
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), q: 'ORDERING jmm' }))).toEqual(['What is the JMM?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), q: 'locks' }))).toEqual(['What is a deadlock?'])
  })

  it('filters by topic, state and status; rejected hidden by default', () => {
    expect(fronts(filterFacts(all, emptyFactFilter(), ['dk_c', 'dk_j']))).toEqual(['What is a deadlock?', 'What is a livelock?', 'What is CAS?', 'What is the JMM?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), deck: 'dk_j', status: 'all' }))).toEqual(['What is the JMM?', 'What is a record?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), state: 'known' }))).toEqual(['What is a deadlock?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), state: 'fading' }))).toEqual(['What is a livelock?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), state: 'suspended' }))).toEqual(['What is CAS?'])
    expect(fronts(filterFacts(all, { ...emptyFactFilter(), status: 'inbox' }))).toEqual(['What is CAS?'])
  })

  it('groups consecutive facts by topic', () => {
    const g = groupByDeck(filterFacts(all, emptyFactFilter(), ['dk_c', 'dk_j']))
    expect(g.map((x) => [x.deckName, x.facts.length])).toEqual([['Concurrency', 3], ['Java Core', 1]])
  })

  it('finds a duplicate question in the same topic only', () => {
    expect(duplicateFact(all, 'dk_c', '  what is a DEADLOCK ')?.front).toBe('What is a deadlock?')
    expect(duplicateFact(all, 'dk_j', 'What is a deadlock?')).toBeNull()
    expect(duplicateFact(all, 'dk_c', 'What is a deadlock?', all[1]!.id)).toBeNull()
    expect(duplicateFact(all, 'dk_c', '   ')).toBeNull()
  })
})
