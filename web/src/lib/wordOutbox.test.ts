import { describe, expect, it } from 'vitest'
import { AuthError, HttpError, NetworkError } from './api.ts'
import { WordOutbox, type PendingWord } from './wordOutbox.ts'
import type { NewWord } from './types.ts'

const w = (term: string): NewWord => ({ term, pos: 'noun', translations: ['x'] })

function setup(answers: ((w: NewWord) => unknown)[], saved: PendingWord[] = []) {
  let store = saved
  const sent: string[] = []
  const box = new WordOutbox(
    { load: async () => store, save: async (x) => void (store = x) },
    {
      createWord: async (input) => {
        sent.push(input.term)
        const a = answers.shift()
        return a ? a(input) : {}
      },
    },
  )
  return { box, sent, stored: () => store }
}

describe('WordOutbox', () => {
  it('sends queued words in order and persists what is left', async () => {
    const { box, sent, stored } = setup([])
    await box.init()
    box.add(w('moor'))
    box.add(w('bleak'))
    await box.persisted()
    expect(stored().map((p) => p.input.term)).toEqual(['moor', 'bleak'])
    const r = await box.flush()
    expect(r).toEqual({ ok: true, added: ['moor', 'bleak'], duplicates: [], failed: [] })
    expect(sent).toEqual(['moor', 'bleak'])
    await box.persisted()
    expect(stored()).toEqual([])
  })

  it('stops offline and keeps the word for later', async () => {
    const { box } = setup([() => Promise.reject(new NetworkError('down'))])
    await box.init()
    box.add(w('moor'))
    expect(await box.flush()).toMatchObject({ ok: false, reason: 'offline', added: [] })
    expect(box.size).toBe(1)
    expect(await box.flush()).toMatchObject({ ok: true, added: ['moor'] })
  })

  it('counts a duplicate as done and drops refused words', async () => {
    const { box } = setup([
      () => Promise.reject(new HttpError(409, 'exists')),
      () => Promise.reject(new HttpError(400, 'at least one translation is required')),
      () => Promise.reject(new HttpError(503, 'busy')),
    ])
    await box.init()
    for (const t of ['a', 'b', 'c']) box.add(w(t))
    const r = await box.flush()
    expect(r).toMatchObject({ ok: false, reason: 'server', duplicates: ['a'], failed: [{ term: 'b', error: 'at least one translation is required' }] })
    expect(box.list().map((p) => p.input.term)).toEqual(['c'])
  })

  it('waits on auth and can take a word back before it is sent', async () => {
    const { box } = setup([() => Promise.reject(new AuthError())])
    await box.init()
    const id = box.add(w('a'))
    box.add(w('b'))
    expect(box.remove(id)).toBe(true)
    expect(await box.flush()).toMatchObject({ ok: false, reason: 'auth' })
    expect(box.size).toBe(1)
  })

  it('restores saved words on init', async () => {
    const { box } = setup([], [{ id: 'pw_1', input: w('saved'), queuedAt: '2026-10-21T10:00:00Z' }])
    await box.init()
    expect(box.list()[0].input.term).toBe('saved')
  })
})
