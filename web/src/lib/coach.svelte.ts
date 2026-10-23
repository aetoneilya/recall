// The gesture coach: a one-time overlay on the first review card after the
// first-run wizard (tap to flip, → Good, ← Hard, ↓ Again, ↑ Easy). Seen is
// the account's (Me.coachSeen, PATCH /api/me), so it shows once, not once
// per device; a dismissal that couldn't be sent waits on the device and goes
// with the next /api/me (app.setMe).
import { api, COACH_PENDING, kv, status } from './app.svelte.ts'

// Dismissed this visit, whatever a /api/me read meanwhile still says.
let dismissed = $state(false)

export const coach = {
  get visible(): boolean {
    return !dismissed && status.me?.onboarded === true && status.me.coachSeen === false
  },
  // The first tap or swipe on the card; the gesture itself goes on as usual.
  dismiss() {
    if (!coach.visible) return
    dismissed = true
    if (status.me) status.me.coachSeen = true
    void api.patchMe({ coachSeen: true }).catch(() => kv.set(COACH_PENDING, true))
  },
  // Tests.
  reset() {
    dismissed = false
  },
}
