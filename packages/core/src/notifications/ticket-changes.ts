/**
 * Ticket notifications, as Workhub 1 sends them: a status change of an assigned ticket, a ticket
 * newly assigned, and a ticket that left the list (done, or assigned to someone else). The first
 * read of a profile only records what is there.
 */
import type { Ticket } from '../tickets/types'

export interface KnownTicket {
  status: string
  title: string
}

/** The assigned tickets last seen, by key. */
export type KnownTickets = Record<string, KnownTicket>

export type TicketChange =
  | { kind: 'status'; key: string; title: string; from: string; to: string }
  | { kind: 'assigned'; key: string; title: string; status: string }
  | { kind: 'left'; key: string; title: string }

export function ticketChanges(known: KnownTickets | undefined, current: readonly Pick<Ticket, 'key' | 'title' | 'status'>[]): { changes: TicketChange[]; known: KnownTickets } {
  const next: KnownTickets = {}
  for (const t of current) if (!next[t.key]) next[t.key] = { status: t.status, title: t.title }
  if (!known) return { changes: [], known: next }
  const changes: TicketChange[] = []
  for (const [key, now] of Object.entries(next)) {
    const before = known[key]
    if (!before) changes.push({ kind: 'assigned', key, title: now.title, status: now.status })
    else if (before.status !== now.status) changes.push({ kind: 'status', key, title: now.title, from: before.status, to: now.status })
  }
  for (const [key, before] of Object.entries(known)) if (!next[key]) changes.push({ kind: 'left', key, title: before.title })
  return { changes, known: next }
}
