import { BATCH } from '@recall/core'
import { GrammyError } from 'grammy'
import { describe, expect, it } from 'vitest'
import { decideReminder, dueCounts, localMinutes, reminderText, reminderTick } from '../src/bot.ts'
import { ensureUser, getUser, setBotStarted, updateUserSettings } from '../src/users.ts'
import { addWord, cardsOf, deck, makeCtx, otherDeck, rate } from './helpers.ts'

const cfg = { timeZone: 'Europe/Moscow', dayStartHour: 4, reminderTime: '09:00', eveningReminderTime: '20:30' }
const none = { morningSentDay: null, eveningSentDay: null }
const msk = (hhmm: string, day = '2026-10-21') => new Date(`${day}T${hhmm}:00+03:00`)

describe('reminders', () => {
  it('formats the message', () => {
    expect(reminderText({ due: 12 })).toBe('12 cards due')
    expect(reminderText({ due: 1 })).toBe('1 card due')
    expect(reminderText({ due: 5 }, 'evening')).toBe('Nothing reviewed yet today — 5 cards due')
  })

  it('reads local time in the configured zone', () => {
    expect(localMinutes(new Date('2026-10-21T06:05:00Z'), 'Europe/Moscow')).toBe(9 * 60 + 5)
  })

  it('sends the morning reminder once per study day, after REMINDER_TIME', () => {
    const info = { due: 4, reviewedToday: false }
    expect(decideReminder(msk('08:59'), cfg, none, info)).toBeNull()
    expect(decideReminder(msk('09:00'), cfg, none, info)).toEqual({ kind: 'morning', day: '2026-10-21', send: true })
    // Restart at noon: still sends (catch-up), but not again once recorded.
    expect(decideReminder(msk('12:00'), cfg, none, info)?.kind).toBe('morning')
    expect(decideReminder(msk('12:00'), cfg, { ...none, morningSentDay: '2026-10-21' }, info)).toBeNull()
    // Nothing due: the slot is consumed silently.
    expect(decideReminder(msk('09:00'), cfg, none, { due: 0, reviewedToday: false })).toMatchObject({ kind: 'morning', send: false })
    // 02:00 belongs to the previous study day, already handled.
    expect(decideReminder(msk('02:00', '2026-10-22'), cfg, { morningSentDay: '2026-10-21', eveningSentDay: '2026-10-21' }, info)).toBeNull()
  })

  it('nudges in the evening only if nothing was reviewed today', () => {
    const sent = { morningSentDay: '2026-10-21', eveningSentDay: null }
    expect(decideReminder(msk('20:29'), cfg, sent, { due: 4, reviewedToday: false })).toBeNull()
    expect(decideReminder(msk('20:30'), cfg, sent, { due: 4, reviewedToday: false })).toEqual({ kind: 'evening', day: '2026-10-21', send: true })
    expect(decideReminder(msk('20:30'), cfg, sent, { due: 4, reviewedToday: true })).toMatchObject({ send: false })
    expect(decideReminder(msk('21:00'), cfg, { ...sent, eveningSentDay: '2026-10-21' }, { due: 4, reviewedToday: false })).toBeNull()
    expect(decideReminder(msk('20:30'), { ...cfg, eveningReminderTime: null }, sent, { due: 4, reviewedToday: false })).toBeNull()
  })

  it('keeps an evening reminder after midnight in its own study day', () => {
    const late = { ...cfg, eveningReminderTime: '00:30' }
    const info = { due: 4, reviewedToday: false }
    // 04:00 starts the new day: nothing yet, and the morning isn't swallowed.
    expect(decideReminder(msk('04:00', '2026-10-22'), late, { morningSentDay: '2026-10-21', eveningSentDay: '2026-10-21' }, info)).toBeNull()
    expect(decideReminder(msk('09:00', '2026-10-22'), late, { morningSentDay: '2026-10-21', eveningSentDay: '2026-10-21' }, info))
      .toEqual({ kind: 'morning', day: '2026-10-22', send: true })
    // 23:59 is still before the nudge; 00:30 the next calendar day is the nudge of the 22nd.
    const morningDone = { morningSentDay: '2026-10-22', eveningSentDay: '2026-10-21' }
    expect(decideReminder(msk('23:59', '2026-10-22'), late, morningDone, info)).toBeNull()
    expect(decideReminder(msk('00:30', '2026-10-23'), late, morningDone, info)).toEqual({ kind: 'evening', day: '2026-10-22', send: true })
    expect(decideReminder(msk('03:59', '2026-10-23'), late, { morningSentDay: '2026-10-22', eveningSentDay: '2026-10-22' }, info)).toBeNull()
    // A missed 20:30 nudge isn't caught up after midnight.
    expect(decideReminder(msk('01:00', '2026-10-22'), cfg, { morningSentDay: '2026-10-21', eveningSentDay: '2026-10-20' }, info)).toBeNull()
  })

  it('sends a reminder set before the day start at that time, at the end of its study day', () => {
    const early = { ...cfg, reminderTime: '02:00', eveningReminderTime: null }
    const info = { due: 4, reviewedToday: false }
    expect(decideReminder(msk('04:00', '2026-10-22'), early, { morningSentDay: '2026-10-21', eveningSentDay: null }, info)).toBeNull()
    expect(decideReminder(msk('12:00', '2026-10-22'), early, { morningSentDay: '2026-10-21', eveningSentDay: null }, info)).toBeNull()
    expect(decideReminder(msk('02:00', '2026-10-23'), early, { morningSentDay: '2026-10-21', eveningSentDay: null }, info)).toEqual({ kind: 'morning', day: '2026-10-22', send: true })
  })

  it('counts due cards from the queue', () => {
    const ctx = makeCtx()
    deck(ctx, 2)
    for (const f of ['a', 'b', 'c']) addWord(ctx, f)
    // Dropped words are never due.
    addWord(ctx, 'dropped', { status: 'rejected' })
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 2, decks: [{ name: 'English', due: 2 }] })
  })
})

