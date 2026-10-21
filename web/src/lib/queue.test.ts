import { newCardState, type CardState, type Direction, type Fact, type QueueItem, type Word, type WordQueueItem } from '@recall/core'
import { describe, expect, it } from 'vitest'
import { applyRating, buildQueue, counts, deckCounts, dropWord, emptyQueue, LEARN_AHEAD_MS, nextItem, patchFact, patchWord, waiting } from './queue.ts'

const day = { timeZone: 'Europe/Moscow', startHour: 4 }
// 13:00 MSK; the study day ends at 04:00 MSK tomorrow.
const now = new Date('2026-10-21T10:00:00Z')
const min = (n: number) => new Date(now.getTime() + n * 60_000)

function word(id: string): Word {
  return {
    id,
    deckId: 'dk_1',
    term: 'to frown',
    pos: 'verb',
    translations: ['хмуриться'],
    ipa: 'fraʊn',
    examples: [],
    note: null,
    tags: [],
    freqRank: 9000,
    cefr: 'B2',
    status: 'active',
    createdBy: 'user',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

function reviewState(dueAt: Date): CardState {
  return {
    due: dueAt.toISOString(),
    stability: 5,
    difficulty: 5,
    elapsedDays: 5,
    scheduledDays: 5,
    learningSteps: 0,
    reps: 4,
    lapses: 0,
    state: 2,
    lastReview: new Date(dueAt.getTime() - 5 * 86_400_000).toISOString(),
  }
}

function learningState(dueAt: Date): CardState {
  return { ...reviewState(dueAt), state: 3, stability: 1, scheduledDays: 0, lastReview: min(-10).toISOString() }
}

function item(cardId: string, wordId: string, schedule: CardState, ordinal = 0): QueueItem {
  const direction: Direction = ordinal ? 'reverse' : 'forward'
  return { kind: 'word', card: { id: cardId, wordId, factId: null, direction, suspended: false, schedule }, word: word(wordId), deckName: 'English' }
}

const ids = (xs: QueueItem[]) => xs.map((x) => x.card.id)

describe('buildQueue', () => {
  it('splits time-gated learning cards from the main queue and keeps server order', () => {
    const q = buildQueue(
      [item('l1', 'n1', learningState(min(5))), item('r1', 'n2', reviewState(min(-60))), item('new1', 'n3', newCardState(now)), item('r2', 'n4', reviewState(min(-30)))],
      {},
      {},
      now,
      day,
    )
    expect(ids(q.main)).toEqual(['r1', 'new1', 'r2'])
    expect(ids(q.learning)).toEqual(['l1'])
    expect(counts(q)).toEqual({ new: 1, learning: 1, review: 2 })
  })

  it('buries siblings: one card per word, and none whose sibling was reviewed today', () => {
    const q = buildQueue(
      [item('a0', 'nA', reviewState(min(-60)), 0), item('a1', 'nA', reviewState(min(-50)), 1), item('b1', 'nB', newCardState(now), 1)],
      { nB: 'b0' },
      {},
      now,
      day,
    )
    expect(ids(q.main)).toEqual(['a0'])
  })

  it('never buries learning cards, but they bury later review/new siblings', () => {
    const q = buildQueue(
      [item('a1', 'nA', learningState(min(2)), 1), item('a0', 'nA', reviewState(min(-60)), 0)],
      { nA: 'a2' },
      {},
      now,
      day,
    )
    expect(ids(q.learning)).toEqual(['a1'])
    expect(q.main).toEqual([])
  })

  it('lets the reviewed card itself come back as learning', () => {
    const q = buildQueue([item('b0', 'nB', learningState(min(3)))], { nB: 'b0' }, {}, now, day)
    expect(ids(q.learning)).toEqual(['b0'])
  })

  it('prefers a newer local state and drops cards it no longer makes due today', () => {
    const graduated: CardState = { ...reviewState(new Date(now.getTime() + 3 * 86_400_000)), lastReview: now.toISOString() }
    const q = buildQueue([item('r1', 'n1', reviewState(min(-60))), item('r2', 'n2', reviewState(min(-60)))], {}, { r1: graduated }, now, day)
    expect(ids(q.main)).toEqual(['r2'])
  })

  it('ignores a local state older than the server one', () => {
    const stale: CardState = { ...reviewState(new Date(now.getTime() + 3 * 86_400_000)), lastReview: '2026-01-01T00:00:00Z' }
    const q = buildQueue([item('r1', 'n1', reviewState(min(-60)))], {}, { r1: stale }, now, day)
    expect(ids(q.main)).toEqual(['r1'])
  })

  it('drops what `keep` rejects, e.g. a direction turned off', () => {
    const q = buildQueue([item('f', 'n1', reviewState(min(-5)), 0), item('r', 'n2', reviewState(min(-5)), 1)], {}, {}, now, day, (x) => x.card.direction === 'forward')
    expect(ids(q.main)).toEqual(['f'])
  })

  it('skips suspended and duplicate cards', () => {
    const s = item('s', 'n9', reviewState(min(-5)))
    s.card.suspended = true
    const r = item('r', 'n8', reviewState(min(-5)))
    expect(ids(buildQueue([s, r, r], {}, {}, now, day).main)).toEqual(['r'])
  })
})

describe('nextItem', () => {
  it('shows a learning card first once it is due', () => {
    const q = buildQueue([item('l1', 'n1', learningState(min(-1))), item('r1', 'n2', reviewState(min(-60)))], {}, {}, now, day)
    expect(nextItem(q, now)?.card.id).toBe('l1')
  })

  it('shows main cards before learning cards that are not due yet', () => {
    const q = buildQueue([item('l1', 'n1', learningState(min(5))), item('r1', 'n2', reviewState(min(-60)))], {}, {}, now, day)
    expect(nextItem(q, now)?.card.id).toBe('r1')
  })

  it('learns ahead when nothing else is left, but not beyond the window', () => {
    const q = buildQueue([item('l1', 'n1', learningState(min(5))), item('l2', 'n2', learningState(min(45)))], {}, {}, now, day)
    expect(nextItem(q, now)?.card.id).toBe('l1')
    const late = buildQueue([item('l2', 'n2', learningState(min(45)))], {}, {}, now, day)
    expect(nextItem(late, now)).toBeNull()
    expect(waiting(late, now).count).toBe(1)
    expect(nextItem(late, new Date(min(45).getTime() - LEARN_AHEAD_MS + 1000))?.card.id).toBe('l2')
  })

  it('returns null on an empty queue', () => {
    expect(nextItem(emptyQueue(), now)).toBeNull()
  })
})

describe('applyRating', () => {
  it('Again on a new card puts it back into learning within the session', () => {
    let q = buildQueue([item('new1', 'n1', newCardState(now)), item('r1', 'n2', reviewState(min(-60)))], {}, {}, now, day)
    const first = nextItem(q, now)!
    expect(first.card.id).toBe('new1')
    const res = applyRating(q, first, 1, now, day)
    q = res.queue
    expect(res.after.state).toBe(1)
    expect(ids(q.learning)).toEqual(['new1'])
    expect(q.learning[0].card.schedule).toEqual(res.after)
    // The review card comes next; the learning card waits for its step...
    expect(nextItem(q, now)?.card.id).toBe('r1')
    q = applyRating(q, nextItem(q, now)!, 3, now, day).queue
    // ...and is shown early once nothing else is left.
    expect(nextItem(q, min(0.5))?.card.id).toBe('new1')
  })

  it('a card graduating to a later day leaves the queue', () => {
    const q = buildQueue([item('r1', 'n1', reviewState(min(-60)))], {}, {}, now, day)
    const res = applyRating(q, q.main[0], 3, now, day)
    expect(new Date(res.after.due).getTime()).toBeGreaterThan(now.getTime() + 86_400_000)
    expect(res.queue.main).toEqual([])
    expect(res.queue.learning).toEqual([])
    expect(nextItem(res.queue, now)).toBeNull()
  })

  it('Again on a review card relearns it today', () => {
    const q = buildQueue([item('r1', 'n1', reviewState(min(-60)))], {}, {}, now, day)
    const res = applyRating(q, q.main[0], 1, now, day)
    expect(res.after.state).toBe(3)
    expect(ids(res.queue.learning)).toEqual(['r1'])
    expect(res.after.lapses).toBe(1)
  })

  it('buries the siblings of the rated card and records it', () => {
    const q: ReturnType<typeof emptyQueue> = {
      main: [item('a0', 'nA', reviewState(min(-60)), 0), item('b0', 'nB', reviewState(min(-60)))],
      learning: [item('a1', 'nA', learningState(min(2)), 1)],
      buried: {},
    }
    const res = applyRating(q, q.main[0], 3, now, day)
    expect(ids(res.queue.main)).toEqual(['b0'])
    // Learning siblings are mid-flight and stay, as on the server.
    expect(ids(res.queue.learning)).toEqual(['a1'])
    expect(res.queue.buried).toEqual({ nA: 'a0' })
  })

  it('removes review and new siblings from the queue', () => {
    const q: ReturnType<typeof emptyQueue> = {
      main: [item('a0', 'nA', reviewState(min(-60)), 0), item('a1', 'nA', newCardState(now), 1)],
      learning: [],
      buried: {},
    }
    expect(applyRating(q, q.main[0], 3, now, day).queue.main).toEqual([])
  })

  it('keeps learning cards ordered by due', () => {
    let q = buildQueue([item('n1', 'x1', newCardState(now)), item('n2', 'x2', newCardState(now))], {}, {}, now, day)
    q = applyRating(q, q.main[0], 3, now, day).queue // Good on new: ~10 min step
    q = applyRating(q, q.main[0], 1, min(1), day).queue // Again on new: ~1 min step
    expect(ids(q.learning)).toEqual(['n2', 'n1'])
  })

  it('does not mutate the previous state (undo restores it as is)', () => {
    const q = buildQueue([item('r1', 'n1', reviewState(min(-60))), item('r2', 'n2', reviewState(min(-60)))], {}, {}, now, day)
    const snapshot = structuredClone(q)
    applyRating(q, q.main[0], 1, now, day)
    expect(q).toEqual(snapshot)
  })
})

describe('patchWord / dropWord', () => {
  const list = [item('c1', 'n1', reviewState(min(-5))), item('c2', 'n1', newCardState(now), 1), item('c3', 'n2', reviewState(min(-1)))]

  it('swaps in the edited word on every card of it', () => {
    const edited = { ...word('n1'), translations: ['нахмуриться', 'хмуриться'] }
    const out = patchWord(list, edited)
    expect(ids(out)).toEqual(['c1', 'c2', 'c3'])
    expect((out[0] as WordQueueItem).word.translations[0]).toBe('нахмуриться')
    expect((out[1] as WordQueueItem).word).toBe(edited)
    expect(out[2]).toBe(list[2])
  })

  it('drops a word that is no longer active, and suspended cards', () => {
    expect(ids(patchWord(list, { ...word('n1'), status: 'rejected' }))).toEqual(['c3'])
    expect(ids(patchWord(list, word('n1'), new Set(['c2'])))).toEqual(['c1', 'c3'])
  })

  it('drops every card of a deleted word', () => {
    expect(ids(dropWord(list, 'n1'))).toEqual(['c3'])
  })
})

function fact(id: string, deckId = 'dk_t'): Fact {
  return { id, deckId, front: 'What is CAS?', back: 'Compare-and-swap.', tags: [], status: 'active', createdBy: 'import', createdAt: now.toISOString(), updatedAt: now.toISOString() }
}

function factItem(cardId: string, factId: string, schedule: CardState, deckId = 'dk_t'): QueueItem {
  return { kind: 'fact', card: { id: cardId, wordId: null, factId, direction: 'forward', suspended: false, schedule }, fact: fact(factId, deckId), deckName: 'Concurrency' }
}

describe('facts in the queue', () => {
  it('queues facts next to words and buries by the fact', () => {
    const items = [item('w1', 'n1', reviewState(min(-60))), factItem('f1', 'ft1', reviewState(min(-30))), factItem('f2', 'ft2', newCardState(now))]
    const q = buildQueue(items, {}, {}, now, day)
    expect(ids(q.main)).toEqual(['w1', 'f1', 'f2'])
    const r = applyRating(q, q.main[1]!, 3, now, day)
    expect(r.queue.buried).toEqual({ ft1: 'f1' })
    expect(ids(r.queue.main)).toEqual(['w1', 'f2'])
    // The queue rebuilt later today keeps the rated fact out unless it's learning again.
    expect(ids(buildQueue(items, r.queue.buried, {}, now, day).main)).toEqual(['w1', 'f2'])
  })

  it('counts what is left per deck', () => {
    const items = [item('w1', 'n1', reviewState(min(-60))), factItem('f1', 'ft1', learningState(min(-1))), factItem('f2', 'ft2', newCardState(now)), factItem('f3', 'ft3', newCardState(now), 'dk_u')]
    expect(deckCounts(buildQueue(items, {}, {}, now, day))).toEqual({
      dk_1: { new: 0, learning: 0, review: 1 },
      dk_t: { new: 1, learning: 1, review: 0 },
      dk_u: { new: 1, learning: 0, review: 0 },
    })
  })

  it('patches an edited fact, drops it when suspended, and leaves words alone', () => {
    const list = [item('w1', 'n1', reviewState(min(-5))), factItem('f1', 'ft1', reviewState(min(-1)))]
    const edited = { ...fact('ft1'), back: 'CAS: compare-and-set.' }
    const out = patchFact(list, edited)
    expect(out[0]).toBe(list[0])
    expect(out[1]).toMatchObject({ kind: 'fact', fact: { back: 'CAS: compare-and-set.' } })
    expect(ids(patchFact(list, edited, true))).toEqual(['w1'])
    expect(ids(patchWord(list, word('n1')))).toEqual(['w1', 'f1'])
    expect(ids(dropWord(list, 'ft1'))).toEqual(['w1'])
  })

  it('reads items cached before facts existed as words', async () => {
    const { normalizeItem } = await import('./api.ts')
    const old = { card: { id: 'c', wordId: 'n1', direction: 'forward', suspended: false, schedule: newCardState(now) }, word: word('n1'), deckName: 'English' } as unknown as QueueItem
    expect(normalizeItem(old).kind).toBe('word')
    expect(ids(buildQueue([normalizeItem(old)], {}, {}, now, day).main)).toEqual(['c'])
  })
})
