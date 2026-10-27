import { historyId } from '../links/history'
import type { HistoryEntry } from '../ports'

export interface HistoryGroup<T extends HistoryEntry = HistoryEntry> {
  /** The folder the sessions ran in; empty when the agent did not record one. */
  folder: string
  entries: T[]
  /** Newest `lastModified` of the group, for ordering. */
  lastModified: number
}

/** Lowercased words of a search box; an entry matches when every word is in one of its fields. */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesHistory(entry: HistoryEntry, query: string): boolean {
  const words = terms(query)
  if (!words.length) return true
  const haystack = [entry.title, entry.firstPrompt, entry.cwd, entry.gitBranch, entry.agentSessionId]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/**
 * The session history screen's model: entries that match the search, one group per folder,
 * newest group first and newest session first inside each. The same session listed by two
 * accounts (a copied transcript) is kept once, the most recent copy.
 */
export function groupHistory<T extends HistoryEntry>(entries: T[], query = ''): HistoryGroup<T>[] {
  const unique = new Map<string, T>()
  for (const e of entries) {
    const key = `${e.agentId}\u0000${e.agentSessionId}`
    const prev = unique.get(key)
    if (!prev || e.lastModified > prev.lastModified) unique.set(key, e)
  }
  const groups = new Map<string, T[]>()
  for (const e of unique.values()) {
    if (!matchesHistory(e, query)) continue
    const folder = e.cwd ?? ''
    const list = groups.get(folder)
    if (list) list.push(e)
    else groups.set(folder, [e])
  }
  return [...groups.entries()]
    .map(([folder, list]) => {
      list.sort((a, b) => b.lastModified - a.lastModified)
      return { folder, entries: list, lastModified: list[0]?.lastModified ?? 0 }
    })
    .sort((a, b) => b.lastModified - a.lastModified)
}

/** Folders whose sessions are throwaway runs (scratch checkouts, tests), not work to come back to. */
const THROWAWAY_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

/** Whether a session ran in a temporary folder (Workhub 1 leaves these out of the history). */
export function isThrowawayFolder(cwd: string | undefined): boolean {
  if (!cwd) return false
  const folder = cwd.endsWith('/') ? cwd : `${cwd}/`
  return THROWAWAY_PREFIXES.some((p) => folder.startsWith(p))
}

/** `folder` is `parent` or inside it (plain path prefix on whole segments). */
function inside(folder: string, parent: string): boolean {
  const p = parent.replace(/[\\/]+$/, '')
  return folder === p || folder.startsWith(`${p}/`) || folder.startsWith(`${p}\\`)
}

/**
 * Whether a past session belongs to a profile: it ran in one of the profile's folders, or with one
 * of its agent accounts. A profile with neither folders nor accounts owns every session.
 */
export function historyInProfile(entry: Pick<HistoryEntry, 'cwd'> & { accountId?: HistoryEntry['accountId'] }, profile: { folders?: readonly string[]; accountIds: readonly string[] }): boolean {
  const folders = profile.folders ?? []
  if (!folders.length && !profile.accountIds.length) return true
  if (entry.accountId && profile.accountIds.includes(entry.accountId)) return true
  return Boolean(entry.cwd && folders.some((f) => inside(entry.cwd!, f)))
}

/** The history a folder's "Resume session…" sheet offers: sessions run in exactly that folder, newest first, not open now. */
export function sessionsOfFolder<T extends HistoryEntry>(entries: readonly T[], folder: string, open: ReadonlySet<string>, query = ''): T[] {
  const target = folder.replace(/[\\/]+$/, '')
  return groupHistory(entries.filter((e) => (e.cwd ?? '').replace(/[\\/]+$/, '') === target && !open.has(historyId(e))), query).flatMap((g) => g.entries)
}
