import { describe, expect, it } from 'vitest'
import { TrackerError } from '@workhub/core'
import { GitHubIssuesTracker, githubIssueCategory, githubIssueStatus, parseIssueKey } from '../src/tracker-github'
import { CliNotFoundError, type CliResult, type CliRunner } from '../src/shared/cli'

type Answer = CliResult | unknown
const ok = (value: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' })
const fail = (stderr: string, stdout = ''): CliResult => ({ code: 1, stdout, stderr })

/** A fake `gh`: the first answer whose predicate matches the joined arguments; every call is recorded. */
function fakeGh(answers: [string, (args: string[]) => Answer][]) {
  const calls: string[][] = []
  const run: CliRunner = async (command, args) => {
    expect(command).toBe('gh')
    calls.push(args)
    const hit = answers.find(([fragment]) => args.join(' ').includes(fragment))
    if (!hit) return fail('unexpected call')
    const out = hit[1](args)
    return typeof out === 'object' && out !== null && 'code' in out && 'stdout' in out ? (out as CliResult) : ok(out)
  }
  return { run, calls }
}

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  html_url: `https://github.com/acme/app/issues/${n}`,
  repository_url: 'https://api.github.com/repos/acme/app',
  state: 'open',
  assignee: { login: 'dana' },
  body: 'Fix in https://github.com/acme/app/pull/9',
  updated_at: `2026-10-${10 + n}T10:00:00Z`,
  ...extra
})

const field = (args: string[], name: string) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)

describe('GitHub Issues keys and statuses', () => {
  it('maps open, closed and the close reason', () => {
    expect(githubIssueCategory('open')).toBe('todo')
    expect(githubIssueCategory('CLOSED')).toBe('done')
    expect(githubIssueStatus('open')).toBe('Open')
    expect(githubIssueStatus('closed', 'completed')).toBe('Closed')
    expect(githubIssueStatus('closed', 'not_planned')).toBe('Closed (not planned)')
    expect(githubIssueStatus('CLOSED', 'DUPLICATE')).toBe('Closed (duplicate)')
  })

  it('parses owner/repo#N, bare #N with a repository, and issue URLs', () => {
    expect(parseIssueKey('Acme/App#12')).toEqual({ repo: 'acme/app', number: 12 })
    expect(parseIssueKey('#12')).toBeNull()
    expect(parseIssueKey('#12', 'acme/app')).toEqual({ repo: 'acme/app', number: 12 })
    expect(parseIssueKey('https://github.com/acme/app/issues/12')).toEqual({ repo: 'acme/app', number: 12 })
    expect(parseIssueKey('ABC-12')).toBeNull()
  })
})

