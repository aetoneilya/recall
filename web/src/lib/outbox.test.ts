import type { ReviewInput } from '@recall/core'
import { describe, expect, it, vi } from 'vitest'
import { AuthError, HttpError, NetworkError } from './api.ts'
import { BATCH, Outbox, type OutboxOp, type OutboxStore, type OutboxTransport } from './outbox.ts'

const input = (id: string, at = '2026-10-21T10:00:00Z'): ReviewInput => ({ id, cardId: `cd_${id}`, rating: 3, reviewedAt: at, durationMs: 1000 })

function memStore(initial: OutboxOp[] = []): OutboxStore & { saved: OutboxOp[] } {
  const s = {
    saved: initial,
    load: async () => s.saved,
    save: async (ops: OutboxOp[]) => void (s.saved = ops),
  }
  return s
}

// A fake server that applies reviews idempotently, like the real one.
function fakeServer() {
  const applied = new Map<string, ReviewInput>()
  const undone: string[] = []
  const calls: string[][] = []
  let fail: Error | null = null
  const transport: OutboxTransport = {
    postReviews: vi.fn(async (inputs: ReviewInput[]) => {
      calls.push(inputs.map((i) => i.id))
      if (fail) throw fail
      let a = 0
      let s = 0
      for (const i of inputs) {
        if (applied.has(i.id)) s++
        else {
          applied.set(i.id, i)
          a++
        }
      }
      return { applied: a, skipped: s, cards: [] }
    }),
    undoReview: vi.fn(async (id: string) => {
      if (fail) throw fail
      if (!applied.delete(id)) throw new HttpError(404, 'no such review')
      undone.push(id)
    }),
  }
  return {
    transport,
    applied,
    undone,
    calls,
    failWith: (e: Error | null) => void (fail = e),
  }
}

describe('Outbox', () => {
  it('uploads pending reviews and empties itself', async () => {
    const srv = fakeServer()
    const store = memStore()
    const ob = new Outbox(store, srv.transport)
    await ob.init()
    ob.add(input('a'))
    ob.add(input('b'))
    expect(ob.pending).toBe(2)
    expect(await ob.flush()).toEqual({ ok: true, sent: 2 })
    expect([...srv.applied.keys()]).toEqual(['a', 'b'])
    expect(ob.pending).toBe(0)
    await ob.persisted()
    expect(store.saved).toEqual([])
  })

  it('keeps everything when offline and resends the same ids later', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    srv.failWith(new NetworkError('Failed to fetch'))
    expect(await ob.flush()).toMatchObject({ ok: false, reason: 'offline' })
    expect(ob.pending).toBe(1)
    srv.failWith(null)
    expect(await ob.flush()).toMatchObject({ ok: true })
    expect(srv.calls).toEqual([['a'], ['a']])
  })

  it('is idempotent when a response is lost after the server applied it', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    // The server applies the batch but the connection drops before the reply.
    vi.mocked(srv.transport.postReviews).mockImplementationOnce(async (inputs) => {
      for (const i of inputs) srv.applied.set(i.id, i)
      throw new NetworkError('connection reset')
    })
    await ob.flush()
    expect(ob.pending).toBe(1)
    await ob.flush()
    expect(srv.applied.size).toBe(1)
    expect(ob.pending).toBe(0)
  })

  it('survives a restart: ops are persisted and reloaded', async () => {
    const store = memStore()
    const srv = fakeServer()
    const first = new Outbox(store, srv.transport)
    await first.init()
    first.add(input('a'))
    first.add(input('b'))
    await first.persisted()

    const second = new Outbox(store, srv.transport)
    await second.init()
    expect(second.pending).toBe(2)
    await second.flush()
    expect([...srv.applied.keys()]).toEqual(['a', 'b'])
  })

  it('shares one upload between concurrent flushes', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    const [x, y] = await Promise.all([ob.flush(), ob.flush()])
    expect(x).toBe(y)
    expect(srv.calls).toEqual([['a']])
  })

  it('does not lose a rating added while an upload is in flight', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    let release!: () => void
    vi.mocked(srv.transport.postReviews).mockImplementationOnce(
      (inputs) =>
        new Promise((resolve) => {
          release = () => {
            for (const i of inputs) srv.applied.set(i.id, i)
            resolve({ applied: inputs.length, skipped: 0, cards: [] })
          }
        }),
    )
    const p = ob.flush()
    await Promise.resolve()
    ob.add(input('b'))
    release()
    await p
    // The flush loop picks up 'b' in the same run.
    expect([...srv.applied.keys()]).toEqual(['a', 'b'])
    expect(ob.pending).toBe(0)
  })

  it('sends in batches', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    for (let i = 0; i < BATCH + 3; i++) ob.add(input(`r${i}`))
    await ob.flush()
    expect(srv.calls.map((c) => c.length)).toEqual([BATCH, 3])
  })

  it('undo of an unsent review just removes it', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    ob.add(input('b'))
    expect(ob.undo('b')).toBe('local')
    await ob.flush()
    expect([...srv.applied.keys()]).toEqual(['a'])
    expect(srv.transport.undoReview).not.toHaveBeenCalled()
  })

  it('undo of a sent review queues an undo call, in order after pending reviews', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    await ob.flush()
    ob.add(input('b'))
    expect(ob.undo('a')).toBe('queued')
    expect(ob.pending).toBe(1)
    await ob.flush()
    expect(srv.undone).toEqual(['a'])
    expect([...srv.applied.keys()]).toEqual(['b'])
    expect(ob.size).toBe(0)
  })

  it('treats an undo the server no longer knows as done', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore([{ kind: 'undo', id: 'gone' }]), srv.transport)
    await ob.init()
    expect(await ob.flush()).toEqual({ ok: true, sent: 1 })
    expect(ob.size).toBe(0)
  })

  it('stops on 401 and keeps the ops for after login', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    await ob.init()
    ob.add(input('a'))
    srv.failWith(new AuthError())
    expect(await ob.flush()).toMatchObject({ ok: false, reason: 'auth' })
    expect(ob.pending).toBe(1)
  })

  it('retries server errors but drops a batch the server rejects as invalid', async () => {
    const srv = fakeServer()
    const ob = new Outbox(memStore(), srv.transport)
    const dropped = vi.fn()
    ob.onDropped = dropped
    await ob.init()
    ob.add(input('a'))
    srv.failWith(new HttpError(503, 'unavailable'))
    expect(await ob.flush()).toMatchObject({ ok: false, reason: 'server' })
    expect(ob.pending).toBe(1)
    srv.failWith(new HttpError(400, 'bad rating'))
    expect(await ob.flush()).toMatchObject({ ok: true })
    expect(ob.pending).toBe(0)
    expect(dropped).toHaveBeenCalledOnce()
  })

  it('notifies subscribers of the pending count', async () => {
    const ob = new Outbox(memStore(), fakeServer().transport)
    const seen: number[] = []
    ob.subscribe((n) => seen.push(n))
    await ob.init()
    ob.add(input('a'))
    await ob.flush()
    expect(seen).toEqual([0, 0, 1, 0])
  })
})
