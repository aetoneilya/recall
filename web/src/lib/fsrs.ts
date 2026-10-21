// The client's FSRS scheduler. Built from the user's own weights when the
// server sends them (GET /api/me `fsrs`), so the intervals on the buttons and
// the states rated offline match what the server computes.
import { scheduler } from '@recall/core'
import type { FsrsParams } from './types.ts'

export type Scheduler = ReturnType<typeof scheduler>

let current: Scheduler = scheduler()
let key = 'null'

export function setFsrs(p: FsrsParams | null | undefined): void {
  const k = JSON.stringify(p ?? null)
  if (k === key) return
  key = k
  current = scheduler(p ? { weights: p.weights ?? undefined, requestRetention: p.requestRetention } : {})
}

export const fsrs = (): Scheduler => current
