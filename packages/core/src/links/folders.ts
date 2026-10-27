import type { PullRequestRef } from '../codehost/domain'

/** A folder a session could start in: a profile folder, or a git worktree of one. */
export interface Checkout {
  path: string
  /** The `origin` remote URL, when the folder is a git checkout that has one. */
  remote?: string
  /** The branch checked out there, when known. */
  branch?: string
}

/** Why a folder was chosen, strongest first. */
export type FolderReason = 'branch' | 'repo' | 'name' | 'first' | 'none'

export interface FolderChoice {
  /** The folder to start the session in; null when the profile has none (the caller falls back to a default). */
  path: string | null
  reason: FolderReason
}

/**
 * `owner/repo` (GitLab: `group/sub/project`) of a git remote URL, lower case; null when the remote
 * is not a host URL. Handles `https://`, `ssh://` (with a port) and scp-style `git@host:owner/repo`.
 */
export function repoSlugOfRemote(remote: string): string | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?[^/:\s]+(?::\d+)?[:/]([^\s]+?)(?:\.git)?\/*$/i.exec(remote.trim())
  const slug = m?.[1]?.replace(/^\/+/, '')
  return slug && slug.includes('/') ? slug.toLowerCase() : null
}

/** The last path segment, whichever separator the OS uses. */
function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/**
 * Where a session about a PR should start: a checkout of the PR's repository (matched by its
 * remote), preferring one already on the PR's branch; else a folder named like the repository;
 * else the profile's first folder. Never changes a checkout: it only picks one.
 */
export function chooseFolderForPullRequest(pr: Pick<PullRequestRef, 'owner' | 'repo'> & { branch?: string }, checkouts: readonly Checkout[]): FolderChoice {
  if (checkouts.length === 0) return { path: null, reason: 'none' }
  const slug = `${pr.owner}/${pr.repo}`.toLowerCase()
  const sameRepo = checkouts.filter((c) => c.remote && repoSlugOfRemote(c.remote) === slug)
  const onBranch = pr.branch ? sameRepo.find((c) => c.branch === pr.branch) : undefined
  if (onBranch) return { path: onBranch.path, reason: 'branch' }
  if (sameRepo[0]) return { path: sameRepo[0].path, reason: 'repo' }
  const named = checkouts.find((c) => baseName(c.path).toLowerCase() === pr.repo.toLowerCase())
  if (named) return { path: named.path, reason: 'name' }
  return { path: checkouts[0]!.path, reason: 'first' }
}
