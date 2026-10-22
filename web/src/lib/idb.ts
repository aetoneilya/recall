// Minimal promise wrapper over one IndexedDB object store used as a
// key-value map. Falls back to memory when IndexedDB can't be opened (some
// private modes), so the app still works, just without persistence. One
// failed read or write (e.g. a value that can't be cloned) is logged and
// changes nothing else: the store keeps using IndexedDB.

export interface KV {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

const STORE = 'kv'

export function openKV(name: string): KV {
  let db: Promise<IDBDatabase> | null = null
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => {
        const d = req.result
        // Another tab upgraded the schema; reopen lazily next time.
        d.onversionchange = () => {
          d.close()
          db = null
        }
        resolve(d)
      }
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDB blocked'))
    }))

  async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    let d: IDBDatabase
    try {
      d = await open()
    } catch (e) {
      throw new Unavailable(e)
    }
    return new Promise<T>((resolve, reject) => {
      const t = d.transaction(STORE, mode)
      const req = fn(t.objectStore(STORE))
      t.oncomplete = () => resolve(req ? req.result : (undefined as T))
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }

  if (typeof indexedDB === 'undefined') return memoryKV()
  const fallback = memoryKV()
  let broken = false
  const guard = async <T>(op: () => Promise<T>, mem: () => Promise<T>, failed: T) => {
    if (broken) return mem()
    try {
      return await op()
    } catch (e) {
      if (e instanceof Unavailable) {
        console.warn('IndexedDB unavailable, using memory', e.cause)
        broken = true
        return mem()
      }
      console.warn('IndexedDB operation failed', e)
      return failed
    }
  }
  return {
    get: <T>(key: string) =>
      guard(
        () => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
        () => fallback.get<T>(key),
        undefined,
      ),
    // Values are stored via structured clone; $state proxies can't be cloned,
    // so callers pass plain data ($state.snapshot).
    set: (key, value) =>
      guard(
        () => tx<void>('readwrite', (s) => void s.put(value, key)),
        () => fallback.set(key, value),
        undefined,
      ),
    del: (key) =>
      guard(
        () => tx<void>('readwrite', (s) => void s.delete(key)),
        () => fallback.del(key),
        undefined,
      ),
  }
}

class Unavailable extends Error {
  constructor(cause: unknown) {
    super('IndexedDB unavailable', { cause })
  }
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>()
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
  }
}
