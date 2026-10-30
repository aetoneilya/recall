import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ decks: vi.fn(), patchDeck: vi.fn() }))
vi.mock('./app.svelte.ts', () => ({ api }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})

describe('deck settings across screens', () => {
  it('reads the latest value when another screen opens during rapid edits', async () => {
    const { getDecks, saveDeck } = await import('./decks.ts')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let newPerDay = 10
    api.patchDeck.mockImplementationOnce(async () => { await gate; newPerDay = 11 })
      .mockImplementationOnce(async () => { newPerDay = 12 })
    api.decks.mockImplementation(async () => [{ id: 'dk_1', newPerDay }])

    const first = saveDeck('dk_1', { newPerDay: 11 })
    const second = saveDeck('dk_1', { newPerDay: 12 })
    const opened = getDecks(true)
    await vi.waitFor(() => expect(api.patchDeck).toHaveBeenCalledTimes(1))
    expect(api.decks).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(await opened).toEqual([{ id: 'dk_1', newPerDay: 12 }])
  })

  it('allows the next edit and refresh after a failed save', async () => {
    const { getDecks, saveDeck } = await import('./decks.ts')
    api.patchDeck.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ id: 'dk_1', newPerDay: 12 })
    api.decks.mockResolvedValue([{ id: 'dk_1', newPerDay: 12 }])
    const first = saveDeck('dk_1', { newPerDay: 11 })
    const second = saveDeck('dk_1', { newPerDay: 12 })
    const opened = getDecks(true)
    await expect(first).rejects.toThrow('Offline')
    await second
    expect(await opened).toEqual([{ id: 'dk_1', newPerDay: 12 }])
  })
})
