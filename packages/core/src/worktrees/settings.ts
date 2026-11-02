/**
 * Worktree per session: a new session on a git repository can run in its own `git worktree` and
 * branch instead of the repository folder, so several agents on one repository do not step on each
 * other. Off by default. The profile sets the default, a folder can override it, and the New
 * session dialog decides for each session.
 */
import { isInsideFolder, normalizeFolder } from '../domain/profile-folders'
import type { Profile } from '../domain/profile'

export const WORKTREE_CLOSE_MODES = ['ask', 'keep'] as const
export type WorktreeCloseMode = (typeof WORKTREE_CLOSE_MODES)[number]

export interface WorktreeSettings {
  /** New sessions on a repository start in a worktree by default. */
  enabled: boolean
  /**
   * Folder the worktrees go in. `${folder}` is the profile folder holding the repository (else the
   * repository's parent folder), `${repo}` the repository root. Empty: `${folder}/_worktrees`.
   */
  location: string
  /** Put before every new branch name, e.g. `feat/`. */
  branchPrefix: string
  /** What new branches start from; empty: the repository's default branch. */
  baseRef: string
  /** On closing a session in a worktree: `ask` offers to remove it, `keep` leaves it without asking. */
  onClose: WorktreeCloseMode
}

export const DEFAULT_WORKTREE_LOCATION = '${folder}/_worktrees'

/** The folder name worktrees are kept under by default; folder lists hide it. */
export const WORKTREES_FOLDER_NAME = '_worktrees'

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = { enabled: false, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' }

/** The profile's worktree settings, defaults filled in. */
export function worktreeSettings(profile: Pick<Profile, 'worktrees'> | null | undefined): WorktreeSettings {
  return { ...DEFAULT_WORKTREE_SETTINGS, ...(profile?.worktrees ?? {}) }
}

/**
 * Whether a new session in `cwd` uses a worktree unless the user says otherwise: the deepest
 * folder option holding `cwd` that sets `worktrees` wins, else the profile setting.
 */
export function worktreeDefault(profile: Pick<Profile, 'worktrees' | 'folderOptions'> | null | undefined, cwd: string, home?: string): boolean {
  const target = normalizeFolder(cwd, home)
  let best: { depth: number; value: boolean } | undefined
  for (const [key, options] of Object.entries(profile?.folderOptions ?? {})) {
    if (options.worktrees === undefined) continue
    const folder = normalizeFolder(key, home)
    if (isInsideFolder(target, folder) && (!best || folder.length > best.depth)) best = { depth: folder.length, value: options.worktrees }
  }
  return best ? best.value : worktreeSettings(profile).enabled
}

/**
 * A branch name git accepts out of what the user typed: spaces become `-`, characters git refuses
 * are dropped, and no part starts with `.` or ends with `.lock`. Empty when nothing usable is left.
 */
export function cleanBranchName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\\\x00-\x1f\x7f]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/@\{/g, '')
    .replace(/\/+/g, '/')
    .split('/')
    .map((part) => part.replace(/^\.+/, '').replace(/\.lock$/i, '').replace(/\.+$/, ''))
    .filter(Boolean)
    .join('/')
}

/** The branch of a new worktree: the prefix plus the typed name, else `session-<short id>`. */
export function worktreeBranch(settings: Pick<WorktreeSettings, 'branchPrefix'>, typed: string | undefined, shortId: string): string {
  const name = cleanBranchName(typed ?? '') || `session-${shortId}`
  const prefix = settings.branchPrefix.trim()
  if (!prefix || name.startsWith(prefix)) return name
  return cleanBranchName(prefix + name) || name
}

/** The folder name of a worktree: `<repo name>-<branch>`, slashes turned into `-`. */
export function worktreeFolderName(repoRoot: string, branch: string): string {
  const repo = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'repo'
  return `${repo}-${branch.replace(/[\\/]+/g, '-')}`
}

/** The worktrees folder for a repository: `location` with `${folder}`, `${repo}` and `~` expanded. */
export function worktreesLocation(settings: Pick<WorktreeSettings, 'location'>, vars: { folder: string; repo: string }, home?: string): string {
  const template = settings.location.trim() || DEFAULT_WORKTREE_LOCATION
  const filled = template.replaceAll('${folder}', vars.folder).replaceAll('${repo}', vars.repo)
  return normalizeFolder(filled, home)
}
