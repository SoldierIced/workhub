import { owningProfile, type FolderProfile, type SessionState } from '@workhub/core'
import type { WorkspaceFolder } from '@shared/api'
import { folderName } from './home'

/** How many folders "Recent" lists (Workhub 1's limit). */
export const RECENT_FOLDERS = 6
/** How many matches a filter shows at most. */
export const FOLDER_RESULTS = 50

/** A folder row of the sidebar. */
export interface FolderItem {
  path: string
  name: string
  /** One of the profile's own folders (Workhub 1 drew it bolder). */
  root: boolean
  favorite: boolean
  /** Open sessions running in it. */
  open: number
}

export interface FolderSections {
  favorites: FolderItem[]
  recent: FolderItem[]
  /** Every folder of the profile: its folders and the folders inside them. */
  all: FolderItem[]
  /** The folders matching the filter; null while the filter is empty. */
  results: FolderItem[] | null
}

export interface FolderSessionInfo {
  cwd: string
  startedAt: number
  state: SessionState
  profileId: string | null
}

export interface FolderInput {
  workspaces: readonly WorkspaceFolder[]
  favorites: readonly string[]
  sessions: readonly FolderSessionInfo[]
  /** The active profile: Recent lists the folders of its sessions (and of sessions without one). */
  profileId: string | null
  query: string
}

const norm = (path: string) => path.replace(/[\\/]+$/, '') || path

/**
 * Workhub 1's folder sections: Favorites (starred, in the order they were starred), Recent (folders
 * the profile's sessions ran in, newest first, favorites left out) and All folders. A non-empty
 * filter replaces them with the folders whose name or path contains it, names that start with it first.
 */
export function folderSections({ workspaces, favorites, sessions, profileId, query }: FolderInput): FolderSections {
  const starred = new Set(favorites.map(norm))
  const known = new Map(workspaces.map((w) => [norm(w.path), w]))
  const open = new Map<string, number>()
  for (const s of sessions) if (s.state !== 'stopped' && s.state !== 'error') open.set(norm(s.cwd), (open.get(norm(s.cwd)) ?? 0) + 1)
  const item = (path: string): FolderItem => {
    const key = norm(path)
    const w = known.get(key)
    return { path: key, name: w?.name ?? folderName(key), root: w?.root ?? false, favorite: starred.has(key), open: open.get(key) ?? 0 }
  }

  const favoriteItems = [...starred].map(item)
  const recentPaths: string[] = []
  for (const s of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    if (s.profileId && profileId && s.profileId !== profileId) continue
    const key = norm(s.cwd)
    if (!key || starred.has(key) || recentPaths.includes(key)) continue
    recentPaths.push(key)
    if (recentPaths.length === RECENT_FOLDERS) break
  }
  const all = workspaces.map((w) => item(w.path))

  const q = query.trim().toLowerCase()
  if (!q) return { favorites: favoriteItems, recent: recentPaths.map(item), all, results: null }
  const pool = new Map<string, FolderItem>()
  for (const f of [...favoriteItems, ...recentPaths.map(item), ...all]) if (!pool.has(f.path)) pool.set(f.path, f)
  const matches = [...pool.values()].filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
  const rank = (f: FolderItem) => (f.name.toLowerCase().startsWith(q) ? 0 : f.name.toLowerCase().includes(q) ? 1 : 2)
  const results = matches
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, FOLDER_RESULTS)
  return { favorites: favoriteItems, recent: recentPaths.map(item), all, results }
}

/** One of the profile's folders with the folders (repositories) inside it: a foldable section of the sidebar. */
export interface FolderGroup {
  root: FolderItem
  children: FolderItem[]
}

/** What the folders panel lists while the filter is set: the matches by profile folder, then the others. */
export interface FolderMatches {
  /** Folders with a match (the folder itself or one inside it), each with only its matching folders. */
  groups: FolderGroup[]
  /** Matches outside the profile's folders (a favorite or recent folder elsewhere). */
  other: FolderItem[]
}

/**
 * The profile's folders as sections: each folder of the profile (`root`) with the folders listed
 * after it until the next one (the order `profileFolders` gives). A folder listed before any
 * profile folder gets a section of its own.
 */
export function folderGroups(all: readonly FolderItem[]): FolderGroup[] {
  const groups: FolderGroup[] = []
  for (const f of all) {
    const last = groups[groups.length - 1]
    if (f.root || !last) groups.push({ root: f, children: [] })
    else last.children.push(f)
  }
  return groups
}

/**
 * The filter's matches (`results`, in their ranked order) by profile folder: a section for every
 * folder that matches or holds a match, with the matching folders inside it, and the matches that
 * belong to none of them.
 */
export function groupMatches(all: readonly FolderItem[], results: readonly FolderItem[]): FolderMatches {
  const groups = folderGroups(all)
  const owner = new Map<string, FolderGroup>()
  for (const g of groups) {
    owner.set(g.root.path, g)
    for (const c of g.children) owner.set(c.path, g)
  }
  const found = new Map<FolderGroup, FolderGroup>()
  const other: FolderItem[] = []
  for (const r of results) {
    const g = owner.get(r.path)
    if (!g) {
      other.push(r)
      continue
    }
    let match = found.get(g)
    if (!match) {
      match = { root: g.root, children: [] }
      found.set(g, match)
    }
    if (r.path !== g.root.path) match.children.push(r)
  }
  // Sections keep the profile's order; the folders inside them keep the ranking.
  return { groups: groups.flatMap((g) => found.get(g) ?? []), other }
}

/** Whether a folder's section shows its folders: always while filtering (its matches), else when the user unfolded it. */
export function isFolderOpen(path: string, expanded: readonly string[], filtering: boolean): boolean {
  return filtering || expanded.some((f) => norm(f) === norm(path))
}

/** Unfolds a folder's section, or folds it again (the `expandedFolders` preference). */
export function toggleExpanded(expanded: readonly string[], path: string): string[] {
  return toggleFavorite(expanded, path)
}

/** Stars a folder, or takes its star away. */
export function toggleFavorite(favorites: readonly string[], path: string): string[] {
  const key = norm(path)
  return favorites.some((f) => norm(f) === key) ? favorites.filter((f) => norm(f) !== key) : [...favorites, key]
}

/** The profile a new session in `cwd` starts in: the one owning the folder (Workhub 1), else the active one. */
export function newSessionProfile(cwd: string, activeProfileId: string | null, profiles: readonly FolderProfile[], home?: string): string | null {
  return owningProfile(cwd, profiles, home)?.id ?? activeProfileId
}
