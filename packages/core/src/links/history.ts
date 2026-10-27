import { canonicalUrl } from '../codehost/urls'
import { sessionsForPullRequest, type LinkReason, type LinkableSession } from '../codehost/links'
import type { PullRequest } from '../codehost/domain'
import type { HistoryEntry } from '../ports'
import { pullRequestUrlsIn, sessionsForTicket } from '../tickets/usecases'
import { ticketKeysIn, type TicketKeyProvider } from '../tickets/keys'

export interface HistoryLink<T extends HistoryEntry = HistoryEntry> {
  entry: T
  reason: LinkReason
}

/** The identity of a past session across agents: the same agent session id can exist under two agents. */
export function historyId(e: Pick<HistoryEntry, 'agentId' | 'agentSessionId'>): string {
  return `${e.agentId}\u0000${e.agentSessionId}`
}

/** What the history knows of a session that can tie it to a PR: branch, and the text of its title and first prompt. */
function linkableOf(e: HistoryEntry, pr: Pick<PullRequest, 'url'>, providers: readonly TicketKeyProvider[]): LinkableSession {
  const text = [e.title, e.firstPrompt].filter(Boolean).join('\n')
  const urls = pullRequestUrlsIn(text)
  // Hosts the URL pattern does not know (self-hosted) still count when the PR's own URL is written out.
  if (text.toLowerCase().includes(canonicalUrl(pr.url))) urls.push(pr.url)
  return { id: historyId(e), branch: e.gitBranch, pullRequestUrls: urls, ticketKeys: ticketKeysIn(`${text}\n${e.gitBranch ?? ''}`, providers) }
}

/**
 * Past sessions that belong to a PR: they named its URL, ran on its branch, or share a ticket key
 * with it. Strongest reason first, newest first within a reason. `skip` hides the sessions that
 * are open now (by `historyId`), since the live list already shows them.
 */
export function historyForPullRequest<T extends HistoryEntry>(
  pr: PullRequest,
  entries: readonly T[],
  providers: readonly TicketKeyProvider[],
  skip: ReadonlySet<string> = new Set()
): HistoryLink<T>[] {
  const byId = new Map<string, T>()
  for (const e of entries) if (!skip.has(historyId(e))) byId.set(historyId(e), e)
  const linkable = [...byId.values()].map((e) => linkableOf(e, pr, providers))
  return sessionsForPullRequest(pr, linkable, providers)
    .map((l) => ({ entry: byId.get(l.sessionId)!, reason: l.reason }))
    .sort((a, b) => order(a.reason) - order(b.reason) || b.entry.lastModified - a.entry.lastModified)
}

const order = (r: LinkReason): number => (r === 'url' ? 0 : r === 'branch' ? 1 : 2)

/** Past sessions that mention a ticket in their title, first prompt, folder or branch; newest first. */
export function historyForTicket<T extends HistoryEntry>(
  key: string,
  entries: readonly T[],
  providers: readonly TicketKeyProvider[],
  skip: ReadonlySet<string> = new Set()
): T[] {
  const byId = new Map<string, T>()
  for (const e of entries) if (!skip.has(historyId(e))) byId.set(historyId(e), e)
  const refs = [...byId.values()].map((e) => ({ id: historyId(e), title: e.title, cwd: e.cwd, gitBranch: e.gitBranch, summary: e.firstPrompt }))
  return sessionsForTicket(key, refs, providers)
    .map((r) => byId.get(r.id)!)
    .sort((a, b) => b.lastModified - a.lastModified)
}
