import { describe, expect, it } from 'vitest'
import { groupBySprint, ticketsInProgress } from '@workhub/core'
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
