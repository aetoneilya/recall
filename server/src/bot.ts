// Telegram bot: Mini App menu button, /due, /stats, /help, per-user daily
// reminders and the weekly report, the "Log in with Telegram" confirmation
// (/start login_<nonce>, then a button), and adding words by message
// (bot-words.ts).
import { Bot, GrammyError, InlineKeyboard } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { installWordHandlers, type TaskQueue, type WordBotOptions } from './bot-words.ts'
import type { Config } from './config.ts'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import type { Db } from './db.ts'
import { lexiconOf } from './lexicon.ts'
import { answerLoginRef, openLoginNonce, START_PREFIX } from './login.ts'
import { defaultDeck, syncFreqRanks } from './repo.ts'
import { buildQueue, reviewedOn, studyDay } from './study.ts'
import { ensureUser, isAllowed, listUsers, setBotStarted, setReminderSent, userDayOptions, type User } from './users.ts'
import { weeklyTick } from './weekly.ts'

export interface DueCounts {
  due: number
  // Per deck under its review filter, decks with something today only.
  decks?: { name: string; due: number }[]
}

export function dueCounts(db: Db, cfg: Config, user: User, now: Date): DueCounts {
  const { decks } = buildQueue(db, user.id, userDayOptions(cfg, user), now, { limit: 1 })
  const per = decks.map((d) => ({ name: d.name, due: d.counts.new + d.counts.learning + d.counts.review }))
  return { due: per.reduce((n, d) => n + d.due, 0), decks: per.filter((d) => d.due > 0) }
}

// "12 cards due"; with several decks due, "English 24 · Programming 5 due".
export function reminderText(c: DueCounts, kind: 'morning' | 'evening' | 'now' = 'morning'): string {
  const cards = c.decks && c.decks.length > 1
    ? `${c.decks.map((d) => `${d.name} ${d.due}`).join(' · ')} due`
    : `${c.due} ${c.due === 1 ? 'card' : 'cards'} due`
  return kind === 'evening' ? `Nothing reviewed yet today — ${cards}` : cards
}

export const LOGIN_TEXT = {
  ask: 'Log in to Mnemosyne on the web?',
  confirmed: '✅ Logged in on the web — you can go back to the app',
  cancelled: 'Cancelled',
  expired: 'This login link has expired. Start again from the app.',
  notYours: 'This login was opened from another account',
}

// Callback data of the login buttons: action + the nonce's opaque ref.
const LOGIN_CALLBACK = /^login:(ok|no):([A-Za-z0-9_-]{43})$/

export const HELP_TEXT = `Send me an English word or phrase and I'll add it to your deck with translations, IPA and an example — ↔ for another meaning, ✏️ to edit, ✖ if you don't want it.

• word — sentence, or a sentence with the *word* marked: the sentence becomes the example.
• Several lines, one word each (up to 20): all of them at once.
• A paragraph or a photo of a page: I pick the words worth learning, you tap the ones you want.

/due — cards due now
/stats — your progress
/help — this message`

export function helloText(user: Pick<User, 'name'>, counts: DueCounts): string {
  const hello = user.name ? `Hi, ${user.name}!` : 'Hi!'
  return `${hello} Send me an English word and I'll add it to your deck — /help for more. Reminders go to this chat. ${reminderText(counts, 'now')}`
}

export interface StatsSummary {
  estimate: number | null
  cefr: string | null
  known: number
  mastered: number
  streak: number
  longest: number
  due: number
}

export function statsSummary(ctx: AppContext, user: User, now: Date): StatsSummary {
  const lex = lexiconOf(ctx)
  syncFreqRanks(ctx.db, lex)
  const d = dashboard(ctx.db, user.id, defaultDeck(ctx.db, user.id, now), lex, userDayOptions(ctx.cfg, user), now)
  const due = dueCounts(ctx.db, ctx.cfg, user, now)
  return {
    estimate: d.vocabulary.current?.adjusted ?? null,
    cefr: d.vocabulary.current?.cefr.level?.id ?? null,
    known: d.counts.known,
    mastered: d.counts.mastered,
    streak: d.activity.streak.current,
    longest: d.activity.streak.longest,
    due: due.due,
  }
}

export function statsText(s: StatsSummary): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const days = (k: number) => `${n(k)} ${k === 1 ? 'day' : 'days'}`
  return [
    s.estimate !== null ? `📊 Vocabulary ≈ ${n(s.estimate)} words${s.cefr ? ` (${s.cefr})` : ''}` : '📊 Your progress',
    `Known words: ${n(s.known)} · mastered ${n(s.mastered)}`,
    `Streak: ${days(s.streak)}${s.longest > s.streak ? ` (best ${days(s.longest)})` : ''}`,
    `Due today: ${n(s.due)}`,
  ].join('\n')
}

