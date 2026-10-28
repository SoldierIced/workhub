/**
 * The pull requests and tickets of a session, for its monitor: only what the session itself is
 * related to, never what a folder, a repository or a tool's output merely holds. A PR or ticket
 * counts when the session acted on it (created, changed, commented, reviewed, merged, viewed it,
 * or pushed its branch), when the user named it, when its key is in a branch the session created,
 * checked out, committed on or pushed, or when the agent's final reply named it. Pure: the caller
 * passes the code host's lists, the repositories the session worked in and what its transcript says.
 */
import type { PullRequest } from '../codehost/domain'
import { canonicalUrl } from '../codehost/urls'
import type { PullRequestItem } from '../codehost/usecases'
import type { RepoChanges, SessionBranch, SessionLinkSource, SessionPullRequestLink } from '../domain/monitor'
import { projectOfKey, ticketKeysIn, type TicketKeyProvider } from '../tickets/keys'

/** Long-lived branches say nothing about which PR a session works on. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'staging', 'production', 'release', 'head'])

/** Any upper-case `PROJ-123` key, when the profile has no tracker to narrow it down. */
const ANY_PROJECT_KEY: readonly TicketKeyProvider[] = [{ provider: 'jira' }]

type Repo = Pick<RepoChanges, 'name' | 'branch' | 'slug'> & Partial<Pick<RepoChanges, 'root'>>

export interface SessionWorkInput {
  /** Pull requests known to the app: the code host's lists and the ones read by URL. */
  items: readonly PullRequestItem[]
  /** The PRs the session acted on or the user or the agent's replies named (the monitor's `pullRequestLinks`). */
  links?: readonly SessionPullRequestLink[]
  /** The repositories the session worked in, with their current branch. */
  repos?: readonly Repo[]
  /** Ticket keys the user typed (the monitor's `ticketKeys`), oldest first. */
  mentionedTickets?: readonly string[]
  /** Ticket keys the agent's final replies named (the monitor's `replyTicketKeys`), oldest first. */
  replyTickets?: readonly string[]
  /** Tickets the session created or changed in the tracker (the monitor's `linkedTicketKeys`), strongest first. */
  linkedTickets?: readonly string[]
  /** Branches the session created, checked out, committed on or pushed (the monitor's `branches`). */
  branches?: readonly SessionBranch[]
  /** Names the user gave the session: typed by them, like a prompt. */
  titles?: readonly (string | null | undefined)[]
  /** The profile's tracker: only its keys count. Any key-like text when empty. */
  providers?: readonly TicketKeyProvider[]
}

