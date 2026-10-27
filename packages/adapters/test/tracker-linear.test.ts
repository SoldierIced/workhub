import { describe, expect, it } from 'vitest'
import { groupBySprint, type TicketDetail } from '@workhub/core'
import { LinearTracker, linearCategory } from '../src/tracker-linear'
import type { HttpClient, HttpRequest } from '../src/shared/http'

const NOW = Date.parse('2026-10-27T12:00:00Z')

/** A fake Linear: the answer is picked by a fragment of the GraphQL text; every request is recorded. */
function fakeLinear(answers: [string, (variables: any) => unknown | { status: number; raw?: unknown }][]) {
  const calls: { req: HttpRequest; query: string; variables: any }[] = []
  const http: HttpClient = async (req) => {
    const body = JSON.parse(req.body!)
    calls.push({ req, query: body.query, variables: body.variables })
    const hit = answers.find(([fragment]) => body.query.includes(fragment))
    if (!hit) return { status: 200, text: JSON.stringify({ errors: [{ message: 'unexpected query' }] }) }
    const out = hit[1](body.variables) as any
    if (out && typeof out === 'object' && 'status' in out) return { status: out.status, text: JSON.stringify(out.raw ?? {}) }
    return { status: 200, text: JSON.stringify(out) }
  }
  return { http, calls, tracker: new LinearTracker({ apiKey: 'lin_api_test', http, now: () => NOW }) }
}

const node = (identifier: string, state: { name: string; type: string }, extra: Record<string, unknown> = {}) => ({
  identifier, title: `Title of ${identifier}`, url: `https://linear.example.com/t/${identifier}`, priorityLabel: 'High', state, assignee: { name: 'Dana Test' }, cycle: null, ...extra
})

