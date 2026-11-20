import { afterEach, describe, expect, it, vi } from 'vitest'
import { countByCategory, groupBySprint, localDay, milestoneStatus, openTicketsOf, PRODUCT_MILESTONE_EXPECTED, productMilestoneCounts, productMilestones, ticketsInProgress } from '@workhub/core'
import { DemoTracker } from '../src/tracker-demo'

afterEach(() => vi.useRealTimers())

describe('DemoTracker', () => {
  it('lists synthetic open tickets in an active sprint, a future sprint and the backlog', async () => {
    const tickets = await new DemoTracker().listAssigned()
    expect(groupBySprint(tickets).map((g) => g.title)).toEqual(['Sprint 41', 'Sprint 42', 'Backlog'])
    expect(ticketsInProgress(tickets).length).toBeGreaterThan(0)
  })

  it('keeps transitions and comments in memory, and drops done tickets from the list', async () => {
    const demo = new DemoTracker()
    await demo.transition('DEMO-104', 'done')
    await demo.addComment('DEMO-104', 'Done now')
    expect((await demo.listAssigned()).some((t) => t.key === 'DEMO-104')).toBe(false)
    expect((await demo.getTicket('DEMO-104'))?.comments.at(-1)?.body).toBe('Done now')
    expect(await demo.getTicket('NOPE-1')).toBeNull()
  })
})

describe('DemoTracker search and create', () => {
  it('finds the same synthetic tickets for the same query, within the limit', async () => {
    const demo = new DemoTracker()
    const a = await demo.searchByQuery('project = DEMO')
    expect(a.length).toBeGreaterThanOrEqual(4)
    expect(await demo.searchByQuery('project = DEMO')).toEqual(a)
    expect(await demo.searchByQuery('project = DEMO', { limit: 2 })).toHaveLength(2)
    await expect(demo.searchByQuery(' ')).rejects.toThrow()
  })

  it('creates issues in memory', async () => {
    const demo = new DemoTracker()
    expect(await demo.createIssue({ project: 'demo', title: 'New', description: '' })).toEqual({ key: 'DEMO-900', url: 'https://demo.example.com/browse/DEMO-900' })
    expect(demo.created).toHaveLength(1)
  })
})

describe('DemoTracker in the team-lead scenario', () => {
  it('lists NOTE, WEB and OPS tickets in progress that match the scenario', async () => {
    const tickets = await new DemoTracker('jira', { scenario: 'team-lead' }).listAssigned()
    expect(tickets.every((t) => /^(NOTE|WEB|OPS)-\d+$/.test(t.key))).toBe(true)
    expect(ticketsInProgress(tickets).map((t) => t.key)).toEqual(expect.arrayContaining(['NOTE-231', 'NOTE-250']))
    expect((await new DemoTracker('jira', { scenario: 'team-lead' }).getTicket('NOTE-231'))?.comments.length).toBeGreaterThan(0)
  })

  it('answers every milestone query so that each one lands in its expected status', async () => {
    const demo = new DemoTracker('jira', { scenario: 'team-lead' })
    const now = new Date(2026, 10, 4, 10).getTime()
    const today = localDay(now)
    for (const m of productMilestones(today)) {
      if (m.source.kind !== 'tracker') continue
      const counts = countByCategory(await demo.searchByQuery(m.source.query))
      expect(counts.total).toBeGreaterThan(0)
      expect(milestoneStatus(m, counts, today).status).toBe(PRODUCT_MILESTONE_EXPECTED[m.id as keyof typeof PRODUCT_MILESTONE_EXPECTED])
    }
  })

  it('gives an owner (or nobody), a creation and an update time to every ticket a query finds', async () => {
    for (const scenario of [undefined, 'team-lead']) {
      const demo = new DemoTracker('jira', scenario ? { scenario } : {})
      const queries = scenario ? productMilestones('2026-11-04').flatMap((m) => (m.source.kind === 'tracker' ? [m.source.query] : [])) : ['project = DEMO', 'other']
      for (const q of queries) {
        const found = await demo.searchByQuery(q)
        expect(found.length).toBeGreaterThan(0)
        for (const t of found) {
          expect(t.assignee === null || typeof t.assignee === 'string').toBe(true)
          expect(t.createdAt).toBeLessThanOrEqual(t.updatedAt!)
          expect(t.updatedAt).toBeLessThanOrEqual(Date.now())
        }
      }
    }
  })

  it('shows the at-risk milestone with more flagged open tickets than the on-track one, as Count again would', async () => {
    const demo = new DemoTracker('jira', { scenario: 'team-lead' })
    const now = new Date(2026, 10, 4, 10).getTime()
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const ms = productMilestones(localDay(now))
    const open = async (id: string) => {
      const m = ms.find((x) => x.id === id)!
      if (m.source.kind !== 'tracker') throw new Error('not counted')
      return openTicketsOf(await demo.searchByQuery(m.source.query), m, now)
    }
    const risk = await open('ms-activation')
    const sso = await open('ms-sso')
    expect(risk.unassigned).toBeGreaterThan(0)
    expect(risk.stale).toBeGreaterThan(0)
    expect(risk.addedLate).toBeGreaterThan(0)
    expect(risk.unassigned + risk.stale + risk.addedLate).toBeGreaterThan(3 * (sso.unassigned + sso.stale + sso.addedLate))
    expect(productMilestoneCounts(ms, now)['ms-activation']!.open).toEqual(risk)
  })

  it('reads the scenario tickets by key with their current state, and leaves unknown keys out', async () => {
    const demo = new DemoTracker('jira', { scenario: 'team-lead' })
    const read = await demo.readTickets(['NOTE-253', 'note-238', 'NOTE-255', 'NOPE-1'])
    expect(read.map((t) => [t.key, t.category])).toEqual([
      ['NOTE-253', 'inProgress'],
      ['NOTE-238', 'done'],
      ['NOTE-255', 'inProgress']
    ])
    await demo.transition('NOTE-253', 'done')
    expect((await demo.readTickets(['NOTE-253']))[0]?.category).toBe('done')
    const created = await demo.createIssue({ project: 'NOTE', title: 'New one', description: '' })
    expect((await demo.readTickets([created.key]))[0]).toMatchObject({ key: created.key, category: 'todo' })
  })

  it('keeps the generic demo for other queries and for a tracker without a scenario', async () => {
    expect((await new DemoTracker('jira', { scenario: 'team-lead' }).searchByQuery('project = OTHER')).length).toBeGreaterThanOrEqual(4)
    expect((await new DemoTracker().listAssigned()).some((t) => t.key.startsWith('DEMO-'))).toBe(true)
  })
})

describe('DemoTracker queryUrl', () => {
  it('gives an address on example.com with the query encoded, none for an empty query', async () => {
    const demo = new DemoTracker()
    expect(await demo.queryUrl('project = DEMO')).toBe('https://demo.example.com/issues?q=project%20%3D%20DEMO')
    expect(await demo.queryUrl(' ')).toBeUndefined()
  })
})
