/**
 * Which pull requests a profile shows: the owners (organizations, groups or users) it reads, and
 * the repositories it never shows. Kept per profile, so one login can show only the work
 * organization's pull requests in one profile and only the user's own repositories in another.
 */
import type { PullRequestRef } from './domain'

export interface PullRequestFilterSettings {
  /** Owners whose repositories are read (`acme`, `ana`; a GitLab group path such as `acme/team`). Empty: the connection's scope, else the profile's folders, else everything. */
  owners?: string[]
  /** Repositories never shown: `owner/repo`, or a pattern with `*` (`acme/legacy-*`, `acme/*`). */
  excludeRepos?: string[]
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/
const REPO_PATTERN = /^[A-Za-z0-9.*_-]+(\/[A-Za-z0-9.*_-]+)+$/

/** Whether a string is a valid owner (organization, group path or user). */
export const isPullRequestOwner = (value: string): boolean => OWNER.test(value.trim())
/** Whether a string is a valid repository or repository pattern (`owner/repo`, `*` allowed). */
export const isRepoPattern = (value: string): boolean => REPO_PATTERN.test(value.trim())

/** The settings cleaned: trimmed, without blanks or duplicates (case-insensitive), invalid entries dropped. */
export function normalizePullRequestFilter(settings: PullRequestFilterSettings | undefined): Required<PullRequestFilterSettings> {
  const clean = (list: readonly string[] | undefined, valid: (v: string) => boolean) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of list ?? []) {
      const v = raw.trim().replace(/^@/, '')
      if (!v || !valid(v) || seen.has(v.toLowerCase())) continue
      seen.add(v.toLowerCase())
      out.push(v)
    }
    return out
  }
  return { owners: clean(settings?.owners, isPullRequestOwner), excludeRepos: clean(settings?.excludeRepos, isRepoPattern) }
}

/** Whether the filter narrows anything at all. */
export function hasPullRequestFilter(settings: PullRequestFilterSettings | undefined): boolean {
  const s = normalizePullRequestFilter(settings)
  return s.owners.length > 0 || s.excludeRepos.length > 0
}

function patternRegex(pattern: string): RegExp {
  const body = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${body}$`)
}

/** Whether `owner/repo` matches one of the patterns (case-insensitive; `*` stands for any run of characters inside one path segment). */
export function matchesRepoPattern(fullName: string, patterns: readonly string[]): boolean {
  const name = fullName.toLowerCase()
  return patterns.some((p) => patternRegex(p).test(name))
}

const fullNameOf = (ref: Pick<PullRequestRef, 'owner' | 'repo'>): string => (ref.repo.includes('/') ? ref.repo : `${ref.owner}/${ref.repo}`)

/** Whether a pull request's repository belongs to one of the owners (a GitLab subgroup belongs to its parent group). */
function ownedBy(ref: Pick<PullRequestRef, 'owner' | 'repo'>, owners: readonly string[]): boolean {
  const name = fullNameOf(ref).toLowerCase()
  return owners.some((o) => name.startsWith(`${o.toLowerCase()}/`))
}

/** The pull requests the profile shows: those of its owners (all when none are set), minus the excluded repositories. */
export function filterPullRequests<T extends { pr: Pick<PullRequestRef, 'owner' | 'repo'> }>(items: readonly T[], settings: PullRequestFilterSettings | undefined): T[] {
  const s = normalizePullRequestFilter(settings)
  if (s.owners.length === 0 && s.excludeRepos.length === 0) return [...items]
  return items.filter((i) => (s.owners.length === 0 || ownedBy(i.pr, s.owners)) && !matchesRepoPattern(fullNameOf(i.pr), s.excludeRepos))
}

/**
 * The GitHub search qualifiers for the filter: `user:` per owner (it matches organizations too) and
 * `-repo:` per excluded repository without a wildcard. Patterns with `*` are applied after the
 * search (`filterPullRequests`). Empty when the filter sets no owner, so the caller falls back.
 */
export function githubScopeFromFilter(settings: PullRequestFilterSettings | undefined): string {
  const s = normalizePullRequestFilter(settings)
  if (s.owners.length === 0) return ''
  const owners = s.owners.filter((o) => !o.includes('/')).map((o) => `user:${o}`)
  const excluded = s.excludeRepos.filter((r) => !r.includes('*') && r.split('/').length === 2).map((r) => `-repo:${r}`)
  return [...owners, ...excluded].join(' ')
}