describe('LinearTracker', () => {
  it('maps state types to categories', () => {
    expect(['backlog', 'unstarted', 'started', 'completed', 'canceled'].map(linearCategory)).toEqual(['todo', 'todo', 'inProgress', 'done', 'done'])
  })

  it('tests the connection with the API key as the Authorization header', async () => {
    const { tracker, calls } = fakeLinear([['viewer { name email }', () => ({ data: { viewer: { name: 'Dana Test', email: 'd@example.com' } } })]])
    expect(await tracker.testConnection()).toEqual({ ok: true, account: 'Dana Test' })
    expect(calls[0]!.req.headers['Authorization']).toBe('lin_api_test')
    expect(calls[0]!.req.url).toBe('https://api.linear.app/graphql')
  })

  it('reports a rejected key and GraphQL errors', async () => {
    const bad = fakeLinear([['viewer', () => ({ status: 401 })]])
    expect(await bad.tracker.testConnection()).toEqual({ ok: false, error: 'Linear rejected the API key' })
    const gql = fakeLinear([['viewer', () => ({ errors: [{ message: 'Rate limited' }] })]])
    expect(await gql.tracker.testConnection()).toEqual({ ok: false, error: 'Rate limited' })
  })

  it('lists assigned tickets with their cycle as the sprint and hides ignored statuses', async () => {
    const { tracker } = fakeLinear([
      [
        'assignedIssues',
        () => ({
          data: {
            viewer: {
              assignedIssues: {
                nodes: [
                  node('ENG-1', { name: 'In Progress', type: 'started' }, { description: 'PR: https://github.com/example/app/pull/9', comments: { nodes: [{ body: 'see https://github.com/example/app/pull/9/files' }] }, cycle: { id: 'c1', name: null, number: 12, startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-03T00:00:00Z', isActive: true } }),
                  node('ENG-2', { name: 'Todo', type: 'unstarted' }, { cycle: { id: 'c2', name: 'Autumn', number: 13, startsAt: '2026-11-03T00:00:00Z', endsAt: '2026-11-17T00:00:00Z', isActive: false } }),
                  node('ENG-3', { name: 'Todo', type: 'unstarted' }, { cycle: { id: 'c0', name: 'Old', number: 11, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-15T00:00:00Z', isActive: false } }),
                  node('ENG-4', { name: 'Blocked', type: 'started' })
                ]
              }
            }
          }
        })
      ]
    ])
    const tickets = await tracker.listAssigned({ ignoredStatuses: ['blocked'] })
    expect(tickets.map((t) => [t.key, t.category, t.sprint?.name, t.sprint?.state])).toEqual([
      ['ENG-1', 'inProgress', 'Cycle 12', 'active'],
      ['ENG-2', 'todo', 'Autumn', 'future'],
      ['ENG-3', 'todo', undefined, undefined]
    ])
    expect(tickets[0]?.pullRequestUrls).toEqual(['https://github.com/example/app/pull/9'])
    expect(groupBySprint(tickets).map((g) => g.title)).toEqual(['Cycle 12', 'Autumn', 'Backlog'])
    expect(tickets[0]).toMatchObject({ provider: 'linear', url: 'https://linear.example.com/t/ENG-1', priority: 'High' })
  })

  it('reads the detail with comments oldest first', async () => {
    const { tracker } = fakeLinear([
      [
        'issue(id: $id) { id',
        (v) => ({
          data: {
            issue: {
              id: 'uuid-1', ...node(v.id, { name: 'In Review', type: 'started' }), description: 'Body with https://github.com/example/app/pull/3', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', creator: { name: 'Lee Test' },
              labels: { nodes: [{ name: 'api' }] }, parent: { identifier: 'ENG-0', title: 'Epic', state: { name: 'Started', type: 'started' } }, children: { nodes: [{ identifier: 'ENG-9', title: 'Sub', state: { name: 'Done', type: 'completed' } }] },
              comments: { nodes: [{ id: 'k2', body: 'second', createdAt: '2026-10-03T00:00:00Z', user: { name: 'Lee Test' } }, { id: 'k1', body: 'first', createdAt: '2026-10-02T00:00:00Z', user: null }] }
            }
          }
        })
      ]
    ])
    const d = (await tracker.getTicket('ENG-5')) as TicketDetail
    expect(d).toMatchObject({ key: 'ENG-5', status: 'In Review', reporter: 'Lee Test', labels: ['api'], description: 'Body with https://github.com/example/app/pull/3' })
    expect(d.comments.map((c) => c.body)).toEqual(['first', 'second'])
    expect(d.children[0]).toMatchObject({ key: 'ENG-9', category: 'done' })
    expect(d.parent?.key).toBe('ENG-0')
  })

  it('returns null when Linear does not know the key', async () => {
    const { tracker } = fakeLinear([['issue(id: $id)', () => ({ errors: [{ message: 'Entity not found: Issue' }] })]])
    expect(await tracker.getTicket('ENG-404')).toBeNull()
  })

  it('moves a ticket by resolving its id once', async () => {
    const { tracker, calls } = fakeLinear([
      ['team { states', () => ({ data: { issue: { team: { states: { nodes: [{ id: 's1', name: 'Todo', type: 'unstarted' }, { id: 's2', name: 'Done', type: 'completed' }] } } } } })],
      ['issue(id: $id) { id }', () => ({ data: { issue: { id: 'uuid-9' } } })],
      ['issueUpdate', () => ({ data: { issueUpdate: { success: true } } })]
    ])
    expect((await tracker.transitions('ENG-9')).map((t) => [t.id, t.category])).toEqual([['s1', 'todo'], ['s2', 'done']])
    await tracker.transition('ENG-9', 's2')
    await tracker.transition('ENG-9', 's1')
    const updates = calls.filter((c) => c.query.includes('issueUpdate'))
    expect(updates.map((c) => c.variables)).toEqual([{ id: 'uuid-9', input: { stateId: 's2' } }, { id: 'uuid-9', input: { stateId: 's1' } }])
    expect(calls.filter((c) => c.query.includes('issue(id: $id) { id }'))).toHaveLength(1)
  })

  it('comments and assigns, refusing an empty comment', async () => {
    const { tracker, calls } = fakeLinear([
      ['issue(id: $id) { id }', () => ({ data: { issue: { id: 'uuid-9' } } })],
      ['commentCreate', () => ({ data: { commentCreate: { success: true } } })],
      ['viewer { id }', () => ({ data: { viewer: { id: 'me-1' } } })],
      ['issueUpdate', () => ({ data: { issueUpdate: { success: true } } })]
    ])
    await tracker.addComment('ENG-9', ' Looks good ')
    await tracker.assignToMe('ENG-9')
    await expect(tracker.addComment('ENG-9', '  ')).rejects.toThrow('empty')
    expect(calls.find((c) => c.query.includes('commentCreate'))!.variables).toEqual({ input: { issueId: 'uuid-9', body: 'Looks good' } })
    expect(calls.find((c) => c.query.includes('issueUpdate'))!.variables.input).toEqual({ assigneeId: 'me-1' })
  })

  it('recognizes its team keys and refuses a plain http endpoint', () => {
    const t = new LinearTracker({ apiKey: 'k', projectKeys: ['ENG'] })
    expect(t.isTicketKey('eng-4')).toBe(true)
    expect(t.isTicketKey('OPS-4')).toBe(false)
    expect(() => new LinearTracker({ apiKey: 'k', endpoint: 'http://linear.example.com' })).toThrow(/https/)
  })
})
