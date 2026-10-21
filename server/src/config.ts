import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DayOptions } from '@recall/core'

export interface Config {
  dev: boolean
  dbPath: string
  port: number
  appOrigin: string
  ownerPassword: string | null
  mcpToken: string | null
  botToken: string | null
  // The admin: owns the pre-multi-user data, the MCP_TOKEN and OWNER_PASSWORD.
  ownerTelegramId: number | null
  // Other Telegram users let in (ALLOW_USER_IDS); the owner always is.
  allowUserIds: number[]
  // Defaults for new users; each user can change their own.
  timeZone: string
  dayStartHour: number
  reminderTime: string
  eveningReminderTime: string | null
  staticDir: string | null
  // null disables the nightly VACUUM INTO.
  backupDir: string | null
  // en-freq.tsv, vocab-test.json, vocab-scale.json; missing files only turn features off.
  dataDir: string
  // ✨ autofill; off (503) without a key.
  anthropicApiKey: string | null
  claudeModel: string
  // Claude calls per user per study day: ✨ autofill, words added through the bot, word extraction.
  autofillDailyLimit: number
  // FSRS weights are trained on a user's history once they have this many usable reviews.
  fsrsMinReviews: number
}

export const DEFAULT_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

type Env = Record<string, string | undefined>

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function loadConfig(env: Env = process.env, argv: string[] = process.argv): Config {
  const dev = argv.includes('--dev') || env.DEV === '1' || env.DEV === 'true'
  const port = int(env.PORT, 8080, 'PORT')
  const dbPath = env.DB_PATH || './recall.db'
  const reminderTime = env.REMINDER_TIME || '09:00'
  const evening = env.EVENING_REMINDER_TIME || null
  for (const [name, v] of [['REMINDER_TIME', reminderTime], ['EVENING_REMINDER_TIME', evening]] as const) {
    if (v && !TIME.test(v)) throw new Error(`${name} must be HH:MM, got ${v}`)
  }
  const timeZone = env.TZ_NAME || 'Europe/Moscow'
  // Throws RangeError on an unknown zone, which is what we want at startup.
  new Intl.DateTimeFormat('en-CA', { timeZone })
  const dayStartHour = int(env.DAY_START_HOUR, 4, 'DAY_START_HOUR')
  if (dayStartHour < 0 || dayStartHour > 23) throw new Error('DAY_START_HOUR must be 0..23')
  const appOrigin = (env.APP_ORIGIN || (dev ? `http://localhost:${port}` : 'https://cards.example.com')).replace(/\/+$/, '')
  return {
    dev,
    dbPath,
    port,
    appOrigin,
    ownerPassword: env['OWNER_PASSWORD'] || null,
    mcpToken: env.MCP_TOKEN || null,
    botToken: env.BOT_TOKEN || null,
    ownerTelegramId: env.OWNER_TELEGRAM_ID ? int(env.OWNER_TELEGRAM_ID, 0, 'OWNER_TELEGRAM_ID') : null,
    allowUserIds: (env.ALLOW_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => int(s, 0, 'ALLOW_USER_IDS')),
    timeZone,
    dayStartHour,
    reminderTime,
    eveningReminderTime: evening,
    staticDir: env.STATIC_DIR || null,
    backupDir: env.BACKUP_DIR === 'off' ? null : env.BACKUP_DIR || (dev ? null : path.join(path.dirname(dbPath), 'backups')),
    dataDir: env.DATA_DIR || DEFAULT_DATA_DIR,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    claudeModel: env.CLAUDE_MODEL || 'claude-opus-5-5',
    autofillDailyLimit: int(env.AUTOFILL_DAILY_LIMIT, 200, 'AUTOFILL_DAILY_LIMIT'),
    fsrsMinReviews: Math.max(1, int(env.FSRS_MIN_REVIEWS, 1000, 'FSRS_MIN_REVIEWS')),
  }
}

export function dayOptions(cfg: Pick<Config, 'timeZone' | 'dayStartHour'>): DayOptions {
  return { timeZone: cfg.timeZone, startHour: cfg.dayStartHour }
}

export function isTime(v: string): boolean {
  return TIME.test(v)
}

export function isTimeZone(v: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: v })
    return true
  } catch {
    return false
  }
}

function int(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${v}`)
  return n
}
