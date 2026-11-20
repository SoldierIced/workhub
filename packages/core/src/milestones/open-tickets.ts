/**
 * The open tickets of a milestone counted from a tracker query, and what makes each look stuck:
 * nobody has it, nobody touched it for a week, or it was added after the milestone began. Pure.
 */
import { localDay } from '../alerts/days'
import type { TicketSummary, StatusCategory } from '../tickets/types'
import type { Milestone } from './index'

export type MilestoneTicketFlag = 'unassigned' | 'stale' | 'addedLate'

export interface MilestoneOpenTicket {
  key: string
  title: string
  status: string
  category: StatusCategory
  url?: string
  /** Display name; `null`: nobody has it; absent: the tracker does not say. */
  assignee?: string | null
  /** Epoch ms. */
  createdAt?: number
  updatedAt?: number
  flags: MilestoneTicketFlag[]
}

export interface MilestoneOpenTickets {
  /** At most `MILESTONE_OPEN_TICKETS_LIMIT`: the most worrying first. */
  tickets: MilestoneOpenTicket[]
  /** The counters below count every open ticket, not only those in `tickets`. */
  total: number
  unassigned: number
  stale: number
  addedLate: number
  /** The query opened in the tracker, set by the Plan service when the tracker can give an address for it. */
  url?: string
}

/** A ticket nobody touched for more than this many days is stale. */
export const MILESTONE_STALE_DAYS = 7
export const MILESTONE_OPEN_TICKETS_LIMIT = 50

const DAY_MS = 86_400_000

/** Nobody touched it for more than `MILESTONE_STALE_DAYS` days, as of `now`. */
export const isTicketStale = (updatedAt: number, now: number): boolean => now - updatedAt > MILESTONE_STALE_DAYS * DAY_MS

/** Ascending, an unknown time last. */
function oldestFirst(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  return a - b
}

/**
 * The open tickets (category not done) with their flags. `addedLate`: created after the milestone's
 * start day (a local day, like the rest of the milestone dates). A field the tracker did not give
 * raises no flag. Most flags first, then the least recently updated (unknown last), then key.
 */
export function openTicketsOf(tickets: readonly TicketSummary[], milestone: Pick<Milestone, 'start'>, now: number): MilestoneOpenTickets {
  const out: MilestoneOpenTicket[] = []
  const result = { total: 0, unassigned: 0, stale: 0, addedLate: 0 }
  for (const t of tickets) {
    if (t.category === 'done') continue
    const flags: MilestoneTicketFlag[] = []
    if (t.assignee === null) flags.push('unassigned')
    if (t.updatedAt !== undefined && isTicketStale(t.updatedAt, now)) flags.push('stale')
    if (t.createdAt !== undefined && localDay(t.createdAt) > milestone.start) flags.push('addedLate')
    result.total += 1
    if (flags.includes('unassigned')) result.unassigned += 1
    if (flags.includes('stale')) result.stale += 1
    if (flags.includes('addedLate')) result.addedLate += 1
    out.push({
      key: t.key,
      title: t.title,
      status: t.status,
      category: t.category,
      ...(t.url ? { url: t.url } : {}),
      ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
      ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
      ...(t.updatedAt !== undefined ? { updatedAt: t.updatedAt } : {}),
      flags
    })
  }
  out.sort((a, b) => b.flags.length - a.flags.length || oldestFirst(a.updatedAt, b.updatedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { tickets: out.slice(0, MILESTONE_OPEN_TICKETS_LIMIT), ...result }
}

const FLAG_ORDER: readonly MilestoneTicketFlag[] = ['unassigned', 'stale', 'addedLate']

/**
 * The same open tickets with "stale" worked out as of `now`, for every ticket whose last update is
 * known (the stored flag was fixed when the milestone was counted, which may be days ago: a tracker
 * that cannot be reached leaves the count as it was). The stale counter moves with them; tickets
 * the list leaves out, or with no known update, keep what the count said. Pure.
 */
export function openTicketsAt(open: MilestoneOpenTickets, now: number): MilestoneOpenTickets {
  let delta = 0
  const tickets = open.tickets.map((t) => {
    if (t.updatedAt === undefined) return t
    const stale = isTicketStale(t.updatedAt, now)
    if (stale === t.flags.includes('stale')) return t
    delta += stale ? 1 : -1
    const flags = new Set(t.flags)
    if (stale) flags.add('stale')
    else flags.delete('stale')
    return { ...t, flags: FLAG_ORDER.filter((f) => flags.has(f)) }
  })
  return delta === 0 ? open : { ...open, tickets, stale: Math.max(0, open.stale + delta) }
}
