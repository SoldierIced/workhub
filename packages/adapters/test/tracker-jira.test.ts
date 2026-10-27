import { describe, expect, it } from 'vitest'
import { groupBySprint, listedPullRequests, type TicketDetail } from '@workhub/core'
import { JiraTracker, adfToText, normalizeJiraSite, textToAdf } from '../src/tracker-jira'
import type { HttpClient, HttpRequest } from '../src/shared/http'

type Handler = (req: HttpRequest, url: URL) => { status?: number; body?: unknown }

/** A fake Jira: handlers by "METHOD /path", every request recorded. */
function fakeJira(handlers: Record<string, Handler>) {
  const calls: { req: HttpRequest; url: URL }[] = []
  const http: HttpClient = async (req) => {
    const url = new URL(req.url)
    calls.push({ req, url })
    const handler = handlers[`${req.method} ${url.pathname}`]
    if (!handler) return { status: 404, text: JSON.stringify({ errorMessages: ['Not found'] }) }
    const r = handler(req, url)
    return { status: r.status ?? 200, text: r.body === undefined ? '' : JSON.stringify(r.body) }
  }
  return { http, calls }
}

const status = (name: string, key: string) => ({ name, statusCategory: { key } })
const issue = (key: string, st: ReturnType<typeof status>, extra: Record<string, unknown> = {}) => ({
  key,
  fields: { summary: `Summary of ${key}`, status: st, issuetype: { name: 'Task' }, priority: { name: 'High' }, assignee: { displayName: 'Dana Test' }, ...extra }
})

const FIELDS = [
  { id: 'summary', schema: { type: 'string' } },
  { id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }
]

const make = (handlers: Record<string, Handler>, over: Record<string, unknown> = {}) => {
  const fake = fakeJira(handlers)
  return { ...fake, tracker: new JiraTracker({ site: 'acme.example.com', email: 'dana@example.com', token: 'tok-123', http: fake.http, ...over }) }
}

describe('normalizeJiraSite', () => {
  it('adds https, drops paths and trailing slashes', () => {
    expect(normalizeJiraSite('acme.example.com/')).toBe('https://acme.example.com')
    expect(normalizeJiraSite('https://acme.example.com/jira/software/x')).toBe('https://acme.example.com')
  })
  it('refuses plain http except for localhost, and an empty site', () => {
    expect(() => normalizeJiraSite('http://acme.example.com')).toThrow(/https/)
    expect(normalizeJiraSite('http://localhost:8080')).toBe('http://localhost:8080')
    expect(() => normalizeJiraSite('  ')).toThrow()
  })
})

describe('JiraTracker.testConnection', () => {
  it('returns the display name and sends basic auth', async () => {
    const { tracker, calls } = make({ 'GET /rest/api/3/myself': () => ({ body: { displayName: 'Dana Test', accountId: 'acc-1' } }) })
    expect(await tracker.testConnection()).toEqual({ ok: true, account: 'Dana Test' })
    expect(calls[0]!.req.headers['Authorization']).toBe(`Basic ${Buffer.from('dana@example.com:tok-123').toString('base64')}`)
    expect(calls[0]!.url.origin).toBe('https://acme.example.com')
  })

  it('explains rejected credentials without leaking the token', async () => {
    const { tracker } = make({ 'GET /rest/api/3/myself': () => ({ status: 401 }) })
    const r = await tracker.testConnection()
    expect(r).toEqual({ ok: false, error: 'Jira rejected the email or API token' })
  })

  it('explains an unreachable site', async () => {
    const tracker = new JiraTracker({ site: 'acme.example.com', email: 'a@b.c', token: 't', http: async () => { throw new Error('boom') } })
    const r = await tracker.testConnection()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('Could not reach acme.example.com')
  })
})

