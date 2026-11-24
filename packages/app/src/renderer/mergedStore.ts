import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { MergedPullRequestsResult, MergedRequest } from '@shared/codehost-api'
import { errorText } from './lib/errorText'
import { RunQueue } from './lib/runQueue'

type MergedOk = Extract<MergedPullRequestsResult, { ok: true }>

/** What the Merged view shows for one request: the last good answer, why the last read failed, and whether one is running. */
export interface MergedEntry {
  data: MergedOk | null
  failure: { state: string; error: string } | null
  loading: boolean
}

const EMPTY: MergedEntry = { data: null, failure: null, loading: false }
const entries = new Map<string, MergedEntry>()
const listeners = new Set<() => void>()
const queue = new RunQueue()
/** Requests an open Merged view is showing, with their profile: they read again after a write. */
const open = new Map<string, { profileId: string | null; request: MergedRequest; users: number }>()

export const mergedKey = (profileId: string | null, r: MergedRequest): string => `${profileId ?? ''}|${r.since}|${r.until}|${r.mine ? 1 : 0}`

function set(key: string, entry: MergedEntry): void {
  entries.set(key, entry)
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
    set(key, { ...current, failure: null, loading: true })
    try {
      const result = await window.hub.codeHost.merged(profileId, request, force)
      if (result.ok) set(key, { data: result, failure: null, loading: false })
      else set(key, { data: (entries.get(key) ?? current).data, failure: { state: result.state, error: result.error }, loading: false })
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
    if (o.users <= 0 && open.get(key) === o) open.delete(key)
  }
}

/** The entry of a request as the hook would return it (tests). */
export function peekMerged(profileId: string | null, request: MergedRequest): MergedEntry {
  return entries.get(mergedKey(profileId, request)) ?? EMPTY
}

/** Forgets what was read (tests). */
export function clearMerged(): void {
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
  useEffect(() => {
    if (since === undefined || until === undefined || mine === undefined) return
    // Read when the view shows this request (main answers from its cache when it can); leaving the tab reads nothing.
    if (!shown) return
    const r = { since, until, mine }
    void readMerged(profileId, r)
    return watchMerged(profileId, r)
  }, [profileId, since, until, mine, shown])
  const refresh = useCallback(() => (request ? readMerged(profileId, request, true) : Promise.resolve()), [profileId, request])
  return { ...entry, refresh }
}
