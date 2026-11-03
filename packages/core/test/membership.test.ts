import { describe, expect, it } from 'vitest'
import { assignProblem, groupByMilestone, milestoneHasItem, milestonesOfItem, withItem, withoutItem, type InboxItem, type Milestone, type MilestonePiece } from '../src'

const pieces = (id: string, items: MilestonePiece[]): Milestone => ({ id, name: id, start: '2026-11-01', end: '2026-11-30', source: { kind: 'items', items } })
const typed: Milestone = { id: 'typed', name: 'typed', start: '2026-11-01', end: '2026-11-30', source: { kind: 'manual', progress: 40 } }
const task = (id: string, key?: string): Pick<InboxItem, 'id' | 'ticket'> => ({ id, ...(key ? { ticket: { key } } : {}) }) as Pick<InboxItem, 'id' | 'ticket'>

describe('milestone membership', () => {
  const launch = pieces('launch', [{ kind: 'task', itemId: 'a', weight: 5 }, { kind: 'ticket', key: 'ABC-1', weight: 3 }])
  const docs = pieces('docs', [{ kind: 'task', itemId: 'a', weight: 2 }])

  it('finds an item by its task piece or by its ticket, never in a typed milestone', () => {
    expect(milestoneHasItem(launch, task('a'))).toBe(true)
    expect(milestoneHasItem(launch, task('b', 'ABC-1'))).toBe(true)
    expect(milestoneHasItem(launch, task('b'))).toBe(false)
    expect(milestoneHasItem(typed, task('a'))).toBe(false)
    expect(milestonesOfItem(task('a'), [launch, typed, docs]).map((m) => m.id)).toEqual(['launch', 'docs'])
  })

  it('adds an item as a task piece of the default weight once, and takes it (and its ticket) out', () => {
    const added = withItem(docs, task('c'))
    expect(added.source).toEqual({ kind: 'items', items: [{ kind: 'task', itemId: 'a', weight: 2 }, { kind: 'task', itemId: 'c', weight: 5 }] })
    expect(withItem(added, task('c'))).toBe(added)
    expect(withoutItem(launch, task('b', 'ABC-1')).source).toEqual({ kind: 'items', items: [{ kind: 'task', itemId: 'a', weight: 5 }] })
    expect(withoutItem(docs, task('z'))).toBe(docs)
  })

  it('only takes items in a milestone made of pieces with room left', () => {
    expect(assignProblem(launch)).toBeNull()
    expect(assignProblem(typed)).toBe('notPieces')
    expect(withItem(typed, task('a'))).toBe(typed)
    const full = pieces('full', Array.from({ length: 100 }, (_, i) => ({ kind: 'task' as const, itemId: `t${i}`, weight: 1 })))
    expect(assignProblem(full)).toBe('full')
  })

  it('groups items by milestone (in both when in two) and keeps the rest loose', () => {
    const rows = [{ m: launch }, { m: typed }, { m: docs }]
    const g = groupByMilestone([task('a'), task('b', 'ABC-1'), task('c')], rows, (r) => r.m)
    expect(g.groups.map((x) => [x.milestone.m.id, x.items.map((i) => i.id)])).toEqual([
      ['launch', ['a', 'b']],
      ['docs', ['a']]
    ])
    expect(g.loose.map((i) => i.id)).toEqual(['c'])
  })
})