export interface SessionWork {
  /** The PRs the session acted on (and the ones of the branches it pushed), then the ones the user named, then the ones its replies named; latest first in each. */
  prs: PullRequestItem[]
  /**
   * The tickets the session created or changed, as they came; then the ones the user named (latest
   * first), then the ones of its branches and its replies; the profile's main project first within each.
   */
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

/** The repository a folder is in: the deepest one whose root holds it. */
function repoOfFolder(repos: readonly Repo[], folder: string | undefined): Repo | undefined {
  if (!folder) return undefined
  return repos.filter((r) => r.root && (folder === r.root || folder.startsWith(`${r.root}/`))).sort((a, b) => b.root!.length - a.root!.length)[0]
}

/** Whether a PR lives in the repository a link names: `owner/repo`, or just `repo` as a prompt writes it. */
function inRepo(pr: Pick<PullRequest, 'owner' | 'repo'>, repo: string): boolean {
  const name = repo.toLowerCase()
  return name.includes('/') ? `${pr.owner}/${pr.repo}`.toLowerCase() === name : pr.repo.toLowerCase() === name || (pr.repo.split('/').pop() ?? '').toLowerCase() === name
}

/**
 * The URL of a PR a link names by number: the known PR of its repository (the folder's one for a
 * command, any repository the session worked in for a prompt, when only one has it), else, with
 * the repository's `owner/repo`, its GitHub URL. Undefined when it cannot be placed.
 */
function linkUrl(link: SessionPullRequestLink, items: readonly PullRequestItem[], repos: readonly Repo[]): string | undefined {
  if (link.url) return canonicalUrl(link.url)
  if (link.number === undefined) return undefined
  const repo = link.repo ? undefined : repoOfFolder(repos, link.folder)
  if (link.folder && !repo) return undefined
  const candidates = items.filter((i) => {
    if (i.pr.number !== link.number) return false
    if (link.repo) return inRepo(i.pr, link.repo)
    if (repo) return isRepoOf(repo, i.pr)
    return repos.some((r) => isRepoOf(r, i.pr))
  })
  const urls = [...new Set(candidates.map((i) => canonicalUrl(i.pr.url)))]
  if (urls.length === 1) return urls[0]
  if (urls.length > 1) return undefined
  const slug = link.repo?.includes('/') ? link.repo : repo?.slug
  return slug ? canonicalUrl(`https://github.com/${slug}/pull/${link.number}`) : undefined
}

/** A branch by name; one named by its folder is that repository's current branch. */
function branchOf(branch: SessionBranch, repos: readonly Repo[]): { name: string; repo?: Repo } | undefined {
  const repo = repoOfFolder(repos, branch.folder)
  const name = branch.name ?? repo?.branch ?? undefined
  return name ? { name, ...(repo ? { repo } : {}) } : undefined
}

/**
 * The URLs of the PRs the session's links name, by source, strongest first and latest first within
 * each (to read the ones the code host's lists do not hold).
 */
export function sessionPullRequestUrls(links: readonly SessionPullRequestLink[] | undefined, items: readonly PullRequestItem[], repos: readonly Repo[] = []): { url: string; source: SessionLinkSource }[] {
  const out: { url: string; source: SessionLinkSource }[] = []
  for (const source of ['acted', 'user', 'reply'] as const) {
    for (const link of [...(links ?? [])].reverse()) {
      if (link.source !== source) continue
      const url = linkUrl(link, items, repos)
      if (url && !out.some((o) => o.url === url)) out.push({ url, source })
    }
  }
  return out
}

export function sessionWork(input: SessionWorkInput): SessionWork {
  const providers = input.providers?.length ? input.providers : ANY_PROJECT_KEY
  const keysIn = (text: string) => ticketKeysIn(text, providers)
  const repos = input.repos ?? []

  const prs: PullRequestItem[] = []
  const seen = new Set<string>()
  const add = (item: PullRequestItem | undefined) => {
    if (!item) return
    const key = canonicalUrl(item.pr.url)
    if (seen.has(key)) return
    seen.add(key)
    prs.push(item)
  }
  const byUrl = new Map<string, PullRequestItem>()
  for (const item of input.items) if (!byUrl.has(canonicalUrl(item.pr.url))) byUrl.set(canonicalUrl(item.pr.url), item)

  const urls = sessionPullRequestUrls(input.links, input.items, repos)
  const branches = (input.branches ?? []).map((b) => ({ ...b, resolved: branchOf(b, repos) }))
  // The PRs it acted on, then the PR of each branch it pushed (the latest first): acting on them too.
  for (const { url } of urls.filter((u) => u.source === 'acted')) add(byUrl.get(url))
  for (const b of [...branches].reverse()) {
    const name = b.resolved?.name
    if (!b.pushed || !ownBranch(name)) continue
    // Its repository: the one the push went to, else its folder's, else any the session worked in.
    const repo = b.resolved?.repo
    const ofIt = (pr: PullRequest) => (b.repo ? inRepo(pr, b.repo) : repo ? isRepoOf(repo, pr) : repos.length === 0 || repos.some((r) => isRepoOf(r, pr)))
    for (const item of byUrl.values()) if (item.pr.branch === name && ofIt(item.pr)) add(item)
  }
  for (const { url } of urls.filter((u) => u.source !== 'acted')) add(byUrl.get(url))

  const tickets: string[] = []
  const note = (key: string) => {
    if (!tickets.some((k) => k.toUpperCase() === key.toUpperCase())) tickets.push(key)
  }
  for (const key of input.linkedTickets ?? []) if (keysIn(key).length > 0) note(key)
  const userFrom = tickets.length
  for (const title of input.titles ?? []) if (title) for (const key of keysIn(title)) note(key)
  for (const key of [...(input.mentionedTickets ?? [])].reverse()) if (keysIn(key).length > 0) note(key)
  const restFrom = tickets.length
  for (const b of [...branches].reverse()) if (ownBranch(b.resolved?.name)) for (const key of keysIn(b.resolved!.name)) note(key)
  for (const key of [...(input.replyTickets ?? [])].reverse()) if (keysIn(key).length > 0) note(key)
  // Within each group, a key of another team's project (a ticket the work only relates to) must not come before the profile's own.
  const ranked = [...tickets.slice(0, userFrom), ...byProject(tickets.slice(userFrom, restFrom), providers), ...byProject(tickets.slice(restFrom), providers)]
  return { prs, ticketKeys: ranked }
}

/** Stable sort by the position of each key's project in the tracker's project keys; keys of unlisted projects keep their place after them. */
function byProject(keys: readonly string[], providers: readonly TicketKeyProvider[]): string[] {
  const order = providers.flatMap((p) => p.projectKeys ?? []).map((k) => k.trim().toUpperCase())
  if (order.length < 2) return [...keys]
  const rank = (key: string) => {
    const i = order.indexOf(projectOfKey(key) ?? '')
    return i < 0 ? order.length : i
  }
  return keys.map((key, i) => ({ key, i, r: rank(key) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.key)
}
