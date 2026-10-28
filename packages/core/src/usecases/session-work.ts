/**
 * The pull requests and tickets of a session, for its monitor (Workhub 1's `relatedPRs` and
 * `scopedTicketKeys`): what the session worked on, never guessed from a folder that holds other work.
 * Pure: the caller passes the code host's lists, the repositories the session worked in and what
 * its transcript named.
 */
import type { PullRequest } from '../codehost/domain'
import { canonicalUrl } from '../codehost/urls'
import type { PullRequestItem } from '../codehost/usecases'
import type { RepoChanges } from '../domain/monitor'
import { ticketKeysIn, type TicketKeyProvider } from '../tickets/keys'

/** Long-lived branches say nothing about which PR a session works on. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'staging', 'production', 'release', 'head'])

/** Any upper-case `PROJ-123` key, when the profile has no tracker to narrow it down. */
const ANY_PROJECT_KEY: readonly TicketKeyProvider[] = [{ provider: 'jira' }]

export interface SessionWorkInput {
  /** Pull requests known to the app: the code host's lists and the ones read by URL. */
  items: readonly PullRequestItem[]
  /** PR URLs the session created or named (the monitor's `pullRequests`), oldest first. */
  mentionedPrs?: readonly string[]
  /** The repositories the session worked in, with their current branch. */
  repos?: readonly Pick<RepoChanges, 'name' | 'branch' | 'slug'>[]
  /** Ticket keys named in the conversation (the monitor's `ticketKeys`), oldest first. */
  mentionedTickets?: readonly string[]
  /** The profile's tracker: only its keys count. Any key-like text when empty. */
  providers?: readonly TicketKeyProvider[]
}

export interface SessionWork {
  /** Open PRs of the branches the session works on, then the PRs it named (newest first), then open PRs of its tickets. */
  prs: PullRequestItem[]
  /** Tickets of those PRs, of the branches, then the ones named in the conversation (newest first). */
  ticketKeys: string[]
}

/** Whether a repository read from disk is the one a PR lives in: by its remote's `owner/repo`, else by folder name. */
export function isRepoOf(repo: Pick<RepoChanges, 'name' | 'slug'>, pr: Pick<PullRequest, 'owner' | 'repo'>): boolean {
  const full = `${pr.owner}/${pr.repo}`.toLowerCase()
  if (repo.slug) {
    const slug = repo.slug.toLowerCase()
    return slug === full || slug === pr.repo.toLowerCase()
  }
  return repo.name.toLowerCase() === (pr.repo.split('/').pop() ?? '').toLowerCase()
}

/** The branch is the session's own work, not a release branch every repository shares. */
const ownBranch = (branch: string | null | undefined): branch is string => !!branch && !SHARED_BRANCHES.has(branch.toLowerCase())

export function sessionWork(input: SessionWorkInput): SessionWork {
  const providers = input.providers?.length ? input.providers : ANY_PROJECT_KEY
  const keysIn = (text: string) => ticketKeysIn(text, providers)
  const repos = (input.repos ?? []).filter((r) => ownBranch(r.branch))

  const prs: PullRequestItem[] = []
  const seen = new Set<string>()
  const add = (item: PullRequestItem) => {
    const key = canonicalUrl(item.pr.url)
    if (seen.has(key)) return
    seen.add(key)
    prs.push(item)
  }
  const byUrl = new Map<string, PullRequestItem>()
  for (const item of input.items) if (!byUrl.has(canonicalUrl(item.pr.url))) byUrl.set(canonicalUrl(item.pr.url), item)

  // The open PR of each branch the session works on.
  for (const r of repos) {
    for (const item of byUrl.values()) if (item.pr.state === 'open' && item.pr.branch === r.branch && isRepoOf(r, item.pr)) add(item)
  }
  // The PRs it created or named, the latest first, whatever their state.
  for (const url of [...(input.mentionedPrs ?? [])].reverse()) {
    const item = byUrl.get(canonicalUrl(url))
    if (item) add(item)
  }

  const tickets: string[] = []
  const note = (key: string) => {
    if (!tickets.some((k) => k.toUpperCase() === key.toUpperCase())) tickets.push(key)
  }
  for (const item of prs) for (const key of keysIn(`${item.pr.title}\n${item.pr.branch}`)) note(key)
  for (const r of repos) for (const key of keysIn(r.branch!)) note(key)
  for (const key of [...(input.mentionedTickets ?? [])].reverse()) if (keysIn(key).length > 0) note(key)

  // Open PRs of the session's tickets (Workhub 1 linked a PR by its ticket too).
  if (tickets.length > 0) {
    const wanted = new Set(tickets.map((k) => k.toUpperCase()))
    for (const item of byUrl.values()) {
      if (item.pr.state !== 'open' || seen.has(canonicalUrl(item.pr.url))) continue
      const keys = keysIn(`${item.pr.title}\n${item.pr.branch}`)
      if (keys.some((k) => wanted.has(k.toUpperCase()))) add(item)
    }
  }
  return { prs, ticketKeys: tickets }
}
