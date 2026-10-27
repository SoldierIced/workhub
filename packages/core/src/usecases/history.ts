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
