// The pull request panel's cache: what was read for a PR stays at hand, and a read only refreshes it.
import { useEffect, useSyncExternalStore } from 'react'
import type { CodeHostCapabilities, DiffFile, PullRequestDetail } from '@workhub/core'
import { RunQueue } from './runQueue'
import { errorText } from './errorText'
import { settlePatch } from './prPatches'

/** Entries kept (the least recently used go first). */
export const DETAIL_CACHE_MAX = 30
/** A read this recent is not repeated when a panel shows the PR again. */
const FRESH_MS = 2_000

export interface DetailData {
  detail: PullRequestDetail
  capabilities: CodeHostCapabilities
  provider: string
  isMine: boolean
}

export interface DiffState {
  files: DiffFile[] | null
  error: string | null
  loading: boolean
  /** The head commit the files were read for. */
  sha?: string
}

export interface Slot {
  data: DetailData | null
  /** When `data` was read. */
  fetchedAt: number | null
  /** A read is running (the data shown, if any, stays usable). */
  refreshing: boolean
  /** Why the last read failed; the last good `data` stays. */
  error: string | null
  diff: DiffState | null
}

export const EMPTY_SLOT: Slot = { data: null, fetchedAt: null, refreshing: false, error: null, diff: null }

const slots = new Map<string, Slot>()
const watchers = new Map<string, number>()
const listeners = new Set<() => void>()
const detailQueue = new RunQueue()
const diffQueue = new RunQueue()

const keyOf = (profileId: string | null, url: string) => `${profileId ?? ''}\n${url}`
const urlOf = (key: string) => key.slice(key.indexOf('\n') + 1)
const profileOf = (key: string) => key.slice(0, key.indexOf('\n')) || null

function emit(): void {
  for (const l of listeners) l()
}

function put(key: string, next: Slot): void {
  slots.delete(key)
  slots.set(key, next)
  // Least recently used first; a PR on screen is never evicted.
  for (const k of [...slots.keys()]) {
    if (slots.size <= DETAIL_CACHE_MAX) break
    if (k !== key && (watchers.get(k) ?? 0) === 0) slots.delete(k)
  }
  emit()
}

function update(key: string, change: (s: Slot) => Slot): void {
  put(key, change(slots.get(key) ?? EMPTY_SLOT))
}

/** The slot of a PR as last stored (a stable object until it changes). */
export const slotOf = (profileId: string | null, url: string): Slot => slots.get(keyOf(profileId, url)) ?? EMPTY_SLOT

/** How many PRs are cached (tests). */
export const cachedCount = (): number => slots.size

/** Reads the diff on its own; a failure is kept with the PR, and files already read stay. */
export function loadDiff(profileId: string | null, url: string, force = false): Promise<void> {
  const key = keyOf(profileId, url)
  return diffQueue.request(key, force, async () => {
    const sha = slots.get(key)?.data?.detail.headSha
    update(key, (s) => ({ ...s, diff: { files: s.diff?.files ?? null, error: null, loading: true, sha: s.diff?.sha } }))
    try {
      const r = await window.hub.codeHost.diff(profileId, url)
      update(key, (s) => ({ ...s, diff: r.ok ? { files: r.files, error: null, loading: false, sha } : { files: s.diff?.files ?? null, error: r.error, loading: false, sha: s.diff?.sha } }))
    } catch (e) {
      update(key, (s) => ({ ...s, diff: { files: s.diff?.files ?? null, error: errorText(e), loading: false, sha: s.diff?.sha } }))
    }
  })
}

/** The diff follows the detail, right after it and without blocking it; read again only when the head moved or it failed. */
function prefetchDiff(profileId: string | null, url: string): void {
  const s = slots.get(keyOf(profileId, url))
  if (!s?.data || s.diff?.loading) return
  if (s.diff && !s.diff.error && s.diff.files && s.diff.sha === s.data.detail.headSha) return
  setTimeout(() => void loadDiff(profileId, url), 0)
}

/**
 * Reads the detail (no diff). The cached copy keeps showing while it runs; a failure keeps the last good copy
 * and records the error. A forced read asked during one in flight runs after it.
 */
export function loadDetail(profileId: string | null, url: string, force = false): Promise<void> {
  const key = keyOf(profileId, url)
  const known = slots.get(key)
  if (!force && known?.data && known.fetchedAt !== null && Date.now() - known.fetchedAt < FRESH_MS) {
    prefetchDiff(profileId, url)
    return Promise.resolve()
  }
  return detailQueue.request(key, force, async () => {
    update(key, (s) => ({ ...s, refreshing: true }))
    try {
      // A forced read (Refresh, after a write) skips what main keeps, so it shows what the host says now.
      const r = await window.hub.codeHost.detail(profileId, url, force)
      if (!r.ok) {
        update(key, (s) => ({ ...s, refreshing: false, error: r.error }))
        return
      }
      settlePatch(url, r.detail.updatedAt)
      update(key, (s) => ({ ...s, data: { detail: r.detail, capabilities: r.capabilities, provider: r.provider, isMine: r.isMine }, fetchedAt: Date.now(), refreshing: false, error: null }))
      prefetchDiff(profileId, url)
    } catch (e) {
      update(key, (s) => ({ ...s, refreshing: false, error: errorText(e) }))
    }
  })
}

/** A write changed this PR (here or in another window): what is cached is old. A PR on screen keeps showing it while it is read again; others are dropped. */
export function invalidateDetail(url: string): void {
  for (const key of [...slots.keys()]) {
    if (urlOf(key) !== url) continue
    if ((watchers.get(key) ?? 0) > 0) void loadDetail(profileOf(key), url, true)
    else slots.delete(key)
  }
  emit()
}

/** Keeps only one profile's entries (the profile switched); a PR on screen stays. */
export function keepDetailsOf(profileId: string | null): void {
  const prefix = `${profileId ?? ''}\n`
  let removed = false
  for (const key of [...slots.keys()]) {
    if (key.startsWith(prefix) || (watchers.get(key) ?? 0) > 0) continue
    slots.delete(key)
    removed = true
  }
  if (removed) emit()
}

/** Empties the cache (tests). */
export function clearDetailCache(): void {
  slots.clear()
  watchers.clear()
  emit()
}

let changedWatched = false

function watchChanges(): void {
  if (changedWatched || typeof window === 'undefined' || !window.hub?.codeHost?.onChanged) return
  changedWatched = true
  window.hub.codeHost.onChanged((url) => invalidateDetail(url))
}

/**
 * The PR's cached copy at once (a seen PR shows immediately), read again in the background; the diff follows.
 * `reload` forces a new read.
 */
export function usePullRequestDetail(profileId: string | null, url: string): Slot & { reload: () => Promise<void> } {
  const key = keyOf(profileId, url)
  const slot = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => slots.get(key) ?? EMPTY_SLOT
  )
  useEffect(() => {
    watchChanges()
    watchers.set(key, (watchers.get(key) ?? 0) + 1)
    void loadDetail(profileId, url)
    return () => {
      const n = (watchers.get(key) ?? 1) - 1
      if (n <= 0) watchers.delete(key)
      else watchers.set(key, n)
    }
  }, [key, profileId, url])
  return { ...slot, reload: () => loadDetail(profileId, url, true) }
}
