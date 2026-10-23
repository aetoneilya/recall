import { newCardState, type CardState, type Direction, type Fact, type QueueItem, type Word, type WordQueueItem } from '@recall/core'
import { describe, expect, it } from 'vitest'
import { applyRating, buildQueue, counts, deckCounts, dropWord, emptyQueue, GAP_MS, keepExercises, LEARN_AHEAD_MS, nextItem, patchFact, patchWord, peekNext, practiceStep, rested, upcoming, withSchedules, type QueueState, type Shown } from './queue.ts'

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
    expect(upcoming(late, now)).toMatchObject({ item: { card: { id: 'l2' } }, at: new Date(min(45).getTime() - LEARN_AHEAD_MS) })
    expect(nextItem(late, new Date(min(45).getTime() - LEARN_AHEAD_MS + 1000))?.card.id).toBe('l2')
  })

  it('returns null on an empty queue', () => {
    expect(nextItem(emptyQueue(), now)).toBeNull()
  })
})

describe('the minimum gap', () => {
  const shown = (...xs: [string, number][]): Shown[] => xs.map(([cardId, m]) => ({ cardId, at: min(m).getTime() }))

  it('rests a card until two other cards were rated since, or 60 s passed', () => {
    const t = now.getTime()
    expect(rested('a', [], t)).toBe(true)
    expect(rested('a', shown(['a', 0]), t)).toBe(false)
    expect(rested('a', shown(['a', 0], ['b', 0]), t)).toBe(false)
    expect(rested('a', shown(['a', 0], ['b', 0], ['c', 0]), t)).toBe(true)
    expect(rested('a', shown(['a', 0], ['b', 0]), t + GAP_MS - 1)).toBe(false)
    expect(rested('a', shown(['a', 0], ['b', 0]), t + GAP_MS)).toBe(true)
    // Counted from its latest rating.
    expect(rested('a', shown(['a', -5], ['b', -5], ['c', -5], ['a', 0]), t)).toBe(false)
  })

  it('never learns ahead the card just rated: the prod loop on a 6-minute Hard step', () => {
    // "to rumble" rated Hard, back in 6 min; nothing else left.
    const q: QueueState = { main: [], learning: [item('rumble', 'n1', learningState(min(6)), 1)], buried: {} }
    const recent = shown(['rumble', 0])
    expect(nextItem(q, now, recent)).toBeNull()
    expect(nextItem(q, min(1), recent)).toBeNull()
    // It waits for its own due (no learn-ahead), then comes by itself.
    expect(upcoming(q, now, recent)).toMatchObject({ item: { card: { id: 'rumble' } }, at: min(6) })
    expect(nextItem(q, min(6), recent)?.card.id).toBe('rumble')
  })

  it('stops two learning cards from alternating every few seconds', () => {
    const q: QueueState = { main: [], learning: [item('strain', 'n1', learningState(min(6))), item('court', 'n2', learningState(min(6)))], buried: {} }
    // strain then court were just rated: neither may come back yet.
    const recent = shown(['strain', 0], ['court', 0.05])
    expect(nextItem(q, min(0.1), recent)).toBeNull()
    // strain is rested once 60 s passed since its rating, and is learned ahead then.
    expect(upcoming(q, min(0.1), recent)).toMatchObject({ item: { card: { id: 'strain' } }, at: min(1) })
    expect(nextItem(q, min(1), recent)?.card.id).toBe('strain')
  })

  it('learns ahead a different card that is rested', () => {
    const q: QueueState = { main: [], learning: [item('a', 'n1', learningState(min(3))), item('b', 'n2', learningState(min(5)))], buried: {} }
    expect(nextItem(q, now, shown(['b', -2], ['x', -1], ['y', -1], ['a', 0]))?.card.id).toBe('b')
  })

  it('keeps the gap for a due learning card, showing the main queue meanwhile', () => {
    const q: QueueState = { main: [item('r1', 'n2', reviewState(min(-60)))], learning: [item('a', 'n1', learningState(min(-1)))], buried: {} }
    expect(nextItem(q, now, shown(['a', -0.5]))?.card.id).toBe('r1')
    expect(nextItem(q, now, shown(['a', -0.5], ['b', -0.4], ['c', -0.2]))?.card.id).toBe('a')
  })

  it('applyRating then nextItem: the card just rated waits while another is showable', () => {
    let q = buildQueue([item('a', 'n1', newCardState(now)), item('b', 'n2', newCardState(now))], {}, {}, now, day)
    const recent: Shown[] = []
    for (const [id, r] of [['a', 1], ['b', 1]] as const) {
      const cur = nextItem(q, now, recent)!
      expect(cur.card.id).toBe(id)
      q = applyRating(q, cur, r, now, day).queue
      recent.push({ cardId: cur.card.id, at: now.getTime() })
    }
    // Both on a 1-minute step, both just rated: a waits for its 60 s, b too.
    expect(nextItem(q, min(0.2), recent)).toBeNull()
    expect(nextItem(q, min(1), recent)?.card.id).toBe('a')
  })

  it('shows nothing upcoming when the day is done', () => {
    expect(upcoming(emptyQueue(), now)).toBeNull()
  })
})