describe('GitHubIssuesTracker', () => {
  it('tests the connection through the gh login, without a token', async () => {
    const { run, calls } = fakeGh([['auth token', () => ({ code: 0, stdout: 'x', stderr: '' })], ['user --jq', () => ({ code: 0, stdout: 'dana\n', stderr: '' })]])
    expect(await new GitHubIssuesTracker({ run }).testConnection()).toEqual({ ok: true, account: 'dana' })
    expect(calls[0]).toEqual(['auth', 'token'])
    const out = fakeGh([['auth token', () => fail('not logged in')]])
    expect((await new GitHubIssuesTracker({ run: out.run }).testConnection()).ok).toBe(false)
    const missing = new GitHubIssuesTracker({ run: async () => { throw new CliNotFoundError('gh') } })
    expect(await missing.testConnection()).toEqual({ ok: false, error: 'The GitHub CLI (gh) is not installed' })
  })

  it('lists my open issues for the listed repositories, skipping pull requests and hidden statuses', async () => {
    const { run, calls } = fakeGh([['search/issues', () => ({ items: [item(1), item(2, { pull_request: {} }), item(3, { state: 'closed' })] })]])
    const t = new GitHubIssuesTracker({ run, repositories: ['Acme/App', 'acme/api', 'bad repo'] })
    const list = await t.listAssigned()
    expect(list.map((x) => x.key)).toEqual(['acme/app#3', 'acme/app#1'])
    expect(list[1]).toMatchObject({ provider: 'github-issues', status: 'Open', category: 'todo', assignee: 'dana', pullRequestUrls: ['https://github.com/acme/app/pull/9'] })
    const args = calls[0]!
    expect(args.slice(0, 4)).toEqual(['api', '-X', 'GET', 'search/issues'])
    expect(field(args, 'q')).toBe('is:issue is:open assignee:@me repo:acme/app repo:acme/api')
    expect((await t.listAssigned({ ignoredStatuses: ['open'] })).map((x) => x.key)).toEqual(['acme/app#3'])
  })

  it('falls back to the repositories of the profile folders, and to everything', async () => {
    const a = fakeGh([['search/issues', () => ({ items: [] })]])
    await new GitHubIssuesTracker({ run: a.run, fallbackRepositories: async () => ['acme/web'] }).listAssigned()
    expect(field(a.calls[0]!, 'q')).toBe('is:issue is:open assignee:@me repo:acme/web')
    const b = fakeGh([['search/issues', () => ({ items: [] })]])
    await new GitHubIssuesTracker({ run: b.run }).listAssigned()
    expect(field(b.calls[0]!, 'q')).toBe('is:issue is:open assignee:@me')
  })

  it('reads the repositories in groups and the pages with a cap', async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => item(n * 100 + i, { html_url: `https://github.com/acme/app/issues/${n * 100 + i}` }))
    const { run, calls } = fakeGh([['search/issues', (args) => ({ items: page(Number(field(args, 'page'))) })]])
    const repos = Array.from({ length: 6 }, (_, i) => `acme/r${i}`)
    const list = await new GitHubIssuesTracker({ run, repositories: repos }).listAssigned()
    expect(list).toHaveLength(500)
    // 6 repositories are two groups (5 + 1); each group reads at most 5 pages of 100.
    expect(calls).toHaveLength(10)
    expect(field(calls[0]!, 'q')).toContain('repo:acme/r4')
    expect(field(calls[5]!, 'q')).toContain('repo:acme/r5')
  })

  it('reads an issue with its Markdown body and comments; unknown issues are null', async () => {
    const { run, calls } = fakeGh([
      ['repos/acme/app/issues/7/comments', () => [{ id: 11, user: { login: 'sam' }, created_at: '2026-10-02T10:00:00Z', body: 'Looks **good**' }]],
      ['repos/acme/app/issues/7', () => item(7, { body: '# Title\n\n- [ ] item', user: { login: 'kim' }, labels: [{ name: 'bug' }], created_at: '2026-10-01T10:00:00Z' })],
      ['repos/acme/app/issues/8', () => fail('gh: Not Found (HTTP 404)')]
    ])
    const t = new GitHubIssuesTracker({ run, repositories: ['acme/app'] })
    const d = await t.getTicket('#7')
    expect(d).toMatchObject({ key: 'acme/app#7', description: '# Title\n\n- [ ] item', reporter: 'kim', labels: ['bug'], children: [] })
    expect(d!.comments).toEqual([{ id: '11', author: 'sam', createdAt: Date.parse('2026-10-02T10:00:00Z'), body: 'Looks **good**' }])
    expect(calls.every((c) => c[0] === 'api')).toBe(true)
    expect(await t.getTicket('acme/app#8')).toBeNull()
    await expect(new GitHubIssuesTracker({ run }).getTicket('#7')).rejects.toThrow(TrackerError)
  })

  it('offers close and reopen as transitions and applies them', async () => {
    let state = 'open'
    const { run, calls } = fakeGh([['repos/acme/app/issues/5', (args) => (args.includes('PATCH') ? item(5) : item(5, { state }))]])
    const t = new GitHubIssuesTracker({ run })
    expect((await t.transitions('acme/app#5')).map((x) => [x.id, x.category])).toEqual([['close', 'done'], ['close-not-planned', 'done']])
    state = 'closed'
    expect(await t.transitions('acme/app#5')).toEqual([{ id: 'reopen', name: 'Reopen', status: 'Open', category: 'todo' }])
    await t.transition('acme/app#5', 'close-not-planned')
    const patch = calls.at(-1)!
    expect(patch).toContain('PATCH')
    expect([field(patch, 'state'), field(patch, 'state_reason')]).toEqual(['closed', 'not_planned'])
    await t.transition('acme/app#5', 'reopen')
    expect(field(calls.at(-1)!, 'state')).toBe('open')
    await expect(t.transition('acme/app#5', 'nope')).rejects.toThrow('Unknown transition')
  })

  it('comments and assigns without a shell, sending the text as a raw field', async () => {
    const { run, calls } = fakeGh([['user --jq', () => ({ code: 0, stdout: 'dana\n', stderr: '' })], ['issues/5', () => ({})]])
    const t = new GitHubIssuesTracker({ run })
    await t.addComment('acme/app#5', '  Done; see `x` $(rm -rf /)  ')
    expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/acme/app/issues/5/comments', '-f', 'body=Done; see `x` $(rm -rf /)'])
    await expect(t.addComment('acme/app#5', '   ')).rejects.toThrow('empty')
    await t.assignToMe('acme/app#5')
    expect(calls.at(-1)).toEqual(['api', '-X', 'POST', 'repos/acme/app/issues/5/assignees', '-f', 'assignees[]=dana'])
  })

  it('searches with GitHub syntax, scoped to the repositories unless the query names its own', async () => {
    const { run, calls } = fakeGh([['search/issues', () => ({ items: [item(1, { state: 'closed', state_reason: 'not_planned' })] })]])
    const t = new GitHubIssuesTracker({ run, repositories: ['acme/app'] })
    const found = await t.searchByQuery('milestone:"v1.0"', { limit: 10 })
    expect(found).toEqual([{ key: 'acme/app#1', title: 'Issue 1', status: 'Closed (not planned)', category: 'done', url: 'https://github.com/acme/app/issues/1', assignee: 'dana', updatedAt: Date.parse('2026-10-11T10:00:00Z') }])
    expect(field(calls[0]!, 'q')).toBe('is:issue milestone:"v1.0" repo:acme/app')
    await t.searchByQuery('org:acme label:bug')
    expect(field(calls[1]!, 'q')).toBe('is:issue org:acme label:bug')
    await expect(t.searchByQuery('  ')).rejects.toThrow(TrackerError)
  })

  it('returns the first assignee, null for nobody, and the created and updated times', async () => {
    const { run, calls } = fakeGh([
      [
        'search/issues',
        () => ({
          items: [
            item(1, { assignee: null, assignees: [{ login: 'lee' }, { login: 'sam' }], created_at: '2026-10-01T09:00:00Z' }),
            item(2, { assignee: null, assignees: [], created_at: '2026-10-02T09:00:00Z' })
          ]
        })
      ]
    ])
    const t = new GitHubIssuesTracker({ run, repositories: ['acme/app'] })
    const found = await t.searchByQuery('milestone:"v1.0"')
    const byKey = Object.fromEntries(found.map((x) => [x.key, x]))
    expect(byKey['acme/app#1']).toMatchObject({ assignee: 'lee', createdAt: Date.parse('2026-10-01T09:00:00Z'), updatedAt: Date.parse('2026-10-11T10:00:00Z') })
    expect(byKey['acme/app#2']!.assignee).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('reads tickets by key in one GraphQL request, leaving out unknown ones', async () => {
    const { run, calls } = fakeGh([
      [
        'graphql',
        () => fail('Could not resolve', JSON.stringify({ data: { i0: { issue: { title: 'One', url: 'https://github.com/acme/app/issues/1', state: 'OPEN', stateReason: null, createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-20T10:30:00Z', assignees: { nodes: [{ login: 'dana' }] } } }, i1: { issue: null }, i2: { issue: { title: 'Three', url: 'https://github.com/acme/api/issues/3', state: 'CLOSED', stateReason: 'NOT_PLANNED', createdAt: '2026-10-02T09:00:00Z', updatedAt: '2026-10-03T09:00:00Z', assignees: { nodes: [] } } } } }))
      ]
    ])
    const t = new GitHubIssuesTracker({ run, repositories: ['acme/app'] })
    const got = await t.readTickets(['#1', 'acme/app#2', 'Acme/API#3', 'ABC-4', '#1'])
    expect(got).toEqual([
      { key: 'acme/app#1', title: 'One', status: 'Open', category: 'todo', url: 'https://github.com/acme/app/issues/1', assignee: 'dana', createdAt: Date.parse('2026-10-01T09:00:00Z'), updatedAt: Date.parse('2026-10-20T10:30:00Z') },
      { key: 'acme/api#3', title: 'Three', status: 'Closed (not planned)', category: 'done', url: 'https://github.com/acme/api/issues/3', assignee: null, createdAt: Date.parse('2026-10-02T09:00:00Z'), updatedAt: Date.parse('2026-10-03T09:00:00Z') }
    ])
    expect(calls).toHaveLength(1)
    const query = field(calls[0]!, 'query')!
    expect(query).toContain('repository(owner: "acme", name: "app") { issue(number: 1)')
    for (const f of ['createdAt', 'updatedAt', 'assignees']) expect(query).toContain(f)
    expect(await new GitHubIssuesTracker({ run: fakeGh([]).run }).readTickets(['ABC-1'])).toEqual([])
  })

  it('creates an issue in owner/repo, or in the only repository in scope', async () => {
    const { run, calls } = fakeGh([['repos/acme/app/issues', () => ({ number: 42, html_url: 'https://github.com/acme/app/issues/42' })]])
    const t = new GitHubIssuesTracker({ run, repositories: ['acme/app'] })
    expect(await t.createIssue({ project: '', title: ' Add export ', description: 'Details', priority: 1, labels: ['bug', ' '] })).toEqual({ key: 'acme/app#42', url: 'https://github.com/acme/app/issues/42' })
    expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/acme/app/issues', '-f', 'title=Add export', '-f', 'body=Details', '-f', 'labels[]=bug'])
    await expect(new GitHubIssuesTracker({ run }).createIssue({ project: '', title: 'x', description: '' })).rejects.toThrow('No GitHub repository')
    await expect(t.createIssue({ project: 'acme/app', title: ' ', description: '' })).rejects.toThrow('title is empty')
  })

  it('passes --hostname for GitHub Enterprise and reports a missing gh', async () => {
    const { run, calls } = fakeGh([['search/issues', () => ({ items: [] })]])
    await new GitHubIssuesTracker({ run, host: 'git.example.com' }).listAssigned()
    expect(calls[0]!.slice(0, 3)).toEqual(['api', '--hostname', 'git.example.com'])
    const gone = new GitHubIssuesTracker({ run: async () => { throw new CliNotFoundError('gh') } })
    await expect(gone.listAssigned()).rejects.toThrow('not installed')
  })
})

describe('GitHub Issues queryUrl', () => {
  const never: CliRunner = async () => fail('no call expected')
  const q = (url: string | undefined) => new URL(url!).searchParams.get('q')

  it('opens the issue search limited to the repositories in scope, as the count does', async () => {
    const url = await new GitHubIssuesTracker({ run: never, repositories: ['Acme/App', 'acme/api'] }).queryUrl('milestone:"v1" label:bug')
    expect(url!.startsWith('https://github.com/search?')).toBe(true)
    expect(new URL(url!).searchParams.get('type')).toBe('issues')
    expect(q(url)).toBe('is:issue milestone:"v1" label:bug repo:acme/app repo:acme/api')
  })

  it('leaves the scope out when the query names its own, and uses the enterprise host', async () => {
    const url = await new GitHubIssuesTracker({ run: never, host: 'git.example.com', repositories: ['acme/app'] }).queryUrl('repo:acme/other milestone:"v1"')
    expect(url!.startsWith('https://git.example.com/search?')).toBe(true)
    expect(q(url)).toBe('is:issue repo:acme/other milestone:"v1"')
  })

  it('reads the fallback repositories, and gives none for an empty query, too many repositories, or repositories that cannot be read', async () => {
    const fallback = new GitHubIssuesTracker({ run: never, fallbackRepositories: async () => ['acme/app'] })
    expect(q(await fallback.queryUrl('label:bug'))).toBe('is:issue label:bug repo:acme/app')
    expect(await fallback.queryUrl('  ')).toBeUndefined()
    const many = new GitHubIssuesTracker({ run: never, repositories: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'] })
    expect(await many.queryUrl('label:bug')).toBeUndefined()
    const none = new GitHubIssuesTracker({ run: never, fallbackRepositories: async () => { throw new Error('boom') } })
    expect(await none.queryUrl('label:bug')).toBeUndefined()
    const unscoped = new GitHubIssuesTracker({ run: never })
    expect(q(await unscoped.queryUrl('label:bug'))).toBe('is:issue label:bug')
  })
})