describe('JiraTracker.listAssigned', () => {
  const search: Handler = () => ({
    body: {
      issues: [
        issue('ABC-1', status('In Progress', 'indeterminate'), {
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PR https://github.com/example/app/pull/4' }] }] },
          comment: { comments: [{ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://github.com/example/app/pull/5' } }] }] } }] },
          customfield_10020: [
            { id: 5, name: 'Sprint 5', state: 'closed' },
            { id: 7, name: 'Sprint 7', state: 'active', startDate: '2026-10-19T00:00:00Z' }
          ]
        }),
        issue('ABC-2', status('To Do', 'new'), { customfield_10020: [{ id: 8, name: 'Sprint 8', state: 'future', startDate: '2026-11-02T00:00:00Z' }] }),
        issue('ABC-3', status('To Do', 'new'), { customfield_10020: null }),
        { key: 'ABC-4', fields: {} }
      ]
    }
  })

  it('maps tickets and picks the open sprint', async () => {
    const { tracker } = make({ 'GET /rest/api/3/field': () => ({ body: FIELDS }), 'GET /rest/api/3/search/jql': search })
    const tickets = await tracker.listAssigned()
    expect(tickets.map((t) => [t.key, t.category, t.sprint?.name])).toEqual([
      ['ABC-1', 'inProgress', 'Sprint 7'],
      ['ABC-2', 'todo', 'Sprint 8'],
      ['ABC-3', 'todo', undefined]
    ])
    expect(tickets[0]?.pullRequestUrls).toEqual(['https://github.com/example/app/pull/4', 'https://github.com/example/app/pull/5'])
    expect(tickets[1]?.pullRequestUrls).toBeUndefined()
    expect(tickets[0]).toMatchObject({ provider: 'jira', url: 'https://acme.example.com/browse/ABC-1', assignee: 'Dana Test', type: 'Task', priority: 'High' })
    expect(groupBySprint(tickets).map((g) => g.title)).toEqual(['Sprint 7', 'Sprint 8', 'Backlog'])
  })

  it('asks for my open tickets, quotes the ignored statuses and the sprint field', async () => {
    const { tracker, calls } = make({ 'GET /rest/api/3/field': () => ({ body: FIELDS }), 'GET /rest/api/3/search/jql': search })
    await tracker.listAssigned({ ignoredStatuses: ['Blocked', 'Won"t Do', ' '] })
    const q = calls.find((c) => c.url.pathname.endsWith('/search/jql'))!.url.searchParams
    expect(q.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Blocked", "Won\\"t Do") ORDER BY updated DESC')
    expect(q.get('fields')).toContain('customfield_10020')
  })

  it('finds the sprint field once', async () => {
    const { tracker, calls } = make({ 'GET /rest/api/3/field': () => ({ body: FIELDS }), 'GET /rest/api/3/search/jql': search })
    await tracker.listAssigned()
    await tracker.listAssigned()
    expect(calls.filter((c) => c.url.pathname === '/rest/api/3/field')).toHaveLength(1)
  })

  it('falls back to the Agile API when the Sprint field is unknown', async () => {
    const { tracker, calls } = make({
      'GET /rest/api/3/field': () => ({ status: 403 }),
      'GET /rest/api/3/search/jql': () => ({ body: { issues: [issue('ABC-1', status('To Do', 'new')), issue('ABC-2', status('To Do', 'new')), issue('ABC-3', status('To Do', 'new'))] } }),
      'GET /rest/agile/1.0/issue/ABC-1': () => ({ body: { fields: { sprint: { id: 7, name: 'Sprint 7', state: 'active' } } } }),
      'GET /rest/agile/1.0/issue/ABC-2': () => ({ body: { fields: { sprint: { id: 3, name: 'Old', state: 'closed' } } } }),
      'GET /rest/agile/1.0/issue/ABC-3': () => ({ status: 400 })
    })
    const tickets = await tracker.listAssigned()
    expect(tickets.map((t) => t.sprint?.name)).toEqual(['Sprint 7', undefined, undefined])
    expect(calls.filter((c) => c.url.pathname.startsWith('/rest/agile'))).toHaveLength(3)
  })
})

describe('JiraTracker.getTicket', () => {
  const full = {
    ...issue('ABC-1', status('In Review', 'indeterminate')),
    fields: {
      ...issue('ABC-1', status('In Review', 'indeterminate')).fields,
      reporter: { displayName: 'Lee Test' },
      created: '2026-10-01T10:00:00.000+0000',
      updated: '2026-10-20T10:00:00.000+0000',
      labels: ['api'],
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fix it. PR ' }, { type: 'inlineCard', attrs: { url: 'https://github.com/example/app/pull/12' } }] }] },
      comment: { comments: [{ id: '10', author: { displayName: 'Lee Test' }, created: '2026-10-02T10:00:00.000+0000', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] } }] },
      parent: { key: 'ABC-0', fields: { summary: 'Epic', status: status('In Progress', 'indeterminate') } },
      subtasks: [{ key: 'ABC-9', fields: { summary: 'Sub', status: status('Done', 'done') } }]
    }
  }

  it('reads description, comments, parent and subtasks as plain text', async () => {
    const { tracker } = make({ 'GET /rest/api/3/issue/ABC-1': () => ({ body: full }) })
    const d = (await tracker.getTicket('ABC-1')) as TicketDetail
    expect(d).toMatchObject({ key: 'ABC-1', status: 'In Review', reporter: 'Lee Test', labels: ['api'], description: 'Fix it. PR https://github.com/example/app/pull/12' })
    expect(d.comments).toEqual([{ id: '10', author: 'Lee Test', createdAt: Date.parse('2026-10-02T10:00:00.000+0000'), body: 'Looks good' }])
    expect(d.parent).toEqual({ key: 'ABC-0', title: 'Epic', status: 'In Progress', category: 'inProgress' })
    expect(d.children).toEqual([{ key: 'ABC-9', title: 'Sub', status: 'Done', category: 'done' }])
    expect(listedPullRequests(d)).toEqual(['https://github.com/example/app/pull/12'])
  })

  it('returns null for an unknown key and rethrows other failures', async () => {
    const { tracker } = make({ 'GET /rest/api/3/issue/ABC-404': () => ({ status: 404 }), 'GET /rest/api/3/issue/ABC-500': () => ({ status: 500, body: { errorMessages: ['Boom'] } }) })
    expect(await tracker.getTicket('ABC-404')).toBeNull()
    await expect(tracker.getTicket('ABC-500')).rejects.toThrow('Boom')
  })
})

describe('JiraTracker actions', () => {
  it('lists and applies transitions', async () => {
    let posted: unknown
    const { tracker } = make({
      'GET /rest/api/3/issue/ABC-1/transitions': () => ({ body: { transitions: [{ id: '31', name: 'Start', to: status('In Progress', 'indeterminate') }, { id: '41', name: 'Finish', to: status('Done', 'done') }] } }),
      'POST /rest/api/3/issue/ABC-1/transitions': (req) => { posted = JSON.parse(req.body!); return { status: 204 } }
    })
    expect((await tracker.transitions('ABC-1')).map((t) => [t.id, t.status, t.category])).toEqual([['31', 'In Progress', 'inProgress'], ['41', 'Done', 'done']])
    await tracker.transition('ABC-1', '31')
    expect(posted).toEqual({ transition: { id: '31' } })
  })

  it('posts a comment as an ADF document and refuses an empty one', async () => {
    let posted: any
    const { tracker } = make({ 'POST /rest/api/3/issue/ABC-1/comment': (req) => { posted = JSON.parse(req.body!); return { status: 201, body: {} } } })
    await tracker.addComment('ABC-1', 'First line\nsecond line\n\nNew paragraph')
    expect(posted.body.content).toHaveLength(2)
    expect(posted.body.content[0].content.map((n: any) => n.type)).toEqual(['text', 'hardBreak', 'text'])
    await expect(tracker.addComment('ABC-1', '  \n ')).rejects.toThrow('empty')
  })

  it('assigns to the signed-in user, reading the account once', async () => {
    const puts: unknown[] = []
    const { tracker, calls } = make({
      'GET /rest/api/3/myself': () => ({ body: { accountId: 'acc-1' } }),
      'PUT /rest/api/3/issue/ABC-1/assignee': (req) => { puts.push(JSON.parse(req.body!)); return { status: 204 } }
    })
    await tracker.assignToMe('ABC-1')
    await tracker.assignToMe('ABC-1')
    expect(puts).toEqual([{ accountId: 'acc-1' }, { accountId: 'acc-1' }])
    expect(calls.filter((c) => c.url.pathname.endsWith('/myself'))).toHaveLength(1)
  })

  it('recognizes its project keys', () => {
    const { tracker } = make({}, { projectKeys: ['ABC'] })
    expect(tracker.isTicketKey('abc-12')).toBe(true)
    expect(tracker.isTicketKey('XYZ-12')).toBe(false)
  })
})

describe('ADF', () => {
  it('flattens lists, links, mentions and breaks', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two', marks: [{ type: 'link', attrs: { href: 'https://x.test/a' } }] }] }] }] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@dana' } }, { type: 'hardBreak' }, { type: 'text', text: 'bye' }] }
      ]
    }
    expect(adfToText(doc)).toBe('Title\n\n- one\n- two (https://x.test/a)\n\n@dana\nbye')
    expect(adfToText('plain')).toBe('plain')
    expect(adfToText(null)).toBe('')
  })

  it('builds comment documents', () => {
    expect(textToAdf('a\n\nb').content).toHaveLength(2)
    expect(textToAdf('  ').content).toHaveLength(0)
  })
})
