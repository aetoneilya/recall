import type { AutofillClient } from './autofill.ts'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import type { FsrsOptimizer } from './fsrs.ts'
import type { Lexicon } from './lexicon.ts'

export interface AppContext {
  db: Db
  cfg: Config
  // Injectable clock for tests.
  now: () => Date
  // Filled from getMe once the bot starts; null while unknown or with the bot off.
  telegram: { botUsername: string | null }
  // Frequency list and vocabulary-test data; absent files degrade features. Default: loaded from cfg.dataDir.
  lexicon?: Lexicon
  // Claude client for ✨ autofill. Default: built from ANTHROPIC_API_KEY; null = off. Tests inject a fake.
  autofill?: AutofillClient | null
  // fsrs-rs for training per-user FSRS weights. Default: the native binding, loaded lazily; null = off. Tests may inject a fake.
  fsrsOptimizer?: FsrsOptimizer | null
}