describe('a few learning cards left after a session', () => {
  // n words studied today, each forward card rated Again: n learning cards, nothing else.
  function studied(ctx: ReturnType<typeof makeCtx>, n: number, deckId?: string) {
    for (let i = 0; i < n; i++) rate(ctx, cardsOf(ctx, addWord(ctx, `w${deckId ?? ''}${i}`, deckId ? { deckId } : {}).id)[0]!.id, 1, ctx.now())
  }

  it("don't count once the deck was reviewed today: the app holds them for tomorrow", () => {
    const ctx = makeCtx()
    deck(ctx, 3)
    studied(ctx, 3)
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 0, decks: [] })
    // Tomorrow, nothing reviewed yet: the day's first session shows them.
    ctx.clock.t = new Date('2026-10-22T09:00:00Z')
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 3, decks: [{ name: 'English', due: 3 }] })
  })

  it('count when they make a round, or when anything else is due', () => {
    const ctx = makeCtx()
    deck(ctx, BATCH)
    studied(ctx, BATCH)
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now()).due).toBe(BATCH)
    const more = makeCtx()
    deck(more, 4)
    studied(more, 3)
    addWord(more, 'fresh')
    expect(dueCounts(more.db, more.cfg, more.user, more.now()).due).toBe(4)
  })

  it('are per deck: a deck not reviewed today still counts its few learning cards', () => {
    const ctx = makeCtx()
    deck(ctx, 2)
    studied(ctx, 2)
    const de = otherDeck(ctx)
    const w = addWord(ctx, 'Haus', { deckId: de.id })
    ctx.db.prepare("UPDATE cards SET state = 1, due = '2026-10-20T12:00:00.000Z', last_review = '2026-10-20T11:50:00.000Z' WHERE id = ?").run(cardsOf(ctx, w.id)[0]!.id)
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 1, decks: [{ name: de.name, due: 1 }] })
  })

  it("don't make the morning reminder nag after an early session; the next day's does", async () => {
    // 06:00 Moscow: a session before the 09:00 reminder leaves three learning cards.
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001' }, '2026-10-21T03:00:00Z')
    setBotStarted(ctx.db, ctx.user.id, ctx.now())
    updateUserSettings(ctx.db, ctx.user.id, { eveningReminderTime: '20:30' })
    deck(ctx, 3)
    studied(ctx, 3)
    const sent: string[] = []
    const send = async (_: number, text: string) => void sent.push(text)
    ctx.clock.t = new Date('2026-10-21T06:05:00Z')
    await reminderTick(ctx, send)
    expect(sent).toEqual([])
    expect(getUser(ctx.db, ctx.user.id)!.morningSentDay).toBe('2026-10-21')
    // 20:35: the evening nudge is only for a day with nothing reviewed.
    ctx.clock.t = new Date('2026-10-21T17:35:00Z')
    await reminderTick(ctx, send)
    expect(sent).toEqual([])
    ctx.clock.t = new Date('2026-10-22T06:05:00Z')
    await reminderTick(ctx, send)
    expect(sent).toEqual(['3 cards due'])
  })
})

describe('per-user reminders', () => {
  it('sends each started, allowed user their own counts in their own zone, once per study day', async () => {
    const ctx = makeCtx({ OWNER_TELEGRAM_ID: '1001', ALLOW_USER_IDS: '2002,3003' }, '2026-10-21T00:30:00Z')
    const moscow = ctx.user
    const tokyo = updateUserSettings(ctx.db, ensureUser(ctx.db, ctx.cfg, 2002, ctx.now()).id, { timeZone: 'Asia/Tokyo', reminderTime: '09:00' })
    const silent = ensureUser(ctx.db, ctx.cfg, 3003, ctx.now())
    const removed = ensureUser(ctx.db, ctx.cfg, 4004, ctx.now())
    // One new card per word per day (siblings are buried), so n words = n due.
    for (const [u, n] of [[moscow, 1], [tokyo, 2], [silent, 3], [removed, 4]] as const) {
      for (let i = 0; i < n; i++) addWord(ctx, `q${i}`, { userId: u.id })
    }
    for (const u of [moscow, tokyo, removed]) setBotStarted(ctx.db, u.id, ctx.now())

    const sent: [number, string][] = []
    const send = async (chat: number, text: string) => void sent.push([chat, text])

    // 03:30 in Moscow, 09:30 in Tokyo.
    await reminderTick(ctx, send)
    expect(sent).toEqual([[2002, '2 cards due']])
    expect(getUser(ctx.db, tokyo.id)!.morningSentDay).toBe('2026-10-21')

    // 09:05 in Moscow, 15:05 in Tokyo: only Moscow is new.
    ctx.clock.t = new Date('2026-10-21T06:05:00Z')
    await reminderTick(ctx, send)
    await reminderTick(ctx, send)
    expect(sent).toEqual([[2002, '2 cards due'], [1001, '1 card due']])

    // A user who blocked the bot is not retried until the next /start.
    ctx.clock.t = new Date('2026-10-22T06:05:00Z')
    const blocked = async (chat: number) => {
      if (chat === 2002) throw new GrammyError('blocked', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'sendMessage', {})
      sent.push([chat, 'next day'])
    }
    await reminderTick(ctx, blocked)
    expect(getUser(ctx.db, tokyo.id)!.botStartedAt).toBeNull()
    expect(sent.at(-1)).toEqual([1001, 'next day'])
  })
})
