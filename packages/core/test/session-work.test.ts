import { describe, expect, it } from 'vitest'
import {
  commandWorkPaths,
  noteWorkPath,
  resolveWorkPath,
  sessionSlackThreads,
  sessionWork,
  toolWorkPaths,
  type PullRequestItem,
  type TrackedThread
} from '../src'

const HOME = '/Users/ana'
const BASE = '/Users/ana/acme'

describe('where a session worked', () => {
  it('resolves home, relative and absolute paths, and refuses what is not a literal path', () => {
    expect(resolveWorkPath('~/acme/api', BASE, HOME)).toBe('/Users/ana/acme/api')
    expect(resolveWorkPath('../web/', `${BASE}/api`, HOME)).toBe('/Users/ana/acme/web')
    expect(resolveWorkPath('/srv//x/./y', undefined, HOME)).toBe('/srv/x/y')
    for (const raw of ['$dir', '%s', '-', '"$(pwd)"', '*', '~bob/x']) expect(resolveWorkPath(raw, BASE, HOME)).toBeUndefined()
    // A relative path needs a cwd to be placed.
    expect(resolveWorkPath('api', undefined, HOME)).toBeUndefined()
  })

  it('follows every cd and git -C of a command, quoted or not', () => {
    expect(commandWorkPaths('cd api && npm test; git -C "../web" status && cd \'~/x\'', BASE, HOME)).toEqual([`${BASE}/api`, `${BASE}/web`])
    expect(commandWorkPaths('for r in a b; do cd $r; done', BASE, HOME)).toEqual([])
    expect(commandWorkPaths('npm run abcd efg', BASE, HOME)).toEqual([])
  })

  it('counts edits, writes and cds, never reads', () => {
    expect(toolWorkPaths('Edit', { file_path: `${BASE}/api/src/a.ts` }, BASE, HOME)).toEqual([`${BASE}/api/src`])
    expect(toolWorkPaths('Write', { file_path: 'web/README.md' }, BASE, HOME)).toEqual([`${BASE}/web`])
    expect(toolWorkPaths('NotebookEdit', { notebook_path: '~/n/x.ipynb' }, BASE, HOME)).toEqual(['/Users/ana/n'])
    expect(toolWorkPaths('Bash', { command: 'cd ~/acme/api && git -C ../web log' }, BASE, HOME)).toEqual([`${BASE}/api`, `${BASE}/web`])
    expect(toolWorkPaths('Read', { file_path: `${BASE}/docs/x.md` }, BASE, HOME)).toEqual([])
    expect(toolWorkPaths('Grep', { path: `${BASE}/docs` }, BASE, HOME)).toEqual([])
  })

  it('keeps each folder once, the most recent last, within a limit', () => {
    const paths: string[] = []
    for (const p of ['/a', '/b', '/a', '/c', '/c', undefined]) noteWorkPath(paths, p)
    expect(paths).toEqual(['/b', '/a', '/c'])
    noteWorkPath(paths, '/d', 3)
    expect(paths).toEqual(['/a', '/c', '/d'])
  })
})

const item = (repo: string, number: number, branch: string, title = '', state: 'open' | 'merged' | 'closed' = 'open', owner = 'acme'): PullRequestItem =>
  ({
    pr: { provider: 'github', owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, branch, title, state },
    ticketKeys: [],
    status: 'waiting',
    stale: false
  }) as unknown as PullRequestItem

describe("a session's pull requests and tickets", () => {
  const items = [
    item('web', 1, 'feat/WAL-12-login', 'Login page'),
    item('api', 2, 'main', 'Release'),
    item('api', 3, 'feat/other', 'WAL-30 Old work', 'merged'),
    item('docs', 4, 'feat/WAL-12-login', 'Docs for the login'),
    item('payments', 5, 'feat/shared-ticket', 'WAL-12 Payments side'),
    item('payments', 6, 'feat/unrelated', 'OPS-1 Something else'),
    item('web', 1, 'feat/WAL-12-login', 'Login page')
  ]
  const repos = [
    { name: 'web', branch: 'feat/WAL-12-login', slug: 'acme/web' },
    { name: 'api', branch: 'main' },
    // A worktree: its folder is named after the branch, its remote says which repository it is.
    { name: 'api-fix', branch: 'feat/other', slug: 'acme/api' }
  ]

  it('takes the open PR of each branch it works on, then the PRs it named, then open PRs of its tickets', () => {
    const work = sessionWork({ items, mentionedPrs: ['https://github.com/acme/api/pull/3/files', 'https://github.com/owner/repo/pull/1'], repos, mentionedTickets: ['XYZ-9'], providers: [] })
    // web#1 by branch (once); api#3 named (merged still counts); docs#4 is on the branch but in another repo,
    // it comes in by its ticket like payments#5; api#2 is on a shared branch; payments#6 is another ticket.
    expect(work.prs.map((p) => `${p.pr.repo}#${p.pr.number}`)).toEqual(['web#1', 'api#3', 'docs#4', 'payments#5'])
    expect(work.ticketKeys).toEqual(['WAL-12', 'WAL-30', 'XYZ-9'])
  })

  it("keeps only the profile tracker's tickets, matching its keys in branches whatever their case", () => {
    const work = sessionWork({
      items: [],
      repos: [{ name: 'api', branch: 'feat/wal-77-fix' }],
      mentionedTickets: ['UTF-8', 'OPS-2', 'WAL-5', 'WAL-6', 'WAL-5'],
      providers: [{ provider: 'jira', projectKeys: ['WAL'] }]
    })
    // Newest mention first; OPS and UTF are not the profile's projects.
    expect(work.ticketKeys).toEqual(['WAL-77', 'WAL-5', 'WAL-6'])
  })

  it('finds nothing for a session that names nothing and works on shared branches', () => {
    expect(sessionWork({ items, repos: [{ name: 'api', branch: 'main' }] })).toEqual({ prs: [], ticketKeys: [] })
  })
})

const thread = (id: string, extra: Partial<TrackedThread>): TrackedThread =>
  ({ id, channelId: 'C1', ts: '1', permalink: '', title: id, wake: false, lastSeenReplyTs: '0', createdAt: 0, closed: false, seeded: true, replies: [], source: 'manual', sentTs: [], pendingWake: [], ...extra }) as TrackedThread

describe("a session's Slack threads", () => {
  it('lists the ones it owns, then open ones about its PRs or tickets', () => {
    const threads = [
      thread('owned-closed', { owner: 'me', closed: true }),
      thread('by-pr', { prUrl: 'https://github.com/acme/web/pull/1/' }),
      thread('by-ticket', { ticketKey: 'wal-12' }),
      thread('by-reply', { replies: [{ ts: '2', user: 'u', text: 'see <https://github.com/acme/web/pull/1>' }] as TrackedThread['replies'] }),
      thread('closed-pr', { prUrl: 'https://github.com/acme/web/pull/1', closed: true }),
      thread('other', { prUrl: 'https://github.com/acme/web/pull/9', owner: 'someone' })
    ]
    expect(sessionSlackThreads(threads, 'me', ['https://github.com/acme/web/pull/1'], ['WAL-12']).map((t) => t.id)).toEqual(['owned-closed', 'by-pr', 'by-ticket', 'by-reply'])
    expect(sessionSlackThreads(threads, 'me', [], []).map((t) => t.id)).toEqual(['owned-closed'])
  })
})
