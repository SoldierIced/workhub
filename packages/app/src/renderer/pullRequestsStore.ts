import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CodeHostLists } from '@shared/codehost-api'
import { errorText } from './lib/errorText'

/** How often the lists refresh while a screen that shows them is open (Workhub 1: every 180 s). */
export const REFRESH_MS = 180_000

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

/** Reads the lists through the main process; the last answer stays visible while the next one loads. */
export async function refreshPullRequests(profileId: string | null, force = false): Promise<void> {
  const key = keyOf(profileId)
  const current = entries.get(key) ?? EMPTY
  if (current.loading) return
  set(key, { ...current, loading: true })
  try {
    set(key, { lists: await window.hub.codeHost.lists(profileId, force), loading: false })
  } catch (e) {
    const message = errorText(e)
    set(key, { lists: { state: 'error', message, mine: [], toReview: [], ...(current.lists ? { mine: current.lists.mine, toReview: current.lists.toReview } : {}) }, loading: false })
  }
}

interface Poller {
  profileId: string | null
  users: number
  timer: ReturnType<typeof setInterval>
  /** A tick came while the window was hidden: the next time it shows, the lists refresh at once. */
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
      void refreshPullRequests(p.profileId, true)
    }
  })
}

/**
 * Keeps a profile's lists fresh while something shows them: every `REFRESH_MS`, skipped while the
 * window is hidden (and caught up with one refresh when it shows again). Returns the release.
 */
export function pollPullRequests(profileId: string | null): () => void {
  const key = keyOf(profileId)
  watchVisibility()
  let poller = pollers.get(key)
  if (!poller) {
    const p: Poller = {
      profileId,
      users: 0,
      missed: false,
      timer: setInterval(() => {
        if (pageHidden()) p.missed = true
        else void refreshPullRequests(profileId, true)
      }, REFRESH_MS)
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
  return { lists: entry.lists, loading: entry.loading, refresh }
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
  return entry.lists
}
