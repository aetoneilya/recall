import { GrammyError } from 'grammy'
import { describe, expect, it } from 'vitest'
import { decideReminder, dueCounts, localMinutes, reminderText, reminderTick } from '../src/bot.ts'
import { ensureUser, getUser, setBotStarted, updateUserSettings } from '../src/users.ts'
import { addWord, deck, makeCtx } from './helpers.ts'

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

  it('counts due cards from the queue', () => {
    const ctx = makeCtx()
    deck(ctx, 2)
    for (const f of ['a', 'b', 'c']) addWord(ctx, f)
    // Dropped words are never due.
    addWord(ctx, 'dropped', { status: 'rejected' })
    expect(dueCounts(ctx.db, ctx.cfg, ctx.user, ctx.now())).toEqual({ due: 2, decks: [{ name: 'English', due: 2 }] })
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
