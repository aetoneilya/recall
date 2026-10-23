import { describe, expect, it } from 'vitest'
import { AccountKV } from './accountKV.ts'
import { HttpError, NetworkError } from './api.ts'
import { EditOutbox, type PendingEdit } from './editOutbox.ts'
import { memoryKV } from './idb.ts'

describe('AccountKV', () => {
  it('gives the unowned caches to the first account, keeps each account apart, and clears on sign-out', async () => {
    const base = memoryKV()
    await base.set('review', { day: 'x' })
    await base.set('outbox', [1])
    const kv = new AccountKV(base)
    await kv.init()
    expect(kv.confirmed).toBe(false)
    expect(await kv.claim('us_a')).toBe('claimed')
    expect(kv.confirmed).toBe(true)
    expect(await kv.get('review')).toEqual({ day: 'x' })
    expect(await base.get('review')).toBeUndefined()
    expect(await base.get('us_a/outbox')).toEqual([1])

    // Next launch: the same account.
    const again = new AccountKV(base)
    await again.init()
    expect(again.owner).toBe('us_a')
    expect(await again.claim('us_a')).toBe('same')

    // Another account signs in: start over under its own keys.
    expect(await again.claim('us_b')).toBe('switched')
    const b = new AccountKV(base)
    await b.init()
    expect(b.owner).toBe('us_b')
    expect(await b.get('review')).toBeUndefined()
    await b.set('review', { day: 'b' })
    expect(await base.get('us_a/review')).toEqual({ day: 'x' })

    await b.set('outbox', [2])
    await b.clear(['outbox'])
    expect(await b.get('review')).toBeUndefined()
    expect(await b.get('outbox')).toEqual([2])
  })
})

describe('AccountKV across accounts', () => {
  it('after a 401 nothing counts as confirmed until the next account is checked', async () => {
    const base = memoryKV()
    const kv = new AccountKV(base)
    await kv.init()
    await kv.claim('us_a')
    await kv.set('outbox', ['a rating'])
    kv.lost()
    expect(kv.confirmed).toBe(false)
    // Another account signs in: it never becomes confirmed here (the app reloads), and A's outbox stays A's.
    expect(await kv.claim('us_b')).toBe('switched')
    expect(kv.confirmed).toBe(false)
    expect(await base.get('us_a/outbox')).toEqual(['a rating'])
    expect(await base.get('us_b/outbox')).toBeUndefined()
  })

  it('writes made while unowned caches move wait and land under the account', async () => {
    const base = memoryKV()
    await base.set('words', ['old'])
    const kv = new AccountKV(base)
    await kv.init()
    const claiming = kv.claim('us_a')
    const write = kv.set('review', { day: 'new' })
    const read = kv.get('words')
    await Promise.all([claiming, write])
    expect(await read).toEqual(['old'])
    expect(await base.get('review')).toBeUndefined()
    expect(await base.get('us_a/review')).toEqual({ day: 'new' })
  })

  it('a persist landing during sign-out does not bring the cleared cache back', async () => {
    const base = memoryKV()
    const kv = new AccountKV(base)
    await kv.init()
    await kv.claim('us_a')
    await kv.set('words', ['w'])
    await kv.set('outbox', [1])
    const clearing = kv.clear(['outbox'])
    await kv.set('words', ['late'])
    await kv.set('outbox', [1, 2])
    await clearing
    expect(await base.get('us_a/words')).toBeUndefined()
    expect(await base.get('us_a/outbox')).toEqual([1, 2])
  })
})

describe('EditOutbox', () => {
  function setup() {
    const saved: { edits: PendingEdit[] } = { edits: [] }
    const calls: [string, string, unknown][] = []
    let fail: Error | null = null
    const ob = new EditOutbox(
      { load: async () => saved.edits, save: async (e) => void (saved.edits = e) },
      {
        updateWord: async (id, p) => {
          calls.push(['word', id, p])
          if (fail) throw fail
        },
        updateFact: async (id, p) => {
          calls.push(['fact', id, p])
          if (fail) throw fail
        },
      },
    )
    return { ob, saved, calls, failWith: (e: Error | null) => void (fail = e) }
  }

  it('merges a card’s edits, keeps them offline and sends them once back', async () => {
    const { ob, saved, calls, failWith } = setup()
    await ob.init()
    ob.add('word', 'wd_1', { term: 'to frown', note: 'a' })
    ob.add('word', 'wd_1', { note: 'b' })
    ob.add('fact', 'ft_1', { back: 'x' })
    expect(ob.get('word', 'wd_1')).toEqual({ term: 'to frown', note: 'b' })
    failWith(new NetworkError())
    expect(await ob.flush()).toEqual({ sent: 0, failed: [] })
    expect(ob.size).toBe(2)
    await ob.persisted()
    expect(saved.edits).toHaveLength(2)
    failWith(null)
    expect(await ob.flush()).toEqual({ sent: 2, failed: [] })
    expect(calls.slice(-2)).toEqual([['word', 'wd_1', { term: 'to frown', note: 'b' }], ['fact', 'ft_1', { back: 'x' }]])
    expect(ob.size).toBe(0)
  })

  it('an online save supersedes an older offline edit of the same fields', async () => {
    const { ob, saved, calls } = setup()
    await ob.init()
    ob.add('word', 'wd_1', { note: 'OFFLINE NOTE 1', tags: ['x'] })
    ob.add('fact', 'ft_1', { back: 'kept' })
    // The editor's later online save sent the note (not the tags).
    ob.supersede('word', 'wd_1', { note: 'ONLINE NOTE 2' })
    expect(ob.get('word', 'wd_1')).toEqual({ tags: ['x'] })
    ob.supersede('word', 'wd_1', { tags: ['y'], note: 'z' })
    expect(ob.get('word', 'wd_1')).toBeUndefined()
    await ob.persisted()
    expect(saved.edits).toEqual([{ kind: 'fact', id: 'ft_1', patch: { back: 'kept' } }])
    await ob.flush()
    expect(calls).toEqual([['fact', 'ft_1', { back: 'kept' }]])
  })

  it('drops an edit the server refuses and keeps going', async () => {
    const { ob, failWith } = setup()
    await ob.init()
    ob.add('fact', 'ft_gone', { back: 'x' })
    failWith(new HttpError(404, 'fact ft_gone not found'))
    const r = await ob.flush()
    expect(r.failed).toMatchObject([{ edit: { id: 'ft_gone' }, error: 'fact ft_gone not found' }])
    expect(ob.size).toBe(0)
  })
})
