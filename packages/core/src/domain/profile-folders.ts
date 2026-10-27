/**
 * Which profile a folder belongs to, and which projects a profile's folders expand into. Workhub 1
 * decided both the same way everywhere (sidebar, history, token spend, session environment), so
 * every caller goes through these functions. Pure: the caller reads the disk.
 */
import type { FolderOptions, Profile } from './profile'

/** The profile fields that decide folders and ownership. */
export type FolderProfile = Pick<Profile, 'id' | 'folders' | 'folderOptions' | 'ownsOutside'>

/** A folder found inside a profile folder. */
export interface FolderChild {
  name: string
  /** It has a `.git` entry. Only read when the folder lists only git repositories. */
  isGitRepo?: boolean
}

/** A folder a profile works in: one of its own folders (`root`) or a folder inside one. */
export interface ProfileProject {
  /** Absolute path, home expanded, no trailing separator. */
  path: string
  name: string
  root: boolean
  /** The profile folder (as written in the profile) it comes from. */
  folder: string
}

/** How many child folders one profile folder lists at most (a huge folder must not flood the sidebar). */
export const PROJECT_CHILDREN_CAP = 500

/** The separator a path uses: `\\` for a Windows path without forward slashes, else `/`. */
const separatorOf = (path: string): string => (path.includes('\\') && !path.includes('/') ? '\\' : '/')

/** `~` and `~/…` under `home`; anything else as written. */
export function expandHomePath(path: string, home?: string): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  if (path === '~') return h
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${h}${separatorOf(h)}${path.slice(2)}`
  return path
}

/** Home expanded and the trailing separators dropped. */
export function normalizeFolder(path: string, home?: string): string {
  const expanded = expandHomePath(path.trim(), home)
  return expanded.replace(/[\\/]+$/, '') || expanded
}

/** `path` is `folder` or inside it, on whole path segments. */
export function isInsideFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`) || path.startsWith(`${folder}\\`)
}

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** The switches of one of the profile's folders (looked up as written, then by normalized path). */
export function folderOptionsOf(profile: Pick<Profile, 'folderOptions'>, folder: string, home?: string): FolderOptions {
  const options = profile.folderOptions ?? {}
  const direct = options[folder]
  if (direct) return direct
  const wanted = normalizeFolder(folder, home)
  for (const [key, value] of Object.entries(options)) if (normalizeFolder(key, home) === wanted) return value
  return {}
}

/** The profile's folders, normalized, blanks left out. */
export function profileFolderPaths(profile: Pick<Profile, 'folders'>, home?: string): { folder: string; path: string }[] {
  return (profile.folders ?? []).filter((f) => f.trim()).map((folder) => ({ folder, path: normalizeFolder(folder, home) }))
}

/** The deepest of the profile's folders that holds `path`, or undefined. */
export function containingFolder(path: string, profile: Pick<Profile, 'folders'>, home?: string): { folder: string; path: string } | undefined {
  const target = normalizeFolder(path, home)
  let best: { folder: string; path: string } | undefined
  for (const f of profileFolderPaths(profile, home)) {
    if (isInsideFolder(target, f.path) && (!best || f.path.length > best.path.length)) best = f
  }
  return best
}

/**
 * The profile that owns work in `path`, as Workhub 1 decided it: the profile whose folder holds it
 * (the deepest folder wins when several do, the first profile on a tie), else the profile that owns
 * everything outside every profile's folders. Undefined when neither exists or the path is empty.
 */
export function owningProfile<P extends FolderProfile>(path: string | null | undefined, profiles: readonly P[], home?: string): P | undefined {
  if (!path?.trim()) return undefined
  let best: { profile: P; depth: number } | undefined
  for (const profile of profiles) {
    const f = containingFolder(path, profile, home)
    if (f && (!best || f.path.length > best.depth)) best = { profile, depth: f.path.length }
  }
  return best?.profile ?? profiles.find((p) => p.ownsOutside)
}

/** Whether work in `path` belongs to `profileId` (see `owningProfile`). */
export function ownsFolder(profileId: string, path: string | null | undefined, profiles: readonly FolderProfile[], home?: string): boolean {
  return owningProfile(path, profiles, home)?.id === profileId
}

/** The profile folder `${PROFILE_ROOT}` names for a session in `path`: the deepest one holding it, else the first one. */
export function profileRootFor(path: string, profile: Pick<Profile, 'folders'>, home?: string): string | undefined {
  return containingFolder(path, profile, home)?.path ?? profileFolderPaths(profile, home)[0]?.path
}

/** The child folders a profile folder lists: visible ones, only git repositories when the folder asks for that, sorted by name. */
export function visibleChildren(children: readonly FolderChild[], options: FolderOptions): string[] {
  return children
    .filter((c) => !c.name.startsWith('.') && (!options.onlyGitRepos || c.isGitRepo === true))
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, PROJECT_CHILDREN_CAP)
}

/**
 * The folders a profile works in, as Workhub 1's sidebar listed them: each profile folder, then the
 * folders inside it (only git repositories when "Only git repos" is on). `listing` holds the child
 * folders of each profile folder by normalized path; null (or missing) means it cannot be read and
 * the folder is left out. A folder listed twice appears once.
 */
export function expandProfileFolders(profile: Pick<Profile, 'folders' | 'folderOptions'>, listing: Readonly<Record<string, readonly FolderChild[] | null | undefined>>, home?: string): ProfileProject[] {
  const out: ProfileProject[] = []
  const seen = new Set<string>()
  const add = (p: ProfileProject) => {
    if (seen.has(p.path)) return
    seen.add(p.path)
    out.push(p)
  }
  for (const { folder, path } of profileFolderPaths(profile, home)) {
    const children = listing[path]
    if (!children) continue
    add({ path, name: lastSegment(path) || path, root: true, folder })
    for (const name of visibleChildren(children, folderOptionsOf(profile, folder, home))) add({ path: `${path}${separatorOf(path)}${name}`, name, root: false, folder })
  }
  return out
}

/**
 * The projects each profile folder is split into ("Each subfolder is its own project"), by
 * normalized folder path: its listed child folders when the switch is on, none otherwise (the
 * folder is one project).
 */
export function projectChildren(profile: Pick<Profile, 'folders' | 'folderOptions'>, listing: Readonly<Record<string, readonly FolderChild[] | null | undefined>>, home?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const { folder, path } of profileFolderPaths(profile, home)) {
    const options = folderOptionsOf(profile, folder, home)
    out[path] = options.subfoldersAreProjects ? visibleChildren(listing[path] ?? [], options) : []
  }
  return out
}

/** Whether reading a profile folder needs each child's `.git` checked. */
export const needsGitCheck = (profile: Pick<Profile, 'folderOptions'>, folder: string, home?: string): boolean => folderOptionsOf(profile, folder, home).onlyGitRepos === true