export const BOT_COMMANDS = [
  { command: 'due', description: 'Cards due now' },
  { command: 'stats', description: 'Your progress' },
  { command: 'help', description: 'How to add words' },
]

export function strangerText(telegramId: number): string {
  return `This is a private bot. Your Telegram id: ${telegramId} — send it to the owner to get access.`
}

// Minutes since local midnight in the given zone.
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

export interface ReminderState {
  morningSentDay: string | null
  eveningSentDay: string | null
}

export interface ReminderSettings {
  timeZone: string
  dayStartHour: number
  reminderTime: string
  eveningReminderTime: string | null
}

export type ReminderDecision =
  | { kind: 'morning' | 'evening'; day: string; send: boolean }
  | null

export function reminderSettings(cfg: Pick<Config, 'dayStartHour'>, user: User): ReminderSettings {
  return { timeZone: user.timeZone, dayStartHour: cfg.dayStartHour, reminderTime: user.reminderTime, eveningReminderTime: user.eveningReminderTime }
}

// Which reminder slot is due now. `send: false` means the slot is consumed
// without a message (nothing due, or something was already reviewed), so it
// isn't re-checked every minute. The stored day survives restarts.
// Clock times are compared within the study day: minutes since its start, so
// 00:30 with a 4 a.m. day start is late in the day it belongs to (sent-day
// keys are study days), not early in the next one.
export function dayMinutes(hhmmMinutes: number, dayStartHour: number): number {
  return (hhmmMinutes - dayStartHour * 60 + 1440) % 1440
}

// A slot is open from its time on; a late start catches it up, but not past
// local midnight (no messages at night for a slot of the evening before),
// unless the slot itself is after midnight.
function slotOpen(minutes: number, hhmm: string, dayStartHour: number): boolean {
  const slot = dayMinutes(toMinutes(hhmm), dayStartHour)
  const midnight = dayMinutes(0, dayStartHour)
  return minutes >= slot && (minutes < midnight || slot >= midnight)
}

export function decideReminder(now: Date, cfg: ReminderSettings, state: ReminderState, info: { due: number; reviewedToday: boolean }): ReminderDecision {
  const day = studyDay(now, { timeZone: cfg.timeZone, startHour: cfg.dayStartHour }).key
  const minutes = dayMinutes(localMinutes(now, cfg.timeZone), cfg.dayStartHour)
  if (cfg.eveningReminderTime && slotOpen(minutes, cfg.eveningReminderTime, cfg.dayStartHour) && state.eveningSentDay !== day) {
    // A late start shouldn't fire the morning message right before the evening one.
    return { kind: 'evening', day, send: info.due > 0 && !info.reviewedToday }
  }
  if (slotOpen(minutes, cfg.reminderTime, cfg.dayStartHour) && state.morningSentDay !== day) {
    return { kind: 'morning', day, send: info.due > 0 }
  }
  return null
}

function reviewedToday(db: Db, cfg: Config, user: User, now: Date): boolean {
  return reviewedOn(db, user.id, studyDay(now, userDayOptions(cfg, user)))
}

export type SendReminder = (chatId: number, text: string) => Promise<unknown>

// One pass over everyone who has /start-ed the bot. Each user's chat is
// their Telegram id; times and the study day are in the user's zone.
export async function reminderTick(ctx: AppContext, send: SendReminder) {
  const { db, cfg } = ctx
  for (const user of listUsers(db)) {
    if (!user.botStartedAt || !isAllowed(cfg, user.telegramId)) continue
    try {
      const now = ctx.now()
      const counts = dueCounts(db, cfg, user, now)
      const decision = decideReminder(now, reminderSettings(cfg, user), user, { due: counts.due, reviewedToday: reviewedToday(db, cfg, user, now) })
      if (!decision) continue
      // Record first: a failed send is better than a duplicate on every tick.
      setReminderSent(db, user.id, decision.kind, decision.day)
      if (decision.kind === 'evening') setReminderSent(db, user.id, 'morning', decision.day)
      if (decision.send) await send(user.telegramId, reminderText(counts, decision.kind))
    } catch (e) {
      // Blocked the bot: stop trying until the next /start.
      if (e instanceof GrammyError && e.error_code === 403) setBotStarted(db, user.id, null)
      else console.error(`reminder for user ${user.id}:`, e)
    }
  }
}

