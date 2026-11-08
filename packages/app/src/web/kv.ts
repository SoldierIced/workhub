// A tiny key/value store on IndexedDB, shared by the page and the service worker: the worker
// needs the identity seed to open pushed notifications, and it cannot read localStorage.
const DB = 'workhub-remote'
const STORE = 'kv'

export const SEED_KEY = 'seed'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function kvSet(key: string, value: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function kvGet(key: string): Promise<string | null> {
  const db = await openDb()
  const value = await new Promise<string | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return value
}
