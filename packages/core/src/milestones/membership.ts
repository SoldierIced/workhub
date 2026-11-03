/**
 * Which milestones an inbox item belongs to, and how to put it in one or take it out. The pieces of
 * a milestone are the only record: an item belongs to the milestones that list it as a task piece,
 * or that list its ticket as a ticket piece. Pure.
 */
import type { InboxItem } from '../inbox/types'
import type { Milestone } from './index'
import { PIECE_LIMITS, PIECE_WEIGHT } from './pieces'

/** Whether the milestone lists the item: as a task piece, or its ticket as a ticket piece. */
export function milestoneHasItem(milestone: Pick<Milestone, 'source'>, item: Pick<InboxItem, 'id' | 'ticket'>): boolean {
  if (milestone.source.kind !== 'items') return false
  const key = item.ticket?.key
  return milestone.source.items.some((p) => (p.kind === 'task' && p.itemId === item.id) || (key !== undefined && p.kind === 'ticket' && p.key === key))
}

/** The milestones an item belongs to, in the order given. */
export function milestonesOfItem<M extends Pick<Milestone, 'source'>>(item: Pick<InboxItem, 'id' | 'ticket'>, milestones: readonly M[]): M[] {
  return milestones.filter((m) => milestoneHasItem(m, item))
}

/** Why an item cannot be added to a milestone, or null when it can. */
export type AssignProblem = 'notPieces' | 'full' | null

/**
 * Only a milestone made of pieces takes items: adding one to a milestone typed by hand or counted
 * from a query would change how its progress is counted.
 */
export function assignProblem(milestone: Pick<Milestone, 'source'>): AssignProblem {
  if (milestone.source.kind !== 'items') return 'notPieces'
  return milestone.source.items.length >= PIECE_LIMITS.items ? 'full' : null
}

/** The milestone with the item added as a task piece of the default weight; unchanged when it already lists it or cannot take it. */
export function withItem<M extends Milestone>(milestone: M, item: Pick<InboxItem, 'id' | 'ticket'>): M {
  if (assignProblem(milestone) || milestoneHasItem(milestone, item) || milestone.source.kind !== 'items') return milestone
  return { ...milestone, source: { kind: 'items', items: [...milestone.source.items, { kind: 'task', itemId: item.id, weight: PIECE_WEIGHT.default }] } }
}

/** The milestone without the item's task piece (and without its ticket's piece); unchanged when it does not list it. */
export function withoutItem<M extends Milestone>(milestone: M, item: Pick<InboxItem, 'id' | 'ticket'>): M {
  if (milestone.source.kind !== 'items' || !milestoneHasItem(milestone, item)) return milestone
  const key = item.ticket?.key
  const items = milestone.source.items.filter((p) => !((p.kind === 'task' && p.itemId === item.id) || (key !== undefined && p.kind === 'ticket' && p.key === key)))
  return { ...milestone, source: { kind: 'items', items } }
}

/** Open work grouped by milestone: one group per milestone (in the order given) with its items, then the items in none. */
export interface MilestoneGroups<M, I> {
  groups: { milestone: M; items: I[] }[]
  /** Items no milestone lists. */
  loose: I[]
}

/**
 * Groups items by the milestones that list them. An item in two milestones shows in both;
 * milestones with no item among `items` are left out. `of` reads the milestone from each entry
 * (a view that wraps it, for example).
 */
export function groupByMilestone<M, I extends Pick<InboxItem, 'id' | 'ticket'>>(items: readonly I[], milestones: readonly M[], of: (m: M) => Pick<Milestone, 'source'>): MilestoneGroups<M, I> {
  const groups = milestones.map((milestone) => ({ milestone, items: items.filter((i) => milestoneHasItem(of(milestone), i)) })).filter((g) => g.items.length > 0)
  const loose = items.filter((i) => !milestones.some((m) => milestoneHasItem(of(m), i)))
  return { groups, loose }
}