describe('peekNext', () => {
  it('is the card nextItem shows after the current one is rated', () => {
    const items = [item('l1', 'n1', learningState(min(4))), item('r1', 'n2', reviewState(min(-60))), item('r2', 'n3', reviewState(min(-30)))]
    let q = buildQueue(items, {}, {}, now, day)
    const recent: Shown[] = []
    for (let i = 0; i < 3; i++) {
      const cur = nextItem(q, now, recent)!
      const peek = peekNext(q, cur, now, recent)
      for (const r of [1, 2, 3, 4] as const) {
        const after = applyRating(q, cur, r, now, day).queue
        expect(nextItem(after, now, [...recent, { cardId: cur.card.id, at: now.getTime() }])?.card.id).toBe(peek?.card.id)
      }
      q = applyRating(q, cur, 3, now, day).queue
      recent.push({ cardId: cur.card.id, at: now.getTime() })
    }
  })

  it('never names the current card, nor its buried sibling', () => {
    const q: QueueState = { main: [item('a0', 'nA', reviewState(min(-60))), item('a1', 'nA', newCardState(now), 1)], learning: [], buried: {} }
    expect(peekNext(q, q.main[0]!, now)).toBeNull()
    const solo: QueueState = { main: [], learning: [item('l', 'n1', learningState(min(-1)))], buried: {} }
    expect(peekNext(solo, solo.learning[0]!, now)).toBeNull()
  })
})

describe('state-0 cards and cards reviewed today', () => {
  it('keeps a new card whatever its due, also beyond the day end', () => {
    const later = { ...newCardState(now), due: new Date(now.getTime() + 3 * 86_400_000).toISOString() }
    const q = buildQueue([item('superb', 'n1', later)], {}, {}, now, day)
    expect(ids(q.main)).toEqual(['superb'])
    expect(counts(q)).toEqual({ new: 1, learning: 0, review: 0 })
  })

  it('holds a review card rated today until it is due again, counted as learning', () => {
    const again: CardState = { ...reviewState(min(5 * 60)), lastReview: min(-60).toISOString() }
    const q = buildQueue([item('r1', 'n1', again), item('r2', 'n2', reviewState(min(-60)))], {}, {}, now, day)
    expect(ids(q.main)).toEqual(['r2'])
    expect(ids(q.learning)).toEqual(['r1'])
    expect(counts(q)).toEqual({ new: 0, learning: 1, review: 1 })
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

describe('exercise items in the queue', () => {
  it('keep their exercises through building, rating and normalising', async () => {
    const { normalizeItem } = await import('./api.ts')
    const exercises = [{ id: 'ex_1', type: 'gap' as const, prompt: 'She ___ here. (live)', answer: 'lives', accepted: [], explain: null }]
    const it = { ...factItem('f1', 'ft1', newCardState(now)), exercises } as QueueItem
    const q = buildQueue([normalizeItem(it)], {}, {}, now, day)
    expect(q.main[0]).toMatchObject({ kind: 'fact', exercises })
    const r = applyRating(q, q.main[0]!, 3, now, day)
    expect(r.item).toMatchObject({ exercises })
  })
})

describe('the card on screen across a refresh', () => {
  it('keeps the exercises it is answered with, though the server picked new ones', () => {
    const mine = [{ id: 'ex_1', type: 'gap' as const, prompt: 'a', answer: 'a', accepted: [], explain: null }]
    const theirs = [{ id: 'ex_9', type: 'gap' as const, prompt: 'b', answer: 'b', accepted: [], explain: null }]
    const cur = { ...factItem('f1', 'ft1', newCardState(now)), exercises: mine } as QueueItem
    const fresh = { ...factItem('f1', 'ft1', newCardState(now)), exercises: theirs } as QueueItem
    expect(keepExercises(cur, fresh)).toMatchObject({ exercises: mine })
    const plain = factItem('f2', 'ft2', newCardState(now))
    expect(keepExercises(plain, fresh)).toBe(fresh)
  })

  it('puts schedules rated here into cached items (a new day keeps them applied)', () => {
    const a = factItem('f1', 'ft1', newCardState(now))
    const b = factItem('f2', 'ft2', newCardState(now))
    const rated = reviewState(min(60 * 24 * 3))
    const out = withSchedules([a, b], { f1: rated })
    expect(out[0]!.card.schedule).toEqual(rated)
    expect(out[1]).toBe(b)
  })
})

describe('practice', () => {
  it('drops a card got right and brings Again back three cards later', () => {
    expect(practiceStep(['a', 'b', 'c', 'd', 'e'], true)).toEqual(['b', 'c', 'd', 'e'])
    expect(practiceStep(['a', 'b', 'c', 'd', 'e'], false)).toEqual(['b', 'c', 'd', 'a', 'e'])
    expect(practiceStep(['a', 'b'], false)).toEqual(['b', 'a'])
    expect(practiceStep(['a'], false)).toEqual(['a'])
    expect(practiceStep([], true)).toEqual([])
  })
})
