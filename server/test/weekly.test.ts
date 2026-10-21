// The weekly report: when it fires (per user, local day and time, once per
// week, catch-up within 48 h) and what it says.
import { describe, expect, it } from 'vitest'
import { cardsOf } from './helpers.ts'
import { getUser, setBotStarted, updateUserSettings, ensureUser } from '../src/users.ts'
import { decideWeekly, localClock, suggestion, weeklyData, weeklyText, weeklyTick, type WeeklyData } from '../src/weekly.ts'
import { addWord, makeCtx, rate } from './helpers.ts'

const on = { timeZone: 'Europe/Moscow', weeklyReport: true, weeklyReportDay: 0, weeklyReportTime: '19:00' }
const started = { weeklySentWeek: null, botStartedAt: '2026-09-01T00:00:00.000Z' }
// 2026-10-25 is a Sunday.
const msk = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+03:00`)

describe('weekly report schedule', () => {
  it('reads the local weekday', () => {
    expect(localClock(msk('2026-10-25', '19:00'), 'Europe/Moscow')).toEqual({ date: '2026-10-25', weekday: 0, minutes: 19 * 60 })
    expect(localClock(new Date('2026-10-24T22:30:00Z'), 'Asia/Tokyo')).toEqual({ date: '2026-10-25', weekday: 0, minutes: 7 * 60 + 30 })
  })

  it('fires on Sunday at 19:00 local, once, and catches up for 48 hours', () => {
    expect(decideWeekly(msk('2026-10-25', '19:00'), on, started)).toEqual({ week: '2026-10-25', send: true })
    expect(decideWeekly(msk('2026-10-25', '19:00'), on, { ...started, weeklySentWeek: '2026-10-25' })).toBeNull()
    // Just before: last week's slot, long past — consumed without a message.
    expect(decideWeekly(msk('2026-10-25', '18:59'), on, started)).toEqual({ week: '2026-10-18', send: false })
    expect(decideWeekly(msk('2026-10-25', '18:59'), on, { ...started, weeklySentWeek: '2026-10-18' })).toBeNull()
    // Server was down on Sunday evening: still sent on Monday or Tuesday afternoon…
    expect(decideWeekly(msk('2026-10-26', '10:00'), on, started)).toEqual({ week: '2026-10-25', send: true })
    expect(decideWeekly(msk('2026-10-27', '18:59'), on, started)).toEqual({ week: '2026-10-25', send: true })
    // …but not later.
    expect(decideWeekly(msk('2026-10-27', '19:00'), on, started)).toEqual({ week: '2026-10-25', send: false })
    // Started the bot after the slot: nothing for that week.
    expect(decideWeekly(msk('2026-10-26', '10:00'), on, { ...started, botStartedAt: msk('2026-10-26', '09:00').toISOString() })).toEqual({ week: '2026-10-25', send: false })
    // Off: nothing at all.
    expect(decideWeekly(msk('2026-10-25', '19:00'), { ...on, weeklyReport: false }, started)).toBeNull()
  })

  it('uses the user’s own day, time and zone', () => {
    const tokyo = { timeZone: 'Asia/Tokyo', weeklyReport: true, weeklyReportDay: 3, weeklyReportTime: '08:00' }
    // Wednesday 2026-10-21 08:00 in Tokyo = 23:00 UTC on Tuesday.
    expect(decideWeekly(new Date('2026-10-20T22:59:00Z'), tokyo, started)).toEqual({ week: '2026-10-14', send: false })
    expect(decideWeekly(new Date('2026-10-20T23:00:00Z'), tokyo, started)).toEqual({ week: '2026-10-21', send: true })
  })
})

const DATA: WeeklyData = {
  reviews: 214, lastWeekReviews: 180, newWords: 23, known: 312, knownChange: 14, streak: 5,
  retention: { forward: { rate: 0.92, reviews: 150 }, reverse: { rate: 0.71, reviews: 60 } },
  labels: { forward: 'EN→RU', reverse: 'RU→EN' }, estimate: 8400, estimateChange: 350,
  hardest: [{ term: 'tenacious', again: 4 }, { term: 'aloof', again: 3 }, { term: 'wary', again: 2 }],
  inbox: 2, typeAnswer: 'off', lastTestAt: '2026-10-01T00:00:00.000Z', totalWords: 400,
}
const NOW = msk('2026-10-25', '19:00')

describe('weekly report text', () => {
  it('is short and scannable', () => {
    expect(weeklyText(DATA, NOW)).toBe([
      '📅 Your week in Mnemosyne',
      'Reviews: 214 · last week 180 (+19%)',
      'New words: 23 · known: 312 (+14)',
      'Streak: 5 days',
      'Retention: EN→RU 92% · RU→EN 71%',
      'Vocabulary: ≈ 8,400 words (+350)',
      'Hardest: tenacious ×4 · aloof ×3 · wary ×2',
      '💡 RU→EN retention 71% — try typing answers (deck settings)',
    ].join('\n'))
    const quiet = weeklyText({ ...DATA, reviews: 0, lastWeekReviews: 0, knownChange: 0, streak: 1, retention: { forward: { rate: null, reviews: 0 }, reverse: { rate: null, reviews: 0 } },
      estimate: null, estimateChange: null, hardest: [] }, NOW)
    expect(quiet).toBe('📅 Your week in Mnemosyne\nReviews: 0 · last week 0\nNew words: 23 · known: 312\nStreak: 1 day\n💡 No reviews this week — even five minutes a day keeps words from fading')
  })

  it('suggests one concrete thing', () => {
    expect(suggestion({ ...DATA, inbox: 12 }, NOW)).toBe('12 words waiting in inbox — approve the ones you want to learn')
    expect(suggestion({ ...DATA, typeAnswer: 'reverse' }, NOW)).toBe('RU→EN retention 71% — take fewer new words for a few days')
    const fine = { ...DATA, retention: { forward: { rate: 0.92, reviews: 150 }, reverse: { rate: 0.88, reviews: 60 } } }
    expect(suggestion({ ...fine, reviews: 100, lastWeekReviews: 180 }, NOW)).toMatch(/^Fewer reviews than last week/)
    expect(suggestion({ ...fine, lastTestAt: null }, NOW)).toBe('Take the vocabulary test to update your estimate')
    expect(suggestion(fine, NOW)).toBe('2 words waiting in inbox')
    expect(suggestion({ ...fine, inbox: 0 }, NOW)).toBe('Steady week — keep going')
  })
})

describe('weekly report job', () => {
  it('collects the week from the user’s own reviews and sends it once to started users', async () => {
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001', ALLOW_USER_IDS: '2002,3003' }, '2026-10-18T09:00:00Z')
    const me = ctx.user
    setBotStarted(ctx.db, me.id, ctx.now())
    const silent = ensureUser(ctx.db, ctx.cfg, 2002, ctx.now())
    addWord(ctx, 'q', { userId: silent.id })
    setBotStarted(ctx.db, silent.id, ctx.now())
    updateUserSettings(ctx.db, silent.id, { weeklyReport: false })
    const never = ensureUser(ctx.db, ctx.cfg, 3003, ctx.now())
    addWord(ctx, 'q', { userId: never.id })

    // Last week: one review. This week: tenacious failed twice, aloof once, wary passed.
    const old = addWord(ctx, 'old', { at: new Date('2026-10-10T09:00:00Z') })
    rate(ctx, cardsOf(ctx, old.id)[0]!.id, 3, new Date('2026-10-17T09:00:00Z'))
    const t = addWord(ctx, 'tenacious', { at: new Date('2026-10-20T09:00:00Z') })
    const a = addWord(ctx, 'aloof', { at: new Date('2026-10-20T09:00:00Z') })
    const w = addWord(ctx, 'wary', { at: new Date('2026-10-20T09:00:00Z') })
    rate(ctx, cardsOf(ctx, t.id)[0]!.id, 1, new Date('2026-10-21T09:00:00Z'))
    rate(ctx, cardsOf(ctx, t.id)[0]!.id, 1, new Date('2026-10-21T09:05:00Z'))
    rate(ctx, cardsOf(ctx, a.id)[0]!.id, 1, new Date('2026-10-22T09:00:00Z'))
    rate(ctx, cardsOf(ctx, w.id)[0]!.id, 3, new Date('2026-10-23T09:00:00Z'))
    addWord(ctx, 'proposal', { status: 'inbox', at: new Date('2026-10-24T09:00:00Z') })

    const sent: [number, string][] = []
    const send = async (chat: number, text: string) => void sent.push([chat, text])
    ctx.clock.t = msk('2026-10-25', '18:59')
    await weeklyTick(ctx, send)
    expect(sent).toEqual([])
    // Last week's slot is consumed silently.
    expect(getUser(ctx.db, me.id)!.weeklySentWeek).toBe('2026-10-18')

    ctx.clock.t = msk('2026-10-25', '19:01')
    const data = weeklyData(ctx, getUser(ctx.db, me.id)!, ctx.now())
    expect(data).toMatchObject({ reviews: 4, lastWeekReviews: 1, newWords: 4, inbox: 1, hardest: [{ term: 'tenacious', again: 2 }, { term: 'aloof', again: 1 }], streak: 0 })
    await weeklyTick(ctx, send)
    await weeklyTick(ctx, send)
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe(1001)
    expect(sent[0]![1]).toContain('Reviews: 4 · last week 1 (+300%)')
    expect(sent[0]![1]).toContain('Hardest: tenacious ×2 · aloof ×1')
    expect(getUser(ctx.db, me.id)).toMatchObject({ weeklySentWeek: '2026-10-25', weeklyLastEstimate: data.estimate })
    expect(getUser(ctx.db, silent.id)!.weeklySentWeek).toBeNull()
  })
})
