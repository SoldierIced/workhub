import { describe, expect, it } from 'vitest'
import { moveMilestone, moveMilestonePreview, type InboxItem, type Milestone, type PlanSide } from '../src'

const item = (id: string, ticket?: InboxItem['ticket']): InboxItem => ({ id, kind: 'task', title: id, detail: '', source: { kind: 'manual' }, status: ticket ? 'tracked' : 'local', createdAt: 1, ...(ticket ? { ticket } : {}) }) as unknown as InboxItem
const pieces = (id: string, items: Extract<Milestone['source'], { kind: 'items' }>['items']): Milestone => ({ id, name: id, start: '2026-11-01', end: '2026-11-30', source: { kind: 'items', items } })
const side = (over: Partial<PlanSide> = {}): PlanSide => ({ milestones: [], inbox: [], counts: {}, errors: {}, proposals: [], tickets: {}, ...over })
const state = { category: 'done', status: 'Done', at: 1 } as unknown as PlanSide['tickets'][string]

describe('moveMilestone', () => {
  const from = side({
    milestones: [
      pieces('m1', [
        { kind: 'task', itemId: 'own', weight: 5 },
        { kind: 'task', itemId: 'shared', weight: 5 },
        { kind: 'ticket', key: 'PAY-1', weight: 5 },
        { kind: 'link', url: 'https://example.com', label: 'spec', done: false, weight: 5 }
      ]),
      pieces('m2', [{ kind: 'task', itemId: 'shared', weight: 5 }])
    ],
    inbox: [item('own'), item('shared'), item('follows', { key: 'PAY-1' }), item('other')],
    counts: { m1: { total: 1, todo: 0, inProgress: 0, done: 1, at: 1 } },
    errors: { m1: 'old' },
    proposals: [{ id: 'p1', action: 'update', milestoneId: 'm1', source: {}, createdAt: 1 }],
    tickets: { '|PAY-1': state }
  })
  const trackers = { from: { tracker: 'jira-a', inbox: '' }, to: { tracker: 'jira-b', inbox: '' } }
  let n = 0
  const run = (to = side()) => moveMilestone({ from, to, id: 'm1', fromTrackers: trackers.from, toTrackers: trackers.to, newId: () => `new${++n}` })

  it('carries its own items, copies shared ones and keeps tickets on the first tracker', () => {
    const r = run()
    if (!r.ok) throw new Error('not moved')
    expect({ moved: r.moved, copied: r.copied, pinned: r.pinned }).toEqual({ moved: 2, copied: 1, pinned: 2 })
    expect(r.from.milestones.map((m) => m.id)).toEqual(['m2'])
    expect(r.from.inbox.map((i) => i.id)).toEqual(['shared', 'other'])
    expect(r.from.counts).toEqual({})
    expect(r.from.errors).toEqual({})
    expect(r.from.proposals).toEqual([])
    const copy = r.to.inbox.find((i) => i.title === 'shared')!
    expect(copy.id).not.toBe('shared')
    expect(r.milestone.source).toEqual({
      kind: 'items',
      items: [
        { kind: 'task', itemId: 'own', weight: 5 },
        { kind: 'task', itemId: copy.id, weight: 5 },
        { kind: 'ticket', key: 'PAY-1', connectionId: 'jira-a', weight: 5 },
        { kind: 'link', url: 'https://example.com', label: 'spec', done: false, weight: 5 }
      ]
    })
    expect(r.to.inbox.find((i) => i.id === 'follows')!.ticket).toEqual({ key: 'PAY-1', connectionId: 'jira-a' })
    expect(r.to.tickets['jira-a|PAY-1']).toBe(state)
    expect(r.to.counts['m1']).toEqual(from.counts['m1'])
    expect(r.to.proposals.map((p) => p.milestoneId)).toEqual(['m1'])
  })

  it('leaves connections alone when both profiles read the same tracker', () => {
    const r = moveMilestone({ from, to: side(), id: 'm1', fromTrackers: trackers.from, toTrackers: trackers.from, newId: () => `x${++n}` })
    expect(r.ok && r.pinned).toBe(0)
  })

  it('gives the milestone and its items new ids when the target already uses them', () => {
    const r = run(side({ milestones: [pieces('m1', [])], inbox: [item('own')] }))
    if (!r.ok) throw new Error('not moved')
    expect(r.milestone.id).not.toBe('m1')
    expect(r.to.milestones.map((m) => m.id)).toEqual(['m1', r.milestone.id])
    const own = r.to.inbox.filter((i) => i.title === 'own')
    expect(own).toHaveLength(2)
    expect(r.milestone.source.kind === 'items' && r.milestone.source.items[0]).toEqual({ kind: 'task', itemId: own[1]!.id, weight: 5 })
  })

  it('pins a tracker query and refuses an unknown milestone', () => {
    const q = side({ milestones: [{ id: 'q', name: 'q', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: 'project = PAY' } }] })
    const r = moveMilestone({ from: q, to: side(), id: 'q', fromTrackers: trackers.from, toTrackers: trackers.to, newId: () => 'z' })
    expect(r.ok && r.milestone.source).toEqual({ kind: 'tracker', query: 'project = PAY', connectionId: 'jira-a' })
    expect(moveMilestone({ from: q, to: side(), id: 'nope', fromTrackers: trackers.from, toTrackers: trackers.to, newId: () => 'z' })).toEqual({ ok: false, reason: 'unknown' })
  })

  it('previews the same counts without changing anything', () => {
    expect(moveMilestonePreview({ from, to: side(), id: 'm1', fromTrackers: trackers.from, toTrackers: trackers.to })).toEqual({ moved: 2, copied: 1, pinned: 2 })
    expect(moveMilestonePreview({ from, to: side(), id: 'nope', fromTrackers: trackers.from, toTrackers: trackers.to })).toBeNull()
  })
})