// The bot's handlers. `botInfo` skips getMe (tests); `opts` injects the
// word queue and the file download (tests).
export function createBot(ctx: AppContext, botInfo?: UserFromGetMe, opts: WordBotOptions = {}): Bot & { words: TaskQueue } {
  const { db, cfg } = ctx
  const bot = new Bot(cfg.botToken ?? '0:none', botInfo ? { botInfo } : {})
  const keyboard = () => new InlineKeyboard().webApp('Open Mnemosyne', cfg.appOrigin)

  bot.use(async (c, next) => {
    if (c.from && isAllowed(cfg, c.from.id)) return next()
    if (c.from && c.chat) await c.reply(strangerText(c.from.id))
  })

  bot.command('start', async (c) => {
    const user = ensureUser(db, cfg, c.from!.id, ctx.now(), c.from!.first_name)
    if (c.chat.type === 'private') setBotStarted(db, user.id, ctx.now())
    const payload = typeof c.match === 'string' ? c.match.trim() : ''
    if (payload.startsWith(START_PREFIX)) {
      // Opening the link only asks; the login happens on a press, so a link
      // someone else sent doesn't sign them in silently.
      const r = openLoginNonce(db, payload.slice(START_PREFIX.length), user.id, ctx.now())
      if ('ref' in r) {
        const buttons = new InlineKeyboard().text('✅ Log in', `login:ok:${r.ref}`).text('✖ Cancel', `login:no:${r.ref}`)
        await c.reply(LOGIN_TEXT.ask, { reply_markup: buttons })
      } else await c.reply(LOGIN_TEXT.expired)
    }
    try {
      await c.api.setChatMenuButton({ chat_id: c.chat.id, menu_button: { type: 'web_app', text: 'Review', web_app: { url: cfg.appOrigin } } })
    } catch (e) {
      console.error('telegram: setChatMenuButton:', e)
    }
    if (payload.startsWith(START_PREFIX)) return
    await c.reply(helloText(user, dueCounts(db, cfg, user, ctx.now())), { reply_markup: keyboard() })
  })

  bot.command('help', async (c) => {
    await c.reply(HELP_TEXT)
  })

  bot.command('stats', async (c) => {
    const user = ensureUser(db, cfg, c.from!.id, ctx.now(), c.from!.first_name)
    await c.reply(statsText(statsSummary(ctx, user, ctx.now())), { reply_markup: new InlineKeyboard().webApp('Open dashboard', `${cfg.appOrigin}/#/dashboard`) })
  })

  bot.callbackQuery(LOGIN_CALLBACK, async (c) => {
    const user = ensureUser(db, cfg, c.from.id, ctx.now(), c.from.first_name)
    const [, action, ref] = c.match as RegExpMatchArray
    const r = answerLoginRef(db, ref!, user.id, action === 'ok' ? 'confirm' : 'cancel', ctx.now())
    if (r === 'taken') {
      await c.answerCallbackQuery({ text: LOGIN_TEXT.notYours })
      return
    }
    await c.answerCallbackQuery()
    // Editing without reply_markup also removes the buttons.
    await c.editMessageText(LOGIN_TEXT[r])
  })

  bot.command('due', async (c) => {
    const user = ensureUser(db, cfg, c.from!.id, ctx.now(), c.from!.first_name)
    await c.reply(reminderText(dueCounts(db, cfg, user, ctx.now()), 'now'), { reply_markup: keyboard() })
  })

  const words = installWordHandlers(bot, ctx, opts)
  bot.catch((err) => console.error('telegram:', err.error))
  return Object.assign(bot, { words })
}

export function startBot(ctx: AppContext): { stop: () => Promise<void> } | null {
  const { cfg } = ctx
  if (!cfg.botToken) return null
  const bot = createBot(ctx)
  const keyboard = new InlineKeyboard().webApp('Open Mnemosyne', cfg.appOrigin)
  const send: SendReminder = (chatId, text) => bot.api.sendMessage(chatId, text, { reply_markup: keyboard })
  const weekly = new InlineKeyboard().webApp('Open dashboard', `${cfg.appOrigin}/#/dashboard`)
  const sendWeekly: SendReminder = (chatId, text) => bot.api.sendMessage(chatId, text, { reply_markup: weekly })
  const timer = setInterval(async () => {
    await reminderTick(ctx, send).catch((e) => console.error('reminder:', e))
    await weeklyTick(ctx, sendWeekly).catch((e) => console.error('weekly report:', e))
  }, 60_000)

  let stopped = false
  let retry: NodeJS.Timeout | undefined
  // getMe first: the bot username builds the t.me login links.
  const launch = () => {
    bot.init().then(
      () => {
        ctx.telegram.botUsername = bot.botInfo.username
        bot.api.setMyCommands(BOT_COMMANDS).catch((e) => console.error('telegram: setMyCommands:', e))
        return bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`telegram bot @${me.username} polling`) })
      },
      (e) => {
        if (stopped) return
        console.error('telegram getMe failed, retrying in 60 s:', e)
        retry = setTimeout(launch, 60_000)
      },
    ).catch((e) => console.error('telegram bot stopped:', e))
  }
  launch()
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(retry)
      if (bot.isRunning()) await bot.stop()
    },
  }
}
