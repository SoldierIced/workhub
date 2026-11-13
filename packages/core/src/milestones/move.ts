/**
 * Moving a milestone to another profile's Plan, with what it is made of: its task pieces and the
 * inbox items that belong to it go with it, its counts and pending agent proposals too, and every
 * ticket that was read from the first profile's tracker keeps reading from that tracker. Pure.
 */
import type { InboxItem } from '../inbox/types'
import type { Milestone, MilestoneCounts, MilestoneProposal } from './index'
import { milestoneHasItem } from './membership'
import { ticketStateKey, type MilestonePiece, type TrackedTicket } from './pieces'

/** The parts of one profile's Plan a move reads and changes. */
export interface PlanSide {
  milestones: Milestone[]
  inbox: InboxItem[]
  counts: Record<string, MilestoneCounts>
  errors: Record<string, string>
  proposals: MilestoneProposal[]
  tickets: Record<string, TrackedTicket>
}

/** The trackers a profile reads tickets from when a piece or an item names no connection. */
export interface PlanTrackers {
  /** The profile's tracker connection id (pieces, tracker queries); undefined without one. */
  tracker?: string
  /** The inbox's connection id (items' tickets); empty for the profile's tracker. */
  inbox: string
}

export interface MoveMilestoneInput {
  from: PlanSide
  to: PlanSide
  id: string
  fromTrackers: PlanTrackers
  toTrackers: PlanTrackers
  /** A new id, for a milestone or item whose id the target already uses, and for copies. */
  newId: () => string
}

export interface MoveMilestoneSummary {
  /** Inbox items moved with the milestone. */
  moved: number
  /** Items another milestone of the first profile also lists: copied, the original stays. */
  copied: number
  /** Tickets and queries now naming the first profile's tracker so they keep reading from it. */
  pinned: number
}

export type MoveMilestoneResult = ({ ok: true; from: PlanSide; to: PlanSide; milestone: Milestone } & MoveMilestoneSummary) | { ok: false; reason: 'unknown' }

/** What a move would do, for the confirmation; null when the milestone is not there. */
export function moveMilestonePreview(input: Omit<MoveMilestoneInput, 'newId'>): MoveMilestoneSummary | null {
  let n = 0
  const r = moveMilestone({ ...input, newId: () => `preview-${++n}` })
  return r.ok ? { moved: r.moved, copied: r.copied, pinned: r.pinned } : null
}

export function moveMilestone({ from, to, id, fromTrackers, toTrackers, newId }: MoveMilestoneInput): MoveMilestoneResult {
  const milestone = from.milestones.find((m) => m.id === id)
  if (!milestone) return { ok: false, reason: 'unknown' }

  // A connection left empty means "this profile's tracker": named explicitly when the target's differs.
  const pieceTracker = fromTrackers.tracker && fromTrackers.tracker !== toTrackers.tracker ? fromTrackers.tracker : undefined
  const fromInbox = fromTrackers.inbox || fromTrackers.tracker || ''
  const toInbox = toTrackers.inbox || toTrackers.tracker || ''
  const itemTracker = fromInbox && fromInbox !== toInbox ? fromInbox : undefined
  let pinned = 0

  const takenItems = new Set(to.inbox.map((i) => i.id))
  const fresh = (taken: Set<string>) => {
    let next = newId()
    while (taken.has(next)) next = newId()
    taken.add(next)
    return next
  }

  // Items in the milestone: those no other milestone here lists move, the others are copied.
  const others = from.milestones.filter((m) => m.id !== id)
  const members = from.inbox.filter((i) => milestoneHasItem(milestone, i))
  const shared = new Set(members.filter((i) => others.some((m) => milestoneHasItem(m, i))).map((i) => i.id))
  const itemIds = new Map<string, string>()
  const tickets: Record<string, TrackedTicket> = { ...to.tickets }
  const carried: InboxItem[] = members.map((item) => {
    const newItemId = shared.has(item.id) || takenItems.has(item.id) ? fresh(takenItems) : item.id
    takenItems.add(newItemId)
    itemIds.set(item.id, newItemId)
    if (!item.ticket) return { ...item, id: newItemId }
    const pin = !item.ticket.connectionId && itemTracker
    if (pin) pinned++
    const ticket = pin ? { ...item.ticket, connectionId: itemTracker } : item.ticket
    const known = from.tickets[ticketStateKey(item.ticket.connectionId ?? fromTrackers.inbox, item.ticket.key)]
    if (known) tickets[ticketStateKey(ticket.connectionId ?? toTrackers.inbox, ticket.key)] = known
    return { ...item, id: newItemId, ticket }
  })

  const piece = (p: MilestonePiece): MilestonePiece => {
    if (p.kind === 'task') return { ...p, itemId: itemIds.get(p.itemId) ?? p.itemId }
    if (p.kind !== 'ticket') return p
    const pin = !p.connectionId && pieceTracker
    if (pin) pinned++
    const next = pin ? { ...p, connectionId: pieceTracker } : p
    const known = from.tickets[ticketStateKey(p.connectionId, p.key)]
    if (known) tickets[ticketStateKey(next.connectionId, next.key)] = known
    return next
  }
  let source = milestone.source
  if (source.kind === 'items') source = { kind: 'items', items: source.items.map(piece) }
  else if (source.kind === 'tracker' && !source.connectionId && pieceTracker) {
    source = { ...source, connectionId: pieceTracker }
    pinned++
  }
  const takenMilestones = new Set(to.milestones.map((m) => m.id))
  const moved: Milestone = { ...milestone, id: takenMilestones.has(id) ? fresh(takenMilestones) : id, source }

  const without = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id))
  const proposals = from.proposals.filter((p) => p.milestoneId === id)
  const movedItems = members.filter((i) => !shared.has(i.id)).map((i) => i.id)
  return {
    ok: true,
    milestone: moved,
    moved: movedItems.length,
    copied: shared.size,
    pinned,
    from: {
      ...from,
      milestones: others,
      inbox: from.inbox.filter((i) => !movedItems.includes(i.id)),
      counts: without(from.counts),
      errors: without(from.errors),
      proposals: from.proposals.filter((p) => p.milestoneId !== id)
    },
    to: {
      ...to,
      milestones: [...to.milestones, moved],
      inbox: [...to.inbox, ...carried],
      counts: from.counts[id] ? { ...to.counts, [moved.id]: from.counts[id]! } : to.counts,
      proposals: [...to.proposals, ...proposals.map((p) => ({ ...p, milestoneId: moved.id }))],
      tickets
    }
  }
}
