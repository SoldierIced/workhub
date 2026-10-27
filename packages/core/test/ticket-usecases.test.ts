import { describe, expect, it } from 'vitest'
import {
  groupBySprint,
  listedPullRequests,
  pullRequestUrlsIn,
  pullRequestsForTicket,
  sessionsForTicket,
  ticketKeysOfSession,
  ticketsInProgress,
  withoutIgnoredStatuses,
  type Ticket
} from '../src'

const t = (key: string, over: Partial<Ticket> = {}): Ticket => ({ key, provider: 'jira', title: key, status: 'To Do', category: 'todo', ...over })
const active = { id: '20', name: 'Sprint 20', state: 'active' as const }
const next = { id: '21', name: 'Sprint 21', state: 'future' as const }
const later = { id: '9', name: 'Sprint 9', state: 'future' as const }
const jira = [{ provider: 'jira' }]

describe('ticket lists', () => {
  it('keeps the in-progress tickets', () => {
    const list = [t('A-1', { category: 'inProgress' }), t('A-2'), t('A-3', { category: 'done' })]
    expect(ticketsInProgress(list).map((x) => x.key)).toEqual(['A-1'])
  })

  it('groups the active sprint first, future sprints by id and the backlog last', () => {
    const groups = groupBySprint([t('A-1', { sprint: next }), t('A-2'), t('A-3', { sprint: active }), t('A-4', { sprint: later }), t('A-5', { sprint: active })])
    expect(groups.map((g) => [g.title, g.tickets.map((x) => x.key), g.isActive])).toEqual([
      ['Sprint 20', ['A-3', 'A-5'], true],
      ['Sprint 9', ['A-4'], false],
      ['Sprint 21', ['A-1'], false],
      ['Backlog', ['A-2'], false]
    ])
  })

  it('has no backlog group when every ticket has a sprint', () => {
    expect(groupBySprint([t('A-1', { sprint: active })]).map((g) => g.id)).toEqual(['20'])
    expect(groupBySprint([])).toEqual([])
  })

  it('hides ignored statuses regardless of case', () => {
    const list = [t('A-1', { status: 'Blocked' }), t('A-2', { status: 'In Review' })]
    expect(withoutIgnoredStatuses(list, [' blocked ', '']).map((x) => x.key)).toEqual(['A-2'])
    expect(withoutIgnoredStatuses(list, [])).toHaveLength(2)
  })
})

describe('sessions linked to a ticket', () => {
  const sessions = [
    { id: 's1', title: 'Work on ABC-12 login' },
    { id: 's2', cwd: '/work/app', gitBranch: 'feature/ABC-13-other' },
    { id: 's3', ticketKeys: ['abc-12'] },
    { id: 's4', title: 'unrelated', summary: 'no key here' }
  ]

  it('matches the monitor keys and the title, folder, branch and summary', () => {
    expect(sessionsForTicket('ABC-12', sessions, jira).map((s) => s.id)).toEqual(['s1', 's3'])
    expect(sessionsForTicket('ABC-13', sessions, jira).map((s) => s.id)).toEqual(['s2'])
  })

  it('lists the keys of one session without repeats', () => {
    expect(ticketKeysOfSession({ id: 'x', title: 'ABC-1 and ABC-2', ticketKeys: ['ABC-1'] }, jira)).toEqual(['ABC-1', 'ABC-2'])
  })
})

describe('pull requests linked to a ticket', () => {
  it('normalizes PR URLs in text and drops repeats', () => {
    const text = 'See https://github.com/Acme/Shop/pull/5/files and https://github.com/acme/shop/pull/5 plus https://gitlab.com/acme/shop/-/merge_requests/8'
    expect(pullRequestUrlsIn(text)).toEqual(['https://github.com/acme/shop/pull/5', 'https://gitlab.com/acme/shop/-/merge_requests/8'])
  })

  it('reads the PRs listed in description and comments', () => {
    const urls = listedPullRequests({ description: 'PR: https://github.com/a/b/pull/1', comments: [{ id: '1', author: 'x', body: 'also https://github.com/a/b/pull/2' }] })
    expect(urls).toEqual(['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2'])
  })

  it('matches a PR by key in title or branch, or because the ticket lists it', () => {
    const prs = [
      { url: 'https://github.com/a/b/pull/1', title: 'ABC-1 add thing' },
      { url: 'https://github.com/a/b/pull/2', branch: 'feat/ABC-1-more' },
      { url: 'https://github.com/a/b/pull/3', title: 'ABC-10 other' },
      { url: 'https://github.com/a/b/pull/4', title: 'release' }
    ]
    expect(pullRequestsForTicket('ABC-1', prs, jira, ['https://github.com/A/B/pull/4']).map((p) => p.url.slice(-1))).toEqual(['1', '2', '4'])
  })
})
