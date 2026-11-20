import { describe, expect, it } from 'vitest'
import { MILESTONE_OPEN_TICKETS_LIMIT, MILESTONE_STALE_DAYS, openTicketsAt, openTicketsOf, type TicketSummary } from '../src'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 18, 12).getTime()
const milestone = { start: '2026-11-01' }
const t = (key: string, over: Partial<TicketSummary> = {}): TicketSummary => ({ key, title: key, status: 'To Do', category: 'todo', ...over })

describe('openTicketsOf', () => {
  it('leaves done tickets out of the list and of every counter', () => {
    const r = openTicketsOf([t('A-1', { category: 'done', assignee: null }), t('A-2', { category: 'inProgress' }), t('A-3')], milestone, NOW)
    expect(r.tickets.map((x) => x.key)).toEqual(['A-2', 'A-3'])
    expect(r).toMatchObject({ total: 2, unassigned: 0, stale: 0, addedLate: 0 })
  })

  it('raises no flag for a field the tracker did not give', () => {
    const r = openTicketsOf([t('A-1')], milestone, NOW)
    expect(r.tickets[0]).toEqual({ key: 'A-1', title: 'A-1', status: 'To Do', category: 'todo', flags: [] })
    expect(r).toMatchObject({ total: 1, unassigned: 0, stale: 0, addedLate: 0 })
  })

  it('flags unassigned only for null, never for a name or an absent assignee', () => {
    const r = openTicketsOf([t('A-1', { assignee: null }), t('A-2', { assignee: 'Sam Rivera' }), t('A-3')], milestone, NOW)
    expect(r.tickets.find((x) => x.key === 'A-1')).toMatchObject({ assignee: null, flags: ['unassigned'] })
    expect(r.tickets.find((x) => x.key === 'A-2')).toMatchObject({ assignee: 'Sam Rivera', flags: [] })
    expect(r.unassigned).toBe(1)
  })

  it('flags stale when untouched for more than the stale days, not at exactly that', () => {
    const r = openTicketsOf([t('A-1', { updatedAt: NOW - (MILESTONE_STALE_DAYS * DAY + 1) }), t('A-2', { updatedAt: NOW - MILESTONE_STALE_DAYS * DAY }), t('A-3', { updatedAt: NOW })], milestone, NOW)
    expect(r.tickets.filter((x) => x.flags.includes('stale')).map((x) => x.key)).toEqual(['A-1'])
    expect(r.stale).toBe(1)
  })

  it('flags addedLate when created after the end of the start day (local days)', () => {
    const lastMomentOfStart = new Date(2026, 10, 1, 23, 59, 59).getTime()
    const firstMomentAfter = new Date(2026, 10, 2, 0, 0, 1).getTime()
    const r = openTicketsOf([t('A-1', { createdAt: lastMomentOfStart }), t('A-2', { createdAt: firstMomentAfter }), t('A-3', { createdAt: new Date(2026, 9, 1).getTime() })], milestone, NOW)
    expect(r.tickets.filter((x) => x.flags.includes('addedLate')).map((x) => x.key)).toEqual(['A-2'])
    expect(r.addedLate).toBe(1)
  })

  it('orders by flags, then oldest update first (unknown last), then key', () => {
    const r = openTicketsOf(
      [
        t('A-9', { updatedAt: NOW - DAY }),
        t('A-8'),
        t('A-7', { updatedAt: NOW - 3 * DAY }),
        t('A-6', { assignee: null, updatedAt: NOW - 2 * DAY }),
        t('A-5', { assignee: null, updatedAt: NOW - 20 * DAY, createdAt: NOW }),
        t('A-4', { assignee: null, updatedAt: NOW - 30 * DAY }),
        t('A-3', { updatedAt: NOW - 3 * DAY })
      ],
      milestone,
      NOW
    )
    // A-5 has three flags; A-4 two (unassigned, stale); A-6 one; then no flags: oldest update, unknown last.
    expect(r.tickets.map((x) => x.key)).toEqual(['A-5', 'A-4', 'A-6', 'A-3', 'A-7', 'A-9', 'A-8'])
  })

  it('keeps at most the limit in the list while the counters count every open ticket', () => {
    const many = Array.from({ length: MILESTONE_OPEN_TICKETS_LIMIT + 20 }, (_, i) => t(`A-${String(i).padStart(3, '0')}`, { assignee: null }))
    const r = openTicketsOf(many, milestone, NOW)
    expect(r.tickets).toHaveLength(MILESTONE_OPEN_TICKETS_LIMIT)
    expect(r).toMatchObject({ total: MILESTONE_OPEN_TICKETS_LIMIT + 20, unassigned: MILESTONE_OPEN_TICKETS_LIMIT + 20 })
  })

  it('does not change its input', () => {
    const input = [t('B-1', { assignee: null }), t('A-1')]
    openTicketsOf(input, milestone, NOW)
    expect(input.map((x) => x.key)).toEqual(['B-1', 'A-1'])
  })
})

describe('openTicketsAt', () => {
  const counted = openTicketsOf([t('A-1', { assignee: null, updatedAt: NOW - 6 * DAY }), t('A-2', { updatedAt: NOW - 9 * DAY }), t('A-3')], milestone, NOW)

  it('is the same object while nothing changed', () => {
    expect(openTicketsAt(counted, NOW)).toBe(counted)
  })

  it('flags a ticket that became stale since the count and moves the number with it, keeping the flag order', () => {
    const later = openTicketsAt(counted, NOW + 3 * DAY)
    expect(later.tickets.find((x) => x.key === 'A-1')?.flags).toEqual(['unassigned', 'stale'])
    expect(later.stale).toBe(2)
    expect(counted.stale).toBe(1)
  })

  it('leaves a ticket with no known update, and tickets the list leaves out, as counted', () => {
    const cut = { ...counted, total: 10, stale: 4 }
    const later = openTicketsAt(cut, NOW + 30 * DAY)
    expect(later.tickets.find((x) => x.key === 'A-3')?.flags).toEqual([])
    expect(later.stale).toBe(5)
  })
})
