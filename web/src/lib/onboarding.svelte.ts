// The first-run wizard of a new account (Me.onboarded === false), shown by
// App instead of the tabs: welcome → level (the vocabulary test, a pick, or
// "Not sure" = B1) → packs → new cards per day → done. Done adds the picked
// packs into the default deck (the normal pack route), sets its new cards
// per day and marks the account onboarded. Every step can be skipped: Skip
// goes to Done with the defaults so far; Back retraces the steps taken.
import { api, setMe, status } from './app.svelte.ts'
import { errorText } from './toast.svelte.ts'
import type { DeckWithCounts, PackInfo, TestResult } from './types.ts'

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const
export type Level = (typeof LEVELS)[number]
export const STEPS = ['welcome', 'level', 'packs', 'pace', 'done'] as const
export type Step = (typeof STEPS)[number]
export const PACES = [5, 10, 20] as const
// "Not sure" (and Skip before a level was chosen).
export const DEFAULT_LEVEL: Level = 'B1'
export const DEFAULT_PACE = 10

export const LEVEL_NAMES: Record<Level, string> = { A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper intermediate', C1: 'Advanced' }

// Where the test's estimate sits on the learner scale (the server places it
// with vocab-scale.json) as a starter level: below A1 is A1, C2 is C1.
export function levelFromTest(r: Pick<TestResult, 'cefr'>): Level {
  const id = r.cefr.level?.id
  if (id === 'C2') return 'C1'
  return (LEVELS as readonly string[]).includes(id ?? '') ? (id as Level) : 'A1'
}

export const nextLevel = (l: Level): Level | null => LEVELS[LEVELS.indexOf(l) + 1] ?? null

export interface Offer {
  pack: PackInfo
  // Ticked when the step opens.
  preselected: boolean
}

const starterFor = (packs: PackInfo[], l: Level | null) => (l ? packs.find((p) => p.format === 'words' && p.level === l) : undefined)

// What the packs step offers for a level, in this order and only what the
// server has: the level's starter words (ticked), the next level's, the
// irregular verbs, the grammar handbook. A pack already in full is left out.
export function packOffers(packs: PackInfo[], level: Level): Offer[] {
  const own = starterFor(packs, level)
  const list: Offer[] = [
    ...(own ? [{ pack: own, preselected: true }] : []),
    ...[starterFor(packs, nextLevel(level)), packs.find((p) => p.format === 'irregular-verbs'), packs.find((p) => p.format === 'grammar-handbook')]
      .filter((p): p is PackInfo => !!p)
      .map((pack) => ({ pack, preselected: false })),
  ]
  return list.filter((o) => !o.pack.added || o.pack.missing > 0)
}

export const defaultPicks = (packs: PackInfo[], level: Level): string[] => packOffers(packs, level).filter((o) => o.preselected).map((o) => o.pack.id)

// The deck packs and the pace go to: the English deck, else the first with
// languages (GET /api/decks makes the English one for a new account).
export function defaultDeckOf(decks: Pick<DeckWithCounts, 'id' | 'targetLang' | 'nativeLang'>[]) {
  return decks.find((d) => d.targetLang === 'en') ?? decks.find((d) => d.targetLang && d.nativeLang) ?? null
}

class Wizard {
  step = $state<Step>('welcome')
  // The steps behind this one, for Back.
  trail = $state<Step[]>([])
  level = $state<Level | null>(null)
  // How the level was set: from the test, picked, or "Not sure".
  levelVia = $state<'test' | 'pick' | 'unsure' | null>(null)
  // The vocabulary test is on screen (started from the level step).
  testing = $state(false)
  packs = $state.raw<PackInfo[] | null>(null)
  // null: the defaults for the level (they follow it until something is ticked).
  picks = $state<string[] | null>(null)
  pace = $state<number>(DEFAULT_PACE)
  finishing = $state(false)
  error = $state('')
  private loading: Promise<void> | null = null

  get chosenLevel(): Level {
    return this.level ?? DEFAULT_LEVEL
  }

  get offers(): Offer[] {
    return packOffers(this.packs ?? [], this.chosenLevel)
  }

  get chosen(): string[] {
    const offered = new Set(this.offers.map((o) => o.pack.id))
    return (this.picks ?? defaultPicks(this.packs ?? [], this.chosenLevel)).filter((id) => offered.has(id))
  }

  // Packs are read once, on the way in; without them the step offers nothing.
  load(): Promise<void> {
    this.loading ??= api.packs().then((p) => void (this.packs = p), () => void (this.packs ??= []))
    return this.loading
  }

  private go(step: Step) {
    if (step === this.step) return
    this.trail = [...this.trail, this.step]
    this.step = step
    this.error = ''
  }

  next() {
    const i = STEPS.indexOf(this.step)
    if (i < STEPS.length - 1) this.go(STEPS[i + 1]!)
  }

  back() {
    if (this.testing) {
      this.testing = false
      return
    }
    const prev = this.trail.at(-1)
    if (!prev) return
    this.trail = this.trail.slice(0, -1)
    this.step = prev
    this.error = ''
  }

  skip() {
    this.go('done')
  }

  // A level picked (or "Not sure"): on to the packs.
  chooseLevel(l: Level | 'unsure') {
    this.level = l === 'unsure' ? DEFAULT_LEVEL : l
    this.levelVia = l === 'unsure' ? 'unsure' : 'pick'
    this.picks = null
    this.next()
  }

  takeTest() {
    this.testing = true
  }

  // Back from the test: with a result its level is preselected on the level
  // step (to confirm or change); without one, the level step as it was.
  testDone(r: Pick<TestResult, 'cefr' | 'valid'> | null) {
    this.testing = false
    if (!r || r.valid === false) return
    this.level = levelFromTest(r)
    this.levelVia = 'test'
    this.picks = null
  }

  toggle(id: string) {
    const now = this.chosen
    this.picks = now.includes(id) ? now.filter((x) => x !== id) : [...now, id]
  }

  // Adds the picked packs into the default deck, sets its pace, then marks
  // the account onboarded. A pack already added is skipped on a retry
  // (adding is idempotent anyway). False on a failure (error says why).
  async finish(): Promise<boolean> {
    if (this.finishing) return false
    this.finishing = true
    this.error = ''
    try {
      await this.load()
      const deck = defaultDeckOf(await api.decks())
      const ids = this.chosen
      for (const id of ids) await api.addPack(id, deck?.id)
      if (deck) await api.patchDeck(deck.id, { newPerDay: this.pace })
      await setMe(await api.patchMe({ onboarded: true }))
      status.wordsVersion++
      status.factsVersion++
      return true
    } catch (e) {
      this.error = errorText(e)
      return false
    } finally {
      this.finishing = false
    }
  }

  // Starts over (a test helper, and a new sign-in).
  reset() {
    this.step = 'welcome'
    this.trail = []
    this.level = null
    this.levelVia = null
    this.testing = false
    this.packs = null
    this.picks = null
    this.pace = DEFAULT_PACE
    this.finishing = false
    this.error = ''
    this.loading = null
  }
}

export const wizard = new Wizard()

// App shows the wizard instead of the tabs: a signed-in new account whose
// `me` came from the server this visit (offline, or an older server that
// sends no flag: no wizard).
export const needsWizard = (s: Pick<typeof status, 'auth' | 'me' | 'meFresh'>) => s.auth === 'ok' && s.meFresh && s.me?.onboarded === false
