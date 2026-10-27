import type { PullRequestItem } from '@workhub/core'

/** Workhub 1's narrowing bar: filters and order on top of the To review / Mine / Stale / All scope. */
export type TicketFilter = 'any' | 'with' | 'without'
export type PrOrder = 'newest' | 'oldest' | 'repo'
export type NarrowField = 'statuses' | 'bases' | 'repos' | 'authors'

export const TICKET_FILTERS: readonly TicketFilter[] = ['any', 'with', 'without']
export const PR_ORDERS: readonly PrOrder[] = ['newest', 'oldest', 'repo']

export interface PrNarrowing {
  statuses: string[]
  bases: string[]
  repos: string[]
  authors: string[]
  ticket: TicketFilter
  order: PrOrder
}

export const NO_NARROWING: PrNarrowing = { statuses: [], bases: [], repos: [], authors: [], ticket: 'any', order: 'newest' }

export function isNarrowed(n: PrNarrowing): boolean {
  return n.statuses.length > 0 || n.bases.length > 0 || n.repos.length > 0 || n.authors.length > 0 || n.ticket !== 'any'
}

/** `main` and `master` are one target, as are `develop`, `dev` and `development`. */
export function baseGroup(base: string): string {
  switch (base) {
    case 'main':
    case 'master':
      return 'master / main'
    case 'develop':
    case 'dev':
    case 'development':
      return 'develop'
    default:
      return base
  }
}

const VALUE: Record<NarrowField, (i: PullRequestItem) => string> = {
  statuses: (i) => i.status,
  bases: (i) => baseGroup(i.pr.base),
  repos: (i) => i.pr.repo,
  authors: (i) => i.pr.author
}

export interface NarrowOption {
  value: string
  count: number
}

/** The distinct values of a field with how many PRs have each, most common first, then by name. */
export function narrowOptions(items: readonly PullRequestItem[], field: NarrowField): NarrowOption[] {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(VALUE[field](i), (counts.get(VALUE[field](i)) ?? 0) + 1)
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** How many PRs each ticket choice keeps. */
export function ticketCounts(items: readonly PullRequestItem[]): Record<TicketFilter, number> {
  const withTicket = items.filter((i) => i.ticketKeys.length > 0).length
  return { any: items.length, with: withTicket, without: items.length - withTicket }
}

/** The PRs the narrowing keeps, in its order. */
export function applyNarrowing(items: readonly PullRequestItem[], n: PrNarrowing): PullRequestItem[] {
  const keep = (field: NarrowField, i: PullRequestItem) => n[field].length === 0 || n[field].includes(VALUE[field](i))
  const kept = items.filter(
    (i) => keep('statuses', i) && keep('bases', i) && keep('repos', i) && keep('authors', i) && (n.ticket === 'any' || (n.ticket === 'with') === i.ticketKeys.length > 0)
  )
  const updated = (i: PullRequestItem) => i.pr.updatedAt ?? 0
  switch (n.order) {
    case 'newest':
      return kept.sort((a, b) => updated(b) - updated(a))
    case 'oldest':
      return kept.sort((a, b) => updated(a) - updated(b))
    case 'repo':
      return kept.sort((a, b) => a.pr.repo.localeCompare(b.pr.repo) || a.pr.number - b.pr.number)
  }
}

/** Turns one value of a multi-select field on or off. */
export function toggleValue(n: PrNarrowing, field: NarrowField, value: string): PrNarrowing {
  const current = n[field]
  return { ...n, [field]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] }
}

/** Clears the filters and keeps the order (Workhub 1's "Clear"). */
export function clearNarrowing(n: PrNarrowing): PrNarrowing {
  return { ...NO_NARROWING, order: n.order }
}
