import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { profileRefreshMs } from '@workhub/core'
import type { CodeHostLists } from '@shared/codehost-api'
import { currentConfig } from './configStore'
import { errorText } from './lib/errorText'
import { patchesVersion, patchFor, patchLists, settlePatch, subscribePatches } from './lib/prPatches'
import { RunQueue } from './lib/runQueue'

/** How often a poller checks whether its profile is due; the refresh itself follows the code host connection's interval. */
export const POLL_TICK_MS = 15_000

/** Milliseconds between refreshes of a profile's lists: its code host connection's interval (3 minutes by default, as Workhub 1). */
export function refreshIntervalMs(profileId: string | null): number {
  const snap = currentConfig()
  return snap ? profileRefreshMs(snap.config, profileId, 'codeHost') : profileRefreshMs({ profiles: [], connections: [] }, null, 'codeHost')
}

interface Entry {
  lists: CodeHostLists | null
  loading: boolean
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const EMPTY: Entry = { lists: null, loading: false }
const keyOf = (profileId: string | null) => profileId ?? ''

function set(key: string, entry: Entry): void {
  entries.set(key, entry)
  for (const l of listeners) l()
}

const queue = new RunQueue()

/** Settles the local patches with what a read reported: a PR changed after its action holds the truth. */
function settleFrom(lists: CodeHostLists): void {
  for (const item of [...lists.mine, ...lists.toReview]) settlePatch(item.pr.url, item.pr.updatedAt)
}

/**
 * Reads the lists through the main process; the last answer stays visible while the next one loads. A forced
 * refresh asked while a read is in flight runs right after it (never dropped), and resolves with that newer read.
 */
export function refreshPullRequests(profileId: string | null, force = false): Promise<void> {
  const key = keyOf(profileId)
  return queue.request(key, force, async () => {
    const current = entries.get(key) ?? EMPTY
    set(key, { ...current, loading: true })
    try {
      const lists = await window.hub.codeHost.lists(profileId, force)
      settleFrom(lists)
      set(key, { lists, loading: false })
    } catch (e) {
      const message = errorText(e)
      const last = entries.get(key)?.lists ?? current.lists
      set(key, { lists: { state: 'error', message, mine: [], toReview: [], ...(last ? { mine: last.mine, toReview: last.toReview } : {}) }, loading: false })
    }
  })
}

interface Poller {
  profileId: string | null
  users: number
  timer: ReturnType<typeof setInterval>
  /** When this poller last refreshed (or started, right after the screen's own first read). */
  lastAt: number
  /** A refresh came due while the window was hidden: the next time it shows, the lists refresh at once. */
  missed: boolean
}

/** One forced refresh timer per profile, shared by every screen that shows its lists. */
const pollers = new Map<string, Poller>()
let visibilityWatched = false

const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden

function watchVisibility(): void {
  if (visibilityWatched || typeof document === 'undefined') return
  visibilityWatched = true
  document.addEventListener('visibilitychange', () => {
    if (pageHidden()) return
    for (const p of pollers.values()) {
      if (!p.missed) continue
      p.missed = false
      p.lastAt = Date.now()
      void refreshPullRequests(p.profileId, true)
    }
  })
}

let changedWatched = false

/** A write succeeded in any window (the PR window, the main window): every polled profile reads its lists again. */
function watchChanges(): void {
  if (changedWatched || typeof window === 'undefined' || !window.hub?.codeHost?.onChanged) return
  changedWatched = true
  window.hub.codeHost.onChanged((_url, profileId) => {
    for (const p of pollers.values()) if (profileId === null || p.profileId === profileId) void refreshPullRequests(p.profileId, true)
  })
}

/**
 * Keeps a profile's lists fresh while something shows them: at its code host connection's interval, skipped while the
 * window is hidden (and caught up with one refresh when it shows again). Returns the release.
 */
export function pollPullRequests(profileId: string | null): () => void {
  const key = keyOf(profileId)
  watchVisibility()
  watchChanges()
  let poller = pollers.get(key)
  if (!poller) {
    const p: Poller = {
      profileId,
      users: 0,
      missed: false,
      lastAt: Date.now(),
      timer: setInterval(() => {
        if (Date.now() - p.lastAt < refreshIntervalMs(profileId)) return
        if (pageHidden()) {
          p.missed = true
          return
        }
        p.lastAt = Date.now()
        void refreshPullRequests(profileId, true)
      }, POLL_TICK_MS)
    }
    poller = p
    pollers.set(key, p)
  }
  const mine = poller
  mine.users++
  let released = false
  return () => {
    if (released) return
    released = true
    mine.users--
    if (mine.users > 0) return
    clearInterval(mine.timer)
    if (pollers.get(key) === mine) pollers.delete(key)
  }
}

/** How many profiles have a refresh timer running (tests). */
export const activePollers = (): number => pollers.size

/**
 * The lists of a profile, read on mount and refreshed by the profile's shared timer while `active`
 * (a screen kept mounted but hidden passes false and stops polling).
 */
export function usePullRequestLists(profileId: string | null, active = true): { lists: CodeHostLists | null; loading: boolean; refresh: () => Promise<void> } {
  const key = keyOf(profileId)
  const entry = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => entries.get(key) ?? EMPTY
  )
  useEffect(() => {
    if (!active) return
    void refreshPullRequests(profileId)
    return pollPullRequests(profileId)
  }, [profileId, active])
  const refresh = useCallback(() => refreshPullRequests(profileId, true), [profileId])
  return { lists: usePatched(entry.lists), loading: entry.loading, refresh }
}

/**
 * The lists of a profile as last read, without a refresh timer of its own: reads them once when
 * nothing is loaded yet (the session monitor, mounted once per open session, must not poll the host).
 */
export function useCachedPullRequestLists(profileId: string | null): CodeHostLists | null {
  const key = keyOf(profileId)
  const entry = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => entries.get(key) ?? EMPTY
  )
  useEffect(() => {
    if (!entries.has(key)) void refreshPullRequests(profileId)
  }, [key, profileId])
  return usePatched(entry.lists)
}

/** The lists with what the user just did applied (approved: out of "To review"; merged: merged) until a refresh shows the host caught up. */
function usePatched(lists: CodeHostLists | null): CodeHostLists | null {
  const version = useSyncExternalStore(subscribePatches, patchesVersion)
  return useMemo(() => (lists ? patchLists(lists, (url) => patchFor(url)) : null), [lists, version])
}
