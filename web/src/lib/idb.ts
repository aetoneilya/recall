// Minimal promise wrapper over one IndexedDB object store used as a
// key-value map. Falls back to memory when IndexedDB is unavailable (some
// private modes), so the app still works, just without persistence.

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
    const d = await open()
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
  const guard = async <T>(op: () => Promise<T>, mem: () => Promise<T>) => {
    if (broken) return mem()
    try {
      return await op()
    } catch (e) {
      console.warn('IndexedDB unavailable, using memory', e)
      broken = true
      return mem()
    }
  }
  return {
    get: <T>(key: string) =>
      guard(
        () => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
        () => fallback.get<T>(key),
      ),
    // Values are stored via structured clone; $state proxies can't be cloned,
    // so callers pass plain data ($state.snapshot).
    set: (key, value) =>
      guard(
        () => tx<void>('readwrite', (s) => void s.put(value, key)),
        () => fallback.set(key, value),
      ),
    del: (key) =>
      guard(
        () => tx<void>('readwrite', (s) => void s.delete(key)),
        () => fallback.del(key),
      ),
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
