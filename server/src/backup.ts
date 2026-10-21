import fs from 'node:fs'
import path from 'node:path'
import type { Db } from './db.ts'

const KEEP = 14
const NAME = /^recall-(\d{4}-\d{2}-\d{2})\.db$/

// One VACUUM INTO snapshot per calendar day (UTC), keeping the newest 14.
export function backupOnce(db: Db, dir: string, now: Date): string | null {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `recall-${now.toISOString().slice(0, 10)}.db`)
  let made: string | null = null
  if (!fs.existsSync(file)) {
    db.prepare('VACUUM INTO ?').run(file)
    made = file
  }
  const old = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse().slice(KEEP)
  for (const f of old) fs.rmSync(path.join(dir, f))
  return made
}

export function startBackups(db: Db, dir: string): () => void {
  const run = () => {
    try {
      const made = backupOnce(db, dir, new Date())
      if (made) console.log(`backup written: ${made}`)
    } catch (e) {
      console.error('backup failed:', e)
    }
  }
  run()
  const timer = setInterval(run, 3600_000)
  return () => clearInterval(timer)
}
