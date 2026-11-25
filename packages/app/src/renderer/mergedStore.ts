import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { MergedPullRequestsResult, MergedRequest } from '@shared/codehost-api'
import { errorText } from './lib/errorText'
import { RunQueue } from './lib/runQueue'

type MergedOk = Extract<MergedPullRequestsResult, { ok: true }>

/** What the Merged view shows for one request: the last good answer, why the last read failed, and whether one is running. */
export interface MergedEntry {
  data: MergedOk | null
  failure: { state: string; error: string; retryAt?: number } | null
  loading: boolean
}

const EMPTY: MergedEntry = { data: null, failure: null, loading: false }
const entries = new Map<string, MergedEntry>()
const listeners = new Set<() => void>()
const queue = new RunQueue()
/** Requests an open Merged view is showing, with their profile: they read again after a write. */
const open = new Map<string, { profileId: string | null; request: MergedRequest; users: number }>()

export const mergedKey = (profileId: string | null, r: MergedRequest): string => `${profileId ?? ''}|${r.since}|${r.until}|${r.mine ? 1 : 0}|${r.allProfiles ? 'all' : 'this'}`

/** One unforced read per request on screen, scheduled for just after the time the host said to ask again. */
const retries = new Map<string, ReturnType<typeof setTimeout>>()
const RETRY_GRACE_MS = 1000

function clearRetry(key: string): void {
  const t = retries.get(key)
  if (t !== undefined) clearTimeout(t)
  retries.delete(key)
}

/** When the answer says when to ask again and the request is on screen, reads it again then (once). */
function scheduleRetry(key: string, profileId: string | null, request: MergedRequest, retryAt: number | undefined): void {
  clearRetry(key)
  if (retryAt === undefined || !open.has(key)) return
  retries.set(
    key,
    setTimeout(() => {
      retries.delete(key)
      if (open.has(key)) void readMerged(profileId, request)
    }, Math.max(0, retryAt + RETRY_GRACE_MS - Date.now()))
  )
}

/** The `retryAt` of an answer: a refusal's, or the one of a failed sync that kept saved data. */
function retryOf(result: MergedPullRequestsResult): number | undefined {
  if (!result.ok) return result.retryAt
  return result.sync?.state === 'failed' ? result.sync.retryAt : undefined
}

/** Answers kept besides the ones on screen: each can hold 10,000 pull requests, and main keeps them all in its database. */
export const MERGED_KEPT = 6

function set(key: string, entry: MergedEntry): void {
  // The most recent last; the oldest answers not on screen (and not loading) go first.
  entries.delete(key)
  entries.set(key, entry)
  let over = entries.size - MERGED_KEPT
  for (const [k, e] of entries) {
    if (over <= 0) break
    if (k === key || open.has(k) || e.loading) continue
    entries.delete(k)
    clearRetry(k)
    over--
  }
  for (const l of listeners) l()
}

/**
 * Reads one request through the main process (which keeps answers ten minutes unless `force`). The last good
 * answer stays when a read fails or while the next one loads. A forced read asked during a read runs after it.
 */
export function readMerged(profileId: string | null, request: MergedRequest, force = false): Promise<void> {
  const key = mergedKey(profileId, request)
  return queue.request(key, force, async () => {
    const current = entries.get(key) ?? EMPTY
    // A new read clears the last failure (the last good data stays): an old refusal must not outlive the read that replaces it.
    clearRetry(key)
    set(key, { ...current, failure: null, loading: true })
    try {
      // The version of the items held: main answers without them when they did not change.
      const held = (entries.get(key) ?? current).data
      const result = await window.hub.codeHost.merged(profileId, held?.version ? { ...request, known: held.version } : request, force)
      if (result.ok && result.unchanged && held) set(key, { data: { ...result, items: held.items }, failure: null, loading: false })
      else if (result.ok && result.unchanged) set(key, { data: null, failure: { state: 'error', error: 'The answer came without its pull requests' }, loading: false })
      else if (result.ok) set(key, { data: result, failure: null, loading: false })
      else set(key, { data: (entries.get(key) ?? current).data, failure: { state: result.state, error: result.error, ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}) }, loading: false })
      scheduleRetry(key, profileId, request, retryOf(result))
    } catch (e) {
      set(key, { data: (entries.get(key) ?? current).data, failure: { state: 'error', error: errorText(e) }, loading: false })
    }
  })
}

let changedWatched = false

/** A write succeeded anywhere: every request an open Merged view shows is read again (forced). */
function watchChanges(): void {
  if (changedWatched || typeof window === 'undefined' || !window.hub?.codeHost?.onChanged) return
  changedWatched = true
  window.hub.codeHost.onChanged((_url, profileId) => {
    for (const o of open.values()) if (profileId === null || o.profileId === profileId) void readMerged(o.profileId, o.request, true)
  })
}

/** Marks a request as on screen (for `onChanged`); returns the release. */
export function watchMerged(profileId: string | null, request: MergedRequest): () => void {
  watchChanges()
  const key = mergedKey(profileId, request)
  const o = open.get(key) ?? { profileId, request, users: 0 }
  o.users++
  open.set(key, o)
  return () => {
    o.users--
    if (o.users <= 0 && open.get(key) === o) {
      open.delete(key)
      clearRetry(key)
    }
  }
}

/** The entry of a request as the hook would return it (tests). */
export function peekMerged(profileId: string | null, request: MergedRequest): MergedEntry {
  return entries.get(mergedKey(profileId, request)) ?? EMPTY
}

/** Forgets what was read (tests). */
export function clearMerged(): void {
  for (const t of retries.values()) clearTimeout(t)
  retries.clear()
  entries.clear()
  open.clear()
}

/**
 * One Merged request: read when it changes (`request` null does nothing: the tab was never opened) and again
 * after a write while `shown`. `refresh` forces a new read.
 */
export function useMerged(profileId: string | null, request: MergedRequest | null, shown: boolean): MergedEntry & { refresh: () => Promise<void> } {
  const key = request ? mergedKey(profileId, request) : null
  const entry = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => (key ? (entries.get(key) ?? EMPTY) : EMPTY)
  )
  const since = request?.since
  const until = request?.until
  const mine = request?.mine
  const allProfiles = request?.allProfiles
  useEffect(() => {
    if (since === undefined || until === undefined || mine === undefined) return
    // Read when the view shows this request (main answers from its cache when it can); leaving the tab reads nothing.
    if (!shown) return
    const r: MergedRequest = { since, until, mine, ...(allProfiles ? { allProfiles: true } : {}) }
    void readMerged(profileId, r)
    return watchMerged(profileId, r)
  }, [profileId, since, until, mine, allProfiles, shown])
  const refresh = useCallback(() => (request ? readMerged(profileId, request, true) : Promise.resolve()), [profileId, request])
  return { ...entry, refresh }
}
