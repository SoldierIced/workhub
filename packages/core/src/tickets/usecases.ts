import { findTicketKeys, type TicketKeyProvider } from './keys'
import type { PullRequestRef, SessionRef, Ticket, TicketDetail, TicketSprint } from './types'

/** Tickets being worked on: the "Tickets in progress" tile of Home. */
export function ticketsInProgress(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.category === 'inProgress')
}

export interface TicketGroup {
  /** Sprint id, or `backlog`. */
  id: string
  title: string
  sprint?: TicketSprint
  isActive: boolean
  tickets: Ticket[]
}

export const BACKLOG_GROUP = 'backlog'

/**
 * Workhub 1's grouping of the Tickets screen: the active sprint first, then future sprints by id
 * (creation order), then the backlog (no open sprint). Order inside a group is the tracker's.
 */
export function groupBySprint(tickets: readonly Ticket[], backlogTitle = 'Backlog'): TicketGroup[] {
  const sprints = new Map<string, TicketGroup>()
  const backlog: Ticket[] = []
  for (const t of tickets) {
    if (!t.sprint) {
      backlog.push(t)
      continue
    }
    const group = sprints.get(t.sprint.id) ?? { id: t.sprint.id, title: t.sprint.name, sprint: t.sprint, isActive: t.sprint.state === 'active', tickets: [] }
    group.tickets.push(t)
    sprints.set(t.sprint.id, group)
  }
  const order = (g: TicketGroup) => {
    const n = Number(g.id)
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
  }
  const sorted = [...sprints.values()].sort((a, b) => Number(b.isActive) - Number(a.isActive) || order(a) - order(b) || (a.sprint?.startDate ?? '').localeCompare(b.sprint?.startDate ?? '') || a.id.localeCompare(b.id))
  if (backlog.length > 0) sorted.push({ id: BACKLOG_GROUP, title: backlogTitle, isActive: false, tickets: backlog })
  return sorted
}

/** Tickets that survive the user's "ignored statuses" list (case-insensitive). */
export function withoutIgnoredStatuses<T extends Pick<Ticket, 'status'>>(tickets: readonly T[], ignored: readonly string[]): T[] {
  if (ignored.length === 0) return [...tickets]
  const hide = new Set(ignored.map((s) => s.trim().toLowerCase()).filter(Boolean))
  return tickets.filter((t) => !hide.has(t.status.toLowerCase()))
}

/**
 * Sessions that mention the ticket: the monitor already found its key, or the key is in the
 * title, the working folder, the git branch or the summary.
 */
export function sessionsForTicket<S extends SessionRef>(key: string, sessions: readonly S[], providers: readonly TicketKeyProvider[]): S[] {
  return sessions.filter((s) => {
    if (s.ticketKeys?.some((k) => k.toUpperCase() === key.toUpperCase())) return true
    const text = [s.title, s.cwd, s.gitBranch, s.summary].filter(Boolean).join('\n')
    return findTicketKeys(text, providers).some((m) => m.key === key)
  })
}

/** The ticket keys a session mentions, from its monitor and its descriptive fields. */
export function ticketKeysOfSession(session: SessionRef, providers: readonly TicketKeyProvider[]): string[] {
  const text = [session.title, session.cwd, session.gitBranch, session.summary].filter(Boolean).join('\n')
  const found = findTicketKeys(text, providers).map((m) => m.key)
  return [...new Set([...(session.ticketKeys ?? []), ...found])]
}

const PR_URL = /https:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+|gitlab\.com\/[A-Za-z0-9_.\/-]+\/-\/merge_requests\/\d+)/gi

/** Pull/merge request URLs written in a text, normalized (lower case, no suffix) and without repeats. */
export function pullRequestUrlsIn(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(PR_URL)) {
    const url = m[0].toLowerCase()
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** The PRs a ticket lists in its description and comments. */
export function listedPullRequests(detail: Pick<TicketDetail, 'description' | 'comments'>): string[] {
  return pullRequestUrlsIn([detail.description ?? '', ...detail.comments.map((c) => c.body)].join('\n'))
}

/**
 * The PRs of a ticket: the key is in the PR title or branch (Workhub 1's rule), or the ticket
 * lists the PR. `listed` are URLs from `listedPullRequests`.
 */
export function pullRequestsForTicket<P extends PullRequestRef>(
  key: string,
  prs: readonly P[],
  providers: readonly TicketKeyProvider[],
  listed: readonly string[] = []
): P[] {
  const urls = new Set(listed.map((u) => u.toLowerCase()))
  return prs.filter((pr) => {
    if (urls.has(pr.url.toLowerCase())) return true
    const text = [pr.title, pr.branch].filter(Boolean).join('\n')
    return findTicketKeys(text, providers).some((m) => m.key === key)
  })
}
