// "+5 new today" and practice rounds outside the schedule.
import { describe, expect, it } from 'vitest'
import { addExercises } from '../src/exercises.ts'
import { createFact } from '../src/facts.ts'
import { practiceDeck, practiceRule } from '../src/practice.ts'
import { getDeck, listDecks, updateDeck } from '../src/repo.ts'
import { addExtraNew, buildQueue, decksWithCounts, reviewOptions, studyDay } from '../src/study.ts'
import { addWord, cardsOf, deck, listen, makeCtx, rate, send, TZ, type TestCtx } from './helpers.ts'

const today = (ctx: TestCtx) => studyDay(ctx.now(), TZ).key
const hours = (ctx: TestCtx, h: number) => new Date(ctx.now().getTime() + h * 3600_000)
const choose = (n: number) => ({ type: 'choose' as const, text: `Item ${n} ___ here.`, options: ['is', 'are'], answer: 'is' })

describe('extra new cards today', () => {
  it('raise the deck budget for the study day only, accumulating', () => {
    const ctx = makeCtx()
    const d = deck(ctx, 2)
    for (let i = 0; i < 6; i++) addWord(ctx, `w${i}`, { at: new Date(ctx.now().getTime() + i) })
    const fresh = () => buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).counts.new
    expect(fresh()).toBe(2)
    expect(getDeck(ctx.db, ctx.user.id, d.id, today(ctx))!.extraNewToday).toBe(0)
    addExtraNew(ctx.db, ctx.user.id, d.id, today(ctx), 3)
    expect(fresh()).toBe(5)
    addExtraNew(ctx.db, ctx.user.id, d.id, today(ctx), 5)
    // One card per word a day: six words, six new cards at most.
    expect(fresh()).toBe(6)
    expect(listDecks(ctx.db, ctx.user.id, today(ctx))[0]!.extraNewToday).toBe(8)
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]).toMatchObject({ extraNewToday: 8, counts: { new: 6 } })
    expect(reviewOptions(ctx.db, ctx.user.id, TZ, ctx.now(), d.id, null).counts.new).toBe(6)
    expect(buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).decks[0]!.counts.new).toBe(6)
    // Cards introduced today count against the raised budget.
    updateDeck(ctx.db, ctx.user.id, d.id, { newPerDay: 0 })
    rate(ctx, cardsOf(ctx, buildQueue(ctx.db, ctx.user.id, TZ, ctx.now()).items[0]!.card.wordId!)[0]!.id, 3, ctx.now())
    expect(fresh()).toBe(5)
    // Tomorrow it's gone.
    ctx.clock.t = hours(ctx, 24)
    expect(fresh()).toBe(0)
    expect(decksWithCounts(ctx.db, ctx.user.id, TZ, ctx.now())[0]!.extraNewToday).toBe(0)
    expect(() => addExtraNew(ctx.db, 'us_other', d.id, today(ctx), 5)).toThrow(/not found/)
  })

  it('is a route returning the deck', async () => {
    const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' })
    const s = await listen(ctx)
    try {
      const d = deck(ctx, 1)
      const post = async (body: object, id = d.id) => {
        const r = await send(`${s.url}/api/decks/${id}/extra-new`, 'POST', body)
        return { status: r.status, body: (await r.json()) as any }
      }
      expect(await post({})).toMatchObject({ status: 200, body: { deck: { id: d.id, newPerDay: 1, extraNewToday: 5 } } })
      expect(await post({ n: 3 })).toMatchObject({ body: { deck: { extraNewToday: 8 } } })
      for (const n of [0, 101, 1.5]) expect((await post({ n })).status).toBe(400)
      expect((await post({ x: 1 })).status).toBe(400)
      expect((await post({}, 'dk_nope')).status).toBe(404)
      const decks = (await (await fetch(`${s.url}/api/decks`)).json()) as any
      expect(decks.decks[0]).toMatchObject({ extraNewToday: 8 })
      const patched = (await (await send(`${s.url}/api/decks/${d.id}`, 'PATCH', { newPerDay: 3 })).json()) as any
      expect(patched.deck).toMatchObject({ newPerDay: 3, extraNewToday: 8 })
    } finally {
      await s.close()
    }
  })
})

