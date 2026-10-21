import { createApp } from './app.ts'
import { startBackups } from './backup.ts'
import { startBot } from './bot.ts'
import { loadConfig } from './config.ts'
import type { AppContext } from './context.ts'
import { openDb, type Db } from './db.ts'
import { startFsrsJob } from './fsrs.ts'
import { lexiconOf } from './lexicon.ts'
import { currentPacks, usePackDir } from './pack-data.ts'
import { syncFreqRanks } from './repo.ts'
import { migrationEnv } from './users.ts'

const cfg = loadConfig()
let db: Db
try {
  db = openDb(cfg.dbPath, migrationEnv(cfg))
} catch (e) {
  console.error(`cannot open ${cfg.dbPath}: ${(e as Error).message}`)
  process.exit(1)
}
const ctx: AppContext = { db, cfg, now: () => new Date(), telegram: { botUsername: null } }
const lexicon = lexiconOf(ctx)
if (!lexicon.hasFrequencies()) console.warn(`${cfg.dataDir}/en-freq.tsv is missing: frequency ranks and coverage are off`)
if (!lexicon.vocabTest()) console.warn(`${cfg.dataDir}/vocab-test.json is missing: the vocabulary test is off`)
syncFreqRanks(db, lexicon)
usePackDir(cfg.dataDir)
if (!currentPacks().length) console.warn(`${cfg.dataDir}/packs has no valid packs: content packs and verb forms are off`)
if (!cfg.anthropicApiKey) console.warn('ANTHROPIC_API_KEY is not set: ✨ autofill is off')

if (cfg.dev) console.warn('DEV mode: no authentication')
else {
  if (cfg.ownerTelegramId === null) console.warn('OWNER_TELEGRAM_ID is not set: MCP_TOKEN and OWNER_PASSWORD have no owner to sign in as')
  if (!cfg.botToken) console.warn('BOT_TOKEN is not set: Telegram sign-in (Mini App and bot login) is off')
  if (!cfg.ownerPassword) console.warn('OWNER_PASSWORD is not set: the password fallback is off')
  console.log(`access: owner ${cfg.ownerTelegramId ?? '-'}, ${cfg.allowUserIds.length} more allowed Telegram ids`)
}

// HOST=127.0.0.1 behind a reverse proxy; all interfaces by default.
const host = process.env.HOST || '0.0.0.0'
const server = createApp(ctx).listen(cfg.port, host, () => {
  console.log(`recall listening on ${host}:${cfg.port} (db ${cfg.dbPath}, origin ${cfg.appOrigin})`)
})
const bot = startBot(ctx)
const stopBackups = cfg.backupDir ? startBackups(db, cfg.backupDir) : () => {}
const stopFsrs = startFsrsJob(ctx)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`${signal}: shutting down`)
  stopBackups()
  stopFsrs()
  await bot?.stop().catch(() => {})
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
