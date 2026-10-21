// What the person has typed and not saved yet, by screen. While anything is
// there, Telegram asks before the Mini App closes and an app update waits.
import { setClosingConfirmation } from './telegram.ts'

const keys = new Set<string>()

export function setUnsaved(key: string, on: boolean): void {
  const had = keys.size > 0
  if (on) keys.add(key)
  else keys.delete(key)
  if (had !== keys.size > 0) setClosingConfirmation(keys.size > 0)
}

export const hasUnsaved = () => keys.size > 0
