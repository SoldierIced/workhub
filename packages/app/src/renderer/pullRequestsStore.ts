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

/** The lists of a profile, refreshed on mount and every `REFRESH_MS` while mounted. */
export function usePullRequestLists(profileId: string | null): { lists: CodeHostLists | null; loading: boolean; refresh: () => Promise<void> } {
  const key = keyOf(profileId)
  const entry = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => entries.get(key) ?? EMPTY
  )
  useEffect(() => {
    void refreshPullRequests(profileId)
    const timer = setInterval(() => void refreshPullRequests(profileId, true), REFRESH_MS)
    return () => clearInterval(timer)
  }, [profileId])
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
