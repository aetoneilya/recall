// Weekly report: per user, at their weekly_report_day / weekly_report_time
// (Sunday 19:00 by default) in their time zone, to users who /start-ed the
// bot. The slot handled last is stored as its local date (weekly_sent_week),
// so restarts don't double-send and a late start still catches up — within
// 48 h; an older missed slot is consumed silently, as is one from before the
// user started the bot.
import { type Direction } from '@recall/core'
import { GrammyError } from 'grammy'
import type { AppContext } from './context.ts'
import { dashboard } from './dashboard.ts'
import { lexiconOf } from './lexicon.ts'
import { defaultDeck, syncFreqRanks, type DeckInfo, type TypeAnswer } from './repo.ts'
import { isAllowed, listUsers, setBotStarted, setWeeklySent, userDayOptions, type User } from './users.ts'

export const CATCH_UP_MINUTES = 48 * 60
const WEEK_MS = 7 * 86400_000

export interface WeeklySettings {
  timeZone: string
  weeklyReport: boolean
  // 0 = Sunday … 6 = Saturday, local.
  weeklyReportDay: number
  weeklyReportTime: string
}

export interface WeeklyState {
  weeklySentWeek: string | null
  botStartedAt: string | null
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Local calendar date, weekday and minutes since midnight in `timeZone`.
export function localClock(now: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: WEEKDAYS.indexOf(get('weekday')), minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

const minusDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 86400_000).toISOString().slice(0, 10)

// The weekly slot due now: `week` is the slot's local date; `send: false`
// consumes it without a message. null: nothing to do (off, or already handled).
export function decideWeekly(now: Date, s: WeeklySettings, state: WeeklyState): { week: string; send: boolean } | null {
  if (!s.weeklyReport) return null
  const { date, weekday, minutes } = localClock(now, s.timeZone)
  const at = minutesOf(s.weeklyReportTime)
  let back = (weekday - s.weeklyReportDay + 7) % 7
  if (back === 0 && minutes < at) back = 7
  const week = minusDays(date, back)
  if (state.weeklySentWeek === week) return null
  const age = back * 1440 + minutes - at
  const startedBefore = !!state.botStartedAt && (now.getTime() - Date.parse(state.botStartedAt)) / 60_000 >= age
  return { week, send: age < CATCH_UP_MINUTES && startedBefore }
}

// ---------- content ----------

export interface WeeklyData {
  reviews: number
  lastWeekReviews: number
  newWords: number
  known: number
  // Known now minus known a week ago (reconstructed from the logs).
  knownChange: number | null
  streak: number
  retention: Record<Direction, { rate: number | null; reviews: number }>
  // "EN→RU", "RU→EN".
  labels: Record<Direction, string>
  // In-list lemmas, test and app combined; the change since the last report.
  estimate: number | null
  estimateChange: number | null
  hardest: { term: string; again: number }[]
  typeAnswer: TypeAnswer
  // Latest valid vocabulary test.
  lastTestAt: string | null
  totalWords: number
}

export function weeklyData(ctx: AppContext, user: User, now: Date, deck: DeckInfo = defaultDeck(ctx.db, user.id, now)): WeeklyData {
  const { db } = ctx
  const lex = lexiconOf(ctx)
  syncFreqRanks(db, lex)
  const dash = dashboard(db, user.id, deck, lex, userDayOptions(ctx.cfg, user), now)
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString()
  const twoAgo = new Date(now.getTime() - 2 * WEEK_MS).toISOString()
  const scope = 'FROM review_logs l JOIN cards c ON c.id = l.card_id JOIN words w ON w.id = c.word_id WHERE w.user_id = ? AND w.deck_id = ?'
  const count = (from: string, to: string) =>
    (db.prepare(`SELECT count(*) AS n ${scope} AND l.reviewed_at >= ? AND l.reviewed_at < ?`).get(user.id, deck.id, from, to) as { n: number }).n
  const nowIso = now.toISOString()
  const retention: WeeklyData['retention'] = { forward: { rate: null, reviews: 0 }, reverse: { rate: null, reviews: 0 } }
  const rows = db.prepare(`SELECT c.direction, count(*) AS n, sum(l.rating > 1) AS ok ${scope} AND l.reviewed_at >= ? AND l.reviewed_at < ?
    AND json_extract(l."before", '$.state') = 2 GROUP BY c.direction`).all(user.id, deck.id, weekAgo, nowIso) as { direction: Direction; n: number; ok: number }[]
  for (const r of rows) retention[r.direction] = { rate: r.n ? r.ok / r.n : null, reviews: r.n }
  const hardest = db.prepare(`SELECT w.term, count(*) AS again ${scope} AND l.reviewed_at >= ? AND l.reviewed_at < ? AND l.rating = 1
    GROUP BY w.id ORDER BY again DESC, w.term COLLATE NOCASE LIMIT 3`).all(user.id, deck.id, weekAgo, nowIso) as { term: string; again: number }[]
  const newWords = (db.prepare("SELECT count(*) AS n FROM words WHERE user_id = ? AND deck_id = ? AND status != 'rejected' AND created_at >= ? AND created_at < ?")
    .get(user.id, deck.id, weekAgo, nowIso) as { n: number }).n
  const g = dash.growth
  const estimate = dash.vocabulary.current?.adjusted ?? null
  const code = (l: string | null) => (l ?? '').toUpperCase()
  return {
    reviews: count(weekAgo, nowIso),
    lastWeekReviews: count(twoAgo, weekAgo),
    newWords,
    known: dash.counts.known,
    knownChange: g.length >= 2 ? g.at(-1)!.known - g.at(-2)!.known : null,
    streak: dash.activity.streak.current,
    retention,
    labels: { forward: `${code(deck.targetLang)}→${code(deck.nativeLang)}`, reverse: `${code(deck.nativeLang)}→${code(deck.targetLang)}` },
    estimate,
    estimateChange: estimate !== null && user.weeklyLastEstimate !== null ? estimate - user.weeklyLastEstimate : null,
    hardest: hardest.map((h) => ({ term: h.term, again: h.again })),
    typeAnswer: deck.typeAnswer,
    lastTestAt: dash.vocabulary.latestTest?.completedAt ?? null,
    totalWords: dash.counts.words.total,
  }
}

const n = (x: number) => x.toLocaleString('en-US')
const pct = (x: number) => `${Math.round(x * 100)}%`
const signed = (x: number) => (x > 0 ? `+${n(x)}` : x < 0 ? `−${n(-x)}` : '±0')
const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`

// One concrete thing to do next, most pressing first.
export function suggestion(d: WeeklyData, now: Date): string {
  const weak = (['reverse', 'forward'] as const).find((dir) => d.retention[dir].reviews >= 20 && (d.retention[dir].rate ?? 1) < 0.8)
  if (weak) {
    const r = d.retention[weak]
    const typing = d.typeAnswer === 'both' || (d.typeAnswer === 'reverse' && weak === 'reverse')
    return `${d.labels[weak]} retention ${pct(r.rate!)} — ${typing ? 'take fewer new words for a few days' : 'try typing answers (deck settings)'}`
  }
  if (!d.reviews) return 'No reviews this week — even five minutes a day keeps words from fading'
  if (d.lastWeekReviews && d.reviews < d.lastWeekReviews * 0.7) return 'Fewer reviews than last week — a short session every day beats a long one on Sunday'
  if (!d.lastTestAt || now.getTime() - Date.parse(d.lastTestAt) > 60 * 86400_000) return 'Take the vocabulary test to update your estimate'
  if (d.newWords < 5) return 'Send me words you meet while reading — or a photo of the page'
  return 'Steady week — keep going'
}

export function weeklyText(d: WeeklyData, now: Date): string {
  const lines = ['📅 Your week in Mnemosyne']
  const change = d.lastWeekReviews ? ` (${signed(Math.round(((d.reviews - d.lastWeekReviews) / d.lastWeekReviews) * 100))}%)` : ''
  lines.push(`Reviews: ${n(d.reviews)} · last week ${n(d.lastWeekReviews)}${change}`)
  lines.push(`New words: ${n(d.newWords)} · known: ${n(d.known)}${d.knownChange ? ` (${signed(d.knownChange)})` : ''}`)
  lines.push(`Streak: ${plural(d.streak, 'day')}`)
  const ret = (['forward', 'reverse'] as const).filter((dir) => d.retention[dir].rate !== null)
  if (ret.length) lines.push(`Retention: ${ret.map((dir) => `${d.labels[dir]} ${pct(d.retention[dir].rate!)}`).join(' · ')}`)
  if (d.estimate !== null) lines.push(`Vocabulary: ≈ ${n(d.estimate)} words${d.estimateChange ? ` (${signed(d.estimateChange)})` : ''}`)
  if (d.hardest.length) lines.push(`Hardest: ${d.hardest.map((h) => `${h.term} ×${h.again}`).join(' · ')}`)
  lines.push(`💡 ${suggestion(d, now)}`)
  return lines.join('\n')
}

export type SendWeekly = (chatId: number, text: string) => Promise<unknown>

// One pass over everyone who has /start-ed the bot.
export async function weeklyTick(ctx: AppContext, send: SendWeekly) {
  const { db, cfg } = ctx
  for (const user of listUsers(db)) {
    if (!user.botStartedAt || !isAllowed(cfg, user.telegramId)) continue
    try {
      const now = ctx.now()
      const decision = decideWeekly(now, user, user)
      if (!decision) continue
      if (!decision.send) {
        setWeeklySent(db, user.id, decision.week, null)
        continue
      }
      const data = weeklyData(ctx, user, now)
      // Record first: a failed send is better than a duplicate on every tick.
      setWeeklySent(db, user.id, decision.week, data.estimate)
      if (data.totalWords) await send(user.telegramId, weeklyText(data, now))
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 403) setBotStarted(db, user.id, null)
      else console.error(`weekly report for user ${user.id}:`, e)
    }
  }
}
