import { describe, expect, it } from 'vitest'
import { countByCategory, groupBySprint, localDay, milestoneStatus, PRODUCT_MILESTONE_EXPECTED, productMilestones, ticketsInProgress } from '@workhub/core'
import { DemoTracker } from '../src/tracker-demo'

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

  it('keeps the generic demo for other queries and for a tracker without a scenario', async () => {
    expect((await new DemoTracker('jira', { scenario: 'team-lead' }).searchByQuery('project = OTHER')).length).toBeGreaterThanOrEqual(4)
    expect((await new DemoTracker().listAssigned()).some((t) => t.key.startsWith('DEMO-'))).toBe(true)
  })
})
