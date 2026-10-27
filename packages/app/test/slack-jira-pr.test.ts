import { describe, expect, it } from 'vitest'
import type { PullRequestDetail, PullRequestItem, TicketDetail } from '@workhub/core'
import { applyNarrowing, baseGroup, clearNarrowing, isNarrowed, narrowOptions, NO_NARROWING, ticketCounts, toggleValue } from '../src/renderer/lib/prNarrowing'
import { conversationTimeline } from '../src/renderer/lib/pullRequests'
import { trackInput } from '../src/renderer/lib/slackLinks'
import { createTicketPreviews, PREVIEW_TTL_MS } from '../src/renderer/lib/ticketPreview'

const item = (n: number, over: { repo?: string; base?: string; author?: string; updatedAt?: number; status?: PullRequestItem['status']; tickets?: string[] } = {}): PullRequestItem =>
  ({
    pr: { url: `https://github.com/acme/${over.repo ?? 'web'}/pull/${n}`, repo: over.repo ?? 'web', number: n, base: over.base ?? 'main', author: over.author ?? 'ana', updatedAt: over.updatedAt ?? n },
    status: over.status ?? 'waitingReview',
    stale: false,
    ticketKeys: over.tickets ?? []
  }) as unknown as PullRequestItem

describe('PR narrowing bar', () => {
  const items = [
    item(1, { repo: 'web', base: 'master', updatedAt: 10, tickets: ['A-1'] }),
    item(2, { repo: 'api', base: 'develop', author: 'luis', updatedAt: 30 }),
    item(3, { repo: 'web', base: 'main', status: 'approved', updatedAt: 20 })
  ]

  it('groups main with master and develop with dev', () => {
    expect(baseGroup('main')).toBe(baseGroup('master'))
    expect(baseGroup('dev')).toBe('develop')
    expect(baseGroup('feature/x')).toBe('feature/x')
  })

  it('counts each option, most common first', () => {
    expect(narrowOptions(items, 'repos')).toEqual([
      { value: 'web', count: 2 },
      { value: 'api', count: 1 }
    ])
    expect(narrowOptions(items, 'bases')[0]).toEqual({ value: 'master / main', count: 2 })
    expect(ticketCounts(items)).toEqual({ any: 3, with: 1, without: 2 })
  })

  it('filters by every field together and orders the result', () => {
    expect(applyNarrowing(items, NO_NARROWING).map((i) => i.pr.number)).toEqual([2, 3, 1])
    expect(applyNarrowing(items, { ...NO_NARROWING, order: 'oldest' }).map((i) => i.pr.number)).toEqual([1, 3, 2])
    expect(applyNarrowing(items, { ...NO_NARROWING, order: 'repo' }).map((i) => i.pr.number)).toEqual([2, 1, 3])
    const web = toggleValue(NO_NARROWING, 'repos', 'web')
    expect(applyNarrowing(items, web).map((i) => i.pr.number)).toEqual([3, 1])
    expect(applyNarrowing(items, { ...web, ticket: 'without' }).map((i) => i.pr.number)).toEqual([3])
    expect(applyNarrowing(items, toggleValue(NO_NARROWING, 'statuses', 'approved')).map((i) => i.pr.number)).toEqual([3])
  })

  it('toggles values and clears the filters but keeps the order', () => {
    const on = toggleValue(toggleValue(NO_NARROWING, 'authors', 'ana'), 'authors', 'luis')
    expect(on.authors).toEqual(['ana', 'luis'])
    expect(toggleValue(on, 'authors', 'ana').authors).toEqual(['luis'])
    expect(isNarrowed(on)).toBe(true)
    const cleared = clearNarrowing({ ...on, order: 'repo', ticket: 'with' })
    expect(cleared).toEqual({ ...NO_NARROWING, order: 'repo' })
    expect(isNarrowed(cleared)).toBe(false)
  })
})

describe('PR conversation timeline', () => {
  it('orders comments, reviews worth showing and code threads by time', () => {
    const detail = {
      comments: [{ id: '1', author: 'ana', isBot: false, body: 'hi', createdAt: 30 }],
      reviews: [
        { id: 'a', author: 'luis', isBot: false, state: 'approved', body: '', submittedAt: 40 },
        { id: 'b', author: 'luis', isBot: false, state: 'commented', body: '', submittedAt: 15 },
        { id: 'c', author: 'eva', isBot: false, state: 'commented', body: 'nit', submittedAt: 10 }
      ],
      threads: [
        { id: 't1', path: 'a.ts', line: 3, comments: [{ id: 'x', author: 'eva', isBot: false, body: 'why?', path: 'a.ts', createdAt: 20 }] },
        { id: 't2', path: 'b.ts', comments: [] }
      ]
    } as unknown as PullRequestDetail
    expect(conversationTimeline(detail).map((e) => e.id)).toEqual(['rc', 'tt1', 'c1', 'ra'])
  })
})

describe('Track a Slack link', () => {
  it('trims the fields, leaves out empty ones and wakes only with a session', () => {
    expect(trackInput({ permalink: ' https://a.slack.com/archives/C1/p1 ', title: ' ', prUrl: '', ticketKey: ' abc-12 ', sessionId: '', wake: true })).toEqual({
      permalink: 'https://a.slack.com/archives/C1/p1',
      ticketKey: 'ABC-12'
    })
    expect(trackInput({ permalink: 'x', title: 'SNS', prUrl: 'https://github.com/a/b/pull/1', ticketKey: '', sessionId: 's1', wake: true })).toEqual({
      permalink: 'x',
      title: 'SNS',
      prUrl: 'https://github.com/a/b/pull/1',
      sessionId: 's1',
      wake: true
    })
  })
})

describe('ticket chip previews', () => {
  const ticket = { key: 'A-1', title: 'Retry webhooks', status: 'In progress', category: 'inProgress' } as TicketDetail

  it('reads a ticket once while fresh, sharing a read in flight, and again after the TTL', async () => {
    let clock = 0
    let reads = 0
    const previews = createTicketPreviews(async () => (reads++, { ok: true, value: ticket }), () => clock)
    const [a, b] = await Promise.all([previews.load('p', 'A-1'), previews.load('p', 'a-1')])
    expect(a).toEqual({ state: 'ready', detail: ticket })
    expect(b).toBe(a)
    expect(previews.peek('p', 'A-1')).toEqual(a)
    expect(reads).toBe(1)
    clock = PREVIEW_TTL_MS + 1
    expect(previews.peek('p', 'A-1')).toBeUndefined()
    await previews.load('p', 'A-1')
    expect(reads).toBe(2)
  })

  it('reports missing tickets and does not keep failures', async () => {
    let fail = true
    const previews = createTicketPreviews(async () => (fail ? { ok: false, error: 'offline' } : { ok: true, value: null }))
    expect(await previews.load('p', 'B-2')).toEqual({ state: 'error', message: 'offline' })
    fail = false
    expect(await previews.load('p', 'B-2')).toEqual({ state: 'missing' })
    const throwing = createTicketPreviews(async () => Promise.reject(new Error('boom')))
    expect(await throwing.load('p', 'C-3')).toEqual({ state: 'error', message: 'boom' })
  })
})
