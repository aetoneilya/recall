// Users are Telegram accounts. Who may get in is configuration
// (OWNER_TELEGRAM_ID + ALLOW_USER_IDS); a row is created on first sign-in.
import type { DayOptions } from '@recall/core'
import type { Config } from './config.ts'
import { newId, type Db, type MigrationEnv } from './db.ts'

export interface User {
  id: string
  telegramId: number
  name: string
  timeZone: string
  reminderTime: string
  eveningReminderTime: string | null
  // Set by /start: the bot may message the user (chat id = telegram id).
  botStartedAt: string | null
  morningSentDay: string | null
  eveningSentDay: string | null
  // Weekly report: on/off, local weekday (0 = Sunday) and time, the last
  // slot handled (its local date) and the vocabulary estimate it showed.
  weeklyReport: boolean
  weeklyReportDay: number
  weeklyReportTime: string
  weeklySentWeek: string | null
  weeklyLastEstimate: number | null
  // FSRS: target retention and weights trained on the user's own history (null = defaults).
  requestRetention: number
  fsrsWeights: number[] | null
  fsrsTrainedAt: string | null
  fsrsReviewsUsed: number | null
  fsrsAttemptedAt: string | null
  createdAt: string
}

export interface UserDefaults {
  timeZone: string
  reminderTime: string
  eveningReminderTime: string | null
}

interface UserRow {
  id: string
  telegram_id: number
  name: string
  time_zone: string
  reminder_time: string
  evening_reminder_time: string | null
  bot_started_at: string | null
  morning_sent_day: string | null
  evening_sent_day: string | null
  weekly_report: number
  weekly_report_day: number
  weekly_report_time: string
  weekly_sent_week: string | null
  weekly_last_estimate: number | null
  request_retention: number
  fsrs_weights: string | null
  fsrs_trained_at: string | null
  fsrs_reviews_used: number | null
  fsrs_attempted_at: string | null
  created_at: string
}

// DEV mode without OWNER_TELEGRAM_ID runs as this pseudo Telegram id.
export const DEV_TELEGRAM_ID = 0

function toUser(r: UserRow): User {
  return {
    id: r.id,
    telegramId: Number(r.telegram_id),
    name: r.name,
    timeZone: r.time_zone,
    reminderTime: r.reminder_time,
    eveningReminderTime: r.evening_reminder_time,
    botStartedAt: r.bot_started_at,
    morningSentDay: r.morning_sent_day,
    eveningSentDay: r.evening_sent_day,
    weeklyReport: r.weekly_report === 1,
    weeklyReportDay: r.weekly_report_day,
    weeklyReportTime: r.weekly_report_time,
    weeklySentWeek: r.weekly_sent_week,
    weeklyLastEstimate: r.weekly_last_estimate,
    requestRetention: r.request_retention,
    fsrsWeights: r.fsrs_weights ? (JSON.parse(r.fsrs_weights) as number[]) : null,
    fsrsTrainedAt: r.fsrs_trained_at,
    fsrsReviewsUsed: r.fsrs_reviews_used,
    fsrsAttemptedAt: r.fsrs_attempted_at,
    createdAt: r.created_at,
  }
}

export function getUser(db: Db, id: string): User | null {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return r ? toUser(r) : null
}

export function getUserByTelegramId(db: Db, telegramId: number): User | null {
  const r = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as UserRow | undefined
  return r ? toUser(r) : null
}

export function listUsers(db: Db): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as unknown as UserRow[]).map(toUser)
}

