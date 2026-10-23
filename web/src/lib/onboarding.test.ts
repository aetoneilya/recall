// The first-run wizard store with its services faked: the step order, Skip,
// the level from the vocabulary test, the packs preselected by level, what
// Done applies (packs, new cards per day, onboarded), and the gesture coach
// shown once.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackInfo } from './types.ts'

const h = vi.hoisted(() => ({
  calls: [] as [string, ...unknown[]][],
  packs: [] as unknown[],
  failAdd: false,
  me: null as Record<string, unknown> | null,
  patchFails: false,
}))

vi.mock('./app.svelte.ts', () => {
  const status = { auth: 'ok', meFresh: true, me: null as unknown, wordsVersion: 0, factsVersion: 0 }
  return {
    status,
    COACH_PENDING: 'coachSeenPending',
    kv: { get: async () => undefined, set: async (...a: unknown[]) => void h.calls.push(['kv.set', ...a]), del: async () => {} },
    setMe: async (me: unknown) => {
      h.calls.push(['setMe', me])
      status.me = me
    },
    api: {
      packs: async () => {
        h.calls.push(['packs'])
        return h.packs
      },
      decks: async () => [{ id: 'dk_notes', targetLang: null, nativeLang: null }, { id: 'dk_en', targetLang: 'en', nativeLang: 'ru' }],
      addPack: async (id: string, deckId?: string) => {
        h.calls.push(['addPack', id, deckId])
        if (h.failAdd) throw new Error('Offline')
        return { added: 1, alreadyAdded: 0, duplicates: 0, packs: h.packs }
      },
      patchDeck: async (id: string, p: unknown) => void h.calls.push(['patchDeck', id, p]),
      patchMe: async (p: Record<string, unknown>) => {
        h.calls.push(['patchMe', p])
        if (h.patchFails) throw new Error('Offline')
        return { ...h.me, ...p }
      },
    },
  }
})
vi.mock('./toast.svelte.ts', () => ({ errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))

const pack = (id: string, over: Partial<PackInfo> = {}): PackInfo => ({ id, name: id, description: '', count: 3, added: false, missing: 3, deckName: 'English', ...over })
const starter = (level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1') => pack(`starter-${level.toLowerCase()}`, { format: 'words', level, name: `Starter words ${level}` })
const ALL = [starter('A1'), starter('A2'), starter('B1'), starter('B2'), starter('C1'), pack('irregular-verbs', { format: 'irregular-verbs' }), pack('grammar-handbook', { format: 'grammar-handbook' })]
const result = (id: string | null, valid = true) => ({ cefr: { level: id ? { id, label: id, value: 0, size: 0, group: 'learner' } : null, next: null }, valid }) as never

async function fresh() {
  const m = await import('./onboarding.svelte.ts')
  m.wizard.reset()
  return m
}

beforeEach(() => {
  h.calls = []
  h.packs = ALL
  h.failAdd = false
  h.patchFails = false
  h.me = { user: { id: 'us_1' }, onboarded: false, coachSeen: false }
})

describe('the wizard', () => {
  it('goes welcome → level → packs → pace → done, and Back retraces it', async () => {
    const { wizard } = await fresh()
    const seen = [wizard.step]
    wizard.next()
    seen.push(wizard.step)
    wizard.chooseLevel('A2')
    seen.push(wizard.step)
    wizard.next()
    seen.push(wizard.step)
    wizard.next()
    seen.push(wizard.step)
    expect(seen).toEqual(['welcome', 'level', 'packs', 'pace', 'done'])
    wizard.next()
    expect(wizard.step).toBe('done')
    for (const step of ['pace', 'packs', 'level', 'welcome', 'welcome']) {
      wizard.back()
      expect(wizard.step).toBe(step)
    }
  })

  it('Skip goes to Done with the defaults (B1, its starter words, 10 a day); Back returns', async () => {
    const { wizard } = await fresh()
    await wizard.load()
    wizard.next()
    wizard.skip()
    expect(wizard.step).toBe('done')
    expect(wizard.chosenLevel).toBe('B1')
    expect(wizard.chosen).toEqual(['starter-b1'])
    expect(wizard.pace).toBe(10)
    wizard.back()
    expect(wizard.step).toBe('level')
    expect(await wizard.finish()).toBe(true)
    expect(h.calls.filter(([c]) => c !== 'packs')).toEqual([
      ['addPack', 'starter-b1', 'dk_en'],
      ['patchDeck', 'dk_en', { newPerDay: 10 }],
      ['patchMe', { onboarded: true }],
      ['setMe', expect.objectContaining({ onboarded: true })],
    ])
  })

  it('takes the level from the test, preselected; leaving the test keeps the level as it was', async () => {
    const { wizard, levelFromTest } = await fresh()
    wizard.next()
    wizard.takeTest()
    expect(wizard.testing).toBe(true)
    // Back inside the test's own flow hands back no result.
    wizard.testDone(null)
    expect([wizard.testing, wizard.step, wizard.level]).toEqual([false, 'level', null])
    wizard.takeTest()
    wizard.testDone(result('B2'))
    expect([wizard.step, wizard.level, wizard.levelVia]).toEqual(['level', 'B2', 'test'])
    // An invalid result (too many made-up words) isn't used.
    wizard.testDone(result('C1', false))
    expect(wizard.level).toBe('B2')
    // Back from the test screen goes to the level step, not past it.
    wizard.takeTest()
    wizard.back()
    expect([wizard.testing, wizard.step]).toEqual([false, 'level'])
    expect([null, 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((id) => levelFromTest(result(id)))).toEqual(['A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C1'])
  })

  it('preselects the starter words of the level; offers the next level, irregular verbs and the handbook', async () => {
    const { wizard, packOffers } = await fresh()
    await wizard.load()
    wizard.next()
    wizard.chooseLevel('A2')
    expect(wizard.offers.map((o) => [o.pack.id, o.preselected])).toEqual([
      ['starter-a2', true], ['starter-b1', false], ['irregular-verbs', false], ['grammar-handbook', false],
    ])
    expect(wizard.chosen).toEqual(['starter-a2'])
    wizard.toggle('grammar-handbook')
    wizard.toggle('starter-a2')
    expect(wizard.chosen).toEqual(['grammar-handbook'])
    // A new level brings its own defaults.
    wizard.back()
    wizard.chooseLevel('C1')
    expect(wizard.offers.map((o) => o.pack.id)).toEqual(['starter-c1', 'irregular-verbs', 'grammar-handbook'])
    expect(wizard.chosen).toEqual(['starter-c1'])
    // Only what the server has: no starter files, no starter offers.
    expect(packOffers(ALL.slice(5), 'B1').map((o) => [o.pack.id, o.preselected])).toEqual([['irregular-verbs', false], ['grammar-handbook', false]])
    expect(packOffers([], 'B1')).toEqual([])
    // A pack already in full isn't offered.
    expect(packOffers([{ ...starter('B1'), added: true, missing: 0 }, starter('B2')], 'B1').map((o) => o.pack.id)).toEqual(['starter-b2'])
  })

  it('applies the new cards per day and the packs to the default deck, then sets onboarded', async () => {
    const { wizard } = await fresh()
    await wizard.load()
    wizard.next()
    wizard.chooseLevel('A1')
    wizard.toggle('irregular-verbs')
    wizard.next()
    wizard.pace = 20
    wizard.next()
    h.failAdd = true
    expect(await wizard.finish()).toBe(false)
    expect(wizard.error).toBe('Offline')
    expect(h.calls.some(([c]) => c === 'patchMe')).toBe(false)
    h.failAdd = false
    h.calls = []
    expect(await wizard.finish()).toBe(true)
    expect(wizard.error).toBe('')
    expect(h.calls).toEqual([
      ['addPack', 'starter-a1', 'dk_en'],
      ['addPack', 'irregular-verbs', 'dk_en'],
      ['patchDeck', 'dk_en', { newPerDay: 20 }],
      ['patchMe', { onboarded: true }],
      ['setMe', expect.objectContaining({ onboarded: true })],
    ])
  })

  it('runs only for a new account whose account came from the server', async () => {
    const { needsWizard } = await fresh()
    const me = (onboarded?: boolean) => ({ onboarded }) as never
    expect(needsWizard({ auth: 'ok', meFresh: true, me: me(false) })).toBe(true)
    expect(needsWizard({ auth: 'ok', meFresh: true, me: me(true) })).toBe(false)
    // An older server sends no flag; offline, the cached account isn't enough.
    expect(needsWizard({ auth: 'ok', meFresh: true, me: me(undefined) })).toBe(false)
    expect(needsWizard({ auth: 'ok', meFresh: false, me: me(false) })).toBe(false)
    expect(needsWizard({ auth: 'login', meFresh: true, me: me(false) })).toBe(false)
  })
})

describe('the gesture coach', () => {
  it('shows once after onboarding and is remembered by the server', async () => {
    const { coach } = await import('./coach.svelte.ts')
    const { status } = await import('./app.svelte.ts')
    coach.reset()
    status.me = { onboarded: false, coachSeen: false } as never
    expect(coach.visible).toBe(false)
    status.me = { onboarded: true, coachSeen: false } as never
    expect(coach.visible).toBe(true)
    coach.dismiss()
    coach.dismiss()
    expect(coach.visible).toBe(false)
    expect(h.calls).toEqual([['patchMe', { coachSeen: true }]])
    // A later /api/me read that predates the PATCH doesn't bring it back.
    status.me = { onboarded: true, coachSeen: false } as never
    expect(coach.visible).toBe(false)
  })

  it('keeps a dismissal the server didn\'t get for the next sign-in', async () => {
    const { coach } = await import('./coach.svelte.ts')
    const { status } = await import('./app.svelte.ts')
    coach.reset()
    h.patchFails = true
    status.me = { onboarded: true, coachSeen: false } as never
    coach.dismiss()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.calls).toEqual([['patchMe', { coachSeen: true }], ['kv.set', 'coachSeenPending', true]])
    expect(coach.visible).toBe(false)
  })
})