describe('practice', () => {
  it('takes today\'s Again cards first, newest first, then most lapses and lowest recall; writes nothing', () => {
    const ctx = makeCtx()
    const d = deck(ctx, 20)
    const w = Object.fromEntries(['again1', 'again2', 'lapsed', 'fresh', 'weak', 'strong'].map((t, i) => [t, addWord(ctx, t, { at: new Date(ctx.now().getTime() + i) })]))
    const fwd = (t: string) => cardsOf(ctx, w[t]!.id)[0]!.id
    const rev = (t: string) => cardsOf(ctx, w[t]!.id)[1]!.id
    // Reviewed some days ago: strong is stable, weak is overdue (low recall now).
    const past = hours(ctx, -24 * 30)
    for (const t of ['lapsed', 'weak', 'strong', 'again1', 'again2']) rate(ctx, fwd(t), 3, past)
    rate(ctx, fwd('strong'), 4, hours(ctx, -24 * 20))
    rate(ctx, rev('strong'), 3, hours(ctx, -24 * 20))
    ctx.db.prepare('UPDATE cards SET lapses = 3 WHERE id = ?').run(fwd('lapsed'))
    rate(ctx, fwd('again1'), 1, hours(ctx, -3))
    rate(ctx, fwd('again2'), 1, hours(ctx, -1))
    // Rated Again yesterday: no head start.
    rate(ctx, rev('weak'), 1, hours(ctx, -24))
    const logs = () => ctx.db.prepare('SELECT count(*) AS n FROM review_logs').get()
    const cards = () => ctx.db.prepare('SELECT * FROM cards ORDER BY id').all()
    const before = { logs: logs(), cards: cards() }

    const items = practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now())
    const terms = items.map((i) => (i.kind === 'word' ? i.word.term : ''))
    expect(terms.slice(0, 3)).toEqual(['again2', 'again1', 'lapsed'])
    // One card per word; never-reviewed words are left out.
    expect(terms.sort()).toEqual(['again1', 'again2', 'lapsed', 'strong', 'weak'])
    expect(new Set(items.map((i) => i.card.id)).size).toBe(5)
    const rest = practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now()).slice(3).map((i) => (i.kind === 'word' ? i.word.term : ''))
    expect(rest[rest.length - 1]).toBe('strong')
    expect(practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now(), { limit: 2 })).toHaveLength(2)
    expect({ logs: logs(), cards: cards() }).toEqual(before)

    // Suspended cards and the deck's filter count; rules get exercises.
    ctx.db.prepare('UPDATE cards SET suspended = 1 WHERE id = ?').run(fwd('again2'))
    expect(practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now())[0]).toMatchObject({ word: { term: 'again1' } })
    const { fact, cardId } = createFact(ctx.db, ctx.user.id, { deckId: d.id, fact: { front: 'Invented rule', back: 'Text', tags: ['Grammar'] }, status: 'active', createdBy: 'user' }, ctx.now())
    addExercises(ctx.db, ctx.user.id, fact.id, [choose(1), choose(2), choose(3)], 'user', ctx.now())
    rate(ctx, cardId, 1, hours(ctx, -0.5))
    updateDeck(ctx.db, ctx.user.id, d.id, { reviewFilter: { types: ['rule'] } })
    expect(practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now())).toMatchObject([{ kind: 'fact', fact: { id: fact.id }, exercises: [{}, {}, {}] }])
    // Two types: either of them.
    updateDeck(ctx.db, ctx.user.id, d.id, { reviewFilter: { types: ['rule', 'word'] } })
    expect(practiceDeck(ctx.db, ctx.user.id, d.id, TZ, ctx.now()).map((i) => i.kind).sort()).toEqual(['fact', 'word', 'word', 'word', 'word'])
  })

  it('gives one rule three rounds with different exercises', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    const make = (n: number) => {
      const { fact } = createFact(ctx.db, ctx.user.id, { deckId: d.id, fact: { front: `Invented rule ${n}`, back: 'Text' }, status: 'active', createdBy: 'user' }, ctx.now())
      if (n) addExercises(ctx.db, ctx.user.id, fact.id, Array.from({ length: n }, (_, i) => choose(i)), 'user', ctx.now())
      return fact.id
    }
    const big = practiceRule(ctx.db, ctx.user.id, make(9))
    expect(big).toHaveLength(3)
    const ids = big.flatMap((i) => i.exercises!.map((e) => e.id))
    expect(new Set(ids).size).toBe(9)
    expect(big[0]).toMatchObject({ kind: 'fact', fact: { front: 'Invented rule 9' }, card: { factId: expect.any(String) } })
    // A small pool repeats items, but every round is full.
    const small = practiceRule(ctx.db, ctx.user.id, make(4))
    expect(small.map((i) => i.exercises!.length)).toEqual([3, 3, 3])
    expect(new Set(small.slice(0, 2).flatMap((i) => i.exercises!.map((e) => e.id))).size).toBe(4)
    expect(practiceRule(ctx.db, ctx.user.id, make(0))).toEqual([])
    expect(() => practiceRule(ctx.db, ctx.user.id, 'ft_nope')).toThrow(/not found/)
    expect(() => practiceRule(ctx.db, 'us_other', make(3))).toThrow(/not found/)
  })

  it('never serves typed items of a tap rule, even once the unused tap items run short', () => {
    const ctx = makeCtx()
    const d = deck(ctx)
    const { fact } = createFact(ctx.db, ctx.user.id, { deckId: d.id, fact: { front: 'Invented rule', back: 'Text' }, status: 'active', createdBy: 'user' }, ctx.now())
    addExercises(ctx.db, ctx.user.id, fact.id, [choose(1), choose(2), choose(3), choose(4),
      ...Array.from({ length: 4 }, (_, i) => ({ type: 'gap' as const, prompt: `Typed ${i} ___ here. (hint)`, answer: 'x' }))], 'user', ctx.now())
    for (let i = 0; i < 10; i++) {
      const sets = practiceRule(ctx.db, ctx.user.id, fact.id)
      expect(sets.map((s) => s.exercises!.length)).toEqual([3, 3, 3])
      expect(sets.flatMap((s) => s.exercises!.map((e) => e.type)).every((t) => t === 'choose')).toBe(true)
    }
  })

  it('is a route', async () => {
    const ctx = makeCtx({ DEV: '1', OWNER_TELEGRAM_ID: '1001' })
    const s = await listen(ctx)
    try {
      const d = deck(ctx)
      const word = addWord(ctx, 'cat')
      rate(ctx, cardsOf(ctx, word.id)[0]!.id, 1, hours(ctx, -1))
      const get = async (q: string) => {
        const r = await fetch(`${s.url}/api/practice${q}`)
        return { status: r.status, body: (await r.json()) as any }
      }
      expect(await get(`?deck=${d.id}`)).toMatchObject({ status: 200, body: { items: [{ kind: 'word', word: { term: 'cat' } }] } })
      expect((await get('?deck=English&limit=500')).body.items).toHaveLength(1)
      expect((await get('')).body.items).toHaveLength(1)
      expect((await get('?deck=nope')).status).toBe(404)
      expect((await get('?fact=ft_nope')).status).toBe(404)
    } finally {
      await s.close()
    }
  })
})
