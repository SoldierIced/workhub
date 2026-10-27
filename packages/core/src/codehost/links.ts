import type { PullRequest } from './domain'
import { canonicalUrl } from './urls'

/**
 * Ticket keys such as `ABC-123`. Generic on purpose: it will switch to the tickets module's
 * per-provider key patterns once that module is merged.
 */
const GENERIC_TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g

export function extractTicketKeys(text: string): string[] {
  return [...new Set(text.match(GENERIC_TICKET_KEY) ?? [])]
}

/** Ticket keys named in a PR's title or branch, in order (Workhub 1 looked in exactly these two). */
export function ticketKeysOfPullRequest(pr: Pick<PullRequest, 'title' | 'branch'>): string[] {
  return extractTicketKeys(`${pr.title} ${pr.branch}`)
}

/** What a session knows that can tie it to a PR. */
export interface LinkableSession {
  id: string
  /** Git branch the session works on. */
  branch?: string
  /** PR URLs the session's tool calls created or touched (the monitor's `pullRequests`). */
  pullRequestUrls?: string[]
  ticketKeys?: string[]
}

/** Why a session and a PR belong together, strongest first. */
export type LinkReason = 'url' | 'branch' | 'ticket'
export interface SessionLink {
  sessionId: string
  reason: LinkReason
}

const REASON_ORDER: Record<LinkReason, number> = { url: 0, branch: 1, ticket: 2 }

/** Long-lived branches say nothing about which PR a session belongs to. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'staging', 'production'])

function reasonFor(pr: PullRequest, session: LinkableSession, prTickets: string[]): LinkReason | null {
  const url = canonicalUrl(pr.url)
  if ((session.pullRequestUrls ?? []).some((u) => canonicalUrl(u) === url)) return 'url'
  const branch = session.branch?.trim()
  if (branch && branch === pr.branch && !SHARED_BRANCHES.has(branch.toLowerCase())) return 'branch'
  if (prTickets.length > 0 && (session.ticketKeys ?? []).some((k) => prTickets.includes(k))) return 'ticket'
  return null
}

/** The sessions that belong to a PR: by URL, by branch or by a shared ticket key. Strongest reason first. */
export function sessionsForPullRequest(pr: PullRequest, sessions: readonly LinkableSession[]): SessionLink[] {
  const tickets = ticketKeysOfPullRequest(pr)
  const links: SessionLink[] = []
  for (const s of sessions) {
    const reason = reasonFor(pr, s, tickets)
    if (reason) links.push({ sessionId: s.id, reason })
  }
  return links.sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason])
}

/** The PRs that belong to a session. */
export function pullRequestsForSession(session: LinkableSession, prs: readonly PullRequest[]): PullRequest[] {
  return prs.filter((pr) => reasonFor(pr, session, ticketKeysOfPullRequest(pr)) !== null)
}

/** The PRs that name a ticket. */
export function pullRequestsForTicket(key: string, prs: readonly PullRequest[]): PullRequest[] {
  return prs.filter((pr) => ticketKeysOfPullRequest(pr).includes(key))
}