// Get or create. A non-empty `name` (Telegram first name) refreshes the stored one.
export function ensureUser(db: Db, defaults: UserDefaults, telegramId: number, now: Date, name?: string): User {
  const existing = getUserByTelegramId(db, telegramId)
  const clean = name?.trim().slice(0, 100)
  if (existing) {
    if (clean && clean !== existing.name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(clean, existing.id)
      existing.name = clean
    }
    return existing
  }
  const id = newId('us')
  db.prepare(
    'INSERT INTO users(id, telegram_id, name, time_zone, reminder_time, evening_reminder_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, telegramId, clean ?? '', defaults.timeZone, defaults.reminderTime, defaults.eveningReminderTime, now.toISOString())
  return getUser(db, id)!
}

// The Telegram id the owner's data belongs to: OWNER_TELEGRAM_ID, or the dev pseudo id.
export function ownerTelegramId(cfg: Pick<Config, 'dev' | 'ownerTelegramId'>): number | null {
  return cfg.ownerTelegramId ?? (cfg.dev ? DEV_TELEGRAM_ID : null)
}

export function migrationEnv(cfg: Config): MigrationEnv {
  return { ownerTelegramId: ownerTelegramId(cfg), defaults: cfg }
}

export function isOwner(cfg: Pick<Config, 'dev' | 'ownerTelegramId'>, user: Pick<User, 'telegramId'>): boolean {
  return user.telegramId === ownerTelegramId(cfg)
}

export function isAllowed(cfg: Pick<Config, 'dev' | 'ownerTelegramId' | 'allowUserIds'>, telegramId: number): boolean {
  return cfg.dev || telegramId === cfg.ownerTelegramId || cfg.allowUserIds.includes(telegramId)
}

// The owner user, created if missing; null when no owner is configured.
export function ownerUser(db: Db, cfg: Config, now: Date): User | null {
  const tg = ownerTelegramId(cfg)
  return tg === null ? null : ensureUser(db, cfg, tg, now)
}

// A user id that still maps to an allowed account, or null.
export function allowedUser(db: Db, cfg: Config, id: unknown): User | null {
  if (typeof id !== 'string') return null
  const user = getUser(db, id)
  return user && isAllowed(cfg, user.telegramId) ? user : null
}

export function userDayOptions(cfg: Pick<Config, 'dayStartHour'>, user: Pick<User, 'timeZone'>): DayOptions {
  return { timeZone: user.timeZone, startHour: cfg.dayStartHour }
}

export interface UserSettingsPatch {
  timeZone?: string
  reminderTime?: string
  eveningReminderTime?: string | null
  weeklyReport?: boolean
  weeklyReportDay?: number
  weeklyReportTime?: string
  requestRetention?: number
}

export function updateUserSettings(db: Db, id: string, patch: UserSettingsPatch): User {
  const columns = {
    timeZone: 'time_zone', reminderTime: 'reminder_time', eveningReminderTime: 'evening_reminder_time',
    weeklyReport: 'weekly_report', weeklyReportDay: 'weekly_report_day', weeklyReportTime: 'weekly_report_time', requestRetention: 'request_retention',
  } as const
  const set = (Object.keys(columns) as (keyof typeof columns)[]).filter((k) => patch[k] !== undefined)
  const value = (v: UserSettingsPatch[keyof UserSettingsPatch]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null)
  if (set.length) {
    db.prepare(`UPDATE users SET ${set.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`).run(...set.map((k) => value(patch[k])), id)
  }
  return getUser(db, id)!
}

export function setBotStarted(db: Db, id: string, at: Date | null) {
  db.prepare('UPDATE users SET bot_started_at = ? WHERE id = ?').run(at?.toISOString() ?? null, id)
}

export function setWeeklySent(db: Db, id: string, week: string, estimate: number | null) {
  db.prepare('UPDATE users SET weekly_sent_week = ?, weekly_last_estimate = coalesce(?, weekly_last_estimate) WHERE id = ?').run(week, estimate, id)
}

export function setReminderSent(db: Db, id: string, kind: 'morning' | 'evening', day: string) {
  db.prepare(`UPDATE users SET ${kind === 'morning' ? 'morning_sent_day' : 'evening_sent_day'} = ? WHERE id = ?`).run(day, id)
}
