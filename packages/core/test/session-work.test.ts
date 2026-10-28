import { describe, expect, it } from 'vitest'
import {
  commandWorkPaths,
  noteWorkPath,
  resolveWorkPath,
  sessionPullRequestUrls,
  sessionSlackThreads,
  sessionWork,
  toolWorkPaths,
  type PullRequestItem,
  type TrackedThread
} from '../src'

const HOME = '/Users/ana'
const BASE = '/Users/ana/wayni'

describe('where a session worked', () => {
  it('resolves home, relative and absolute paths, and refuses what is not a literal path', () => {
    expect(resolveWorkPath('~/wayni/api', BASE, HOME)).toBe('/Users/ana/wayni/api')
    expect(resolveWorkPath('../web/', `${BASE}/api`, HOME)).toBe('/Users/ana/wayni/web')
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
    expect(toolWorkPaths('Bash', { command: 'cd ~/wayni/api && git -C ../web log' }, BASE, HOME)).toEqual([`${BASE}/api`, `${BASE}/web`])
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
    item('web', 1, 'feat/WAL-12-login', 'Login page'),
    item('web', 7, 'feat/WAL-40-someone', 'WAL-40 Someone else')
  ]
  const repos = [
    { name: 'web', root: `${BASE}/web`, branch: 'feat/WAL-12-login', slug: 'acme/web' },
    { name: 'api', root: `${BASE}/api`, branch: 'main' },
    // A worktree: its folder is named after the branch, its remote says which repository it is.
    { name: 'api-fix', root: `${BASE}/api-fix`, branch: 'feat/other', slug: 'acme/api' },
    // Touched (the session read it), on someone else's branch it never worked on.
    { name: 'payments', root: `${BASE}/payments`, branch: 'feat/WAL-55-theirs', slug: 'acme/payments' }
  ]

  it('takes the PRs it acted on and the one of the branch it pushed, then the ones the user named, then its replies', () => {
    const work = sessionWork({
      items,
      repos,
      links: [
        { source: 'reply', url: 'https://github.com/acme/web/pull/7' },
        { source: 'user', url: 'https://github.com/acme/api/pull/3/files' },
        // A number from a command in the api-fix folder: its remote is acme/api.
        { source: 'acted', number: 3, folder: `${BASE}/api-fix` },
        { source: 'user', number: 6, repo: 'payments' },
        { source: 'acted', url: 'https://github.com/owner/repo/pull/1' }
      ],
      // `git commit -q && git push` in web: its current branch.
      branches: [{ folder: `${BASE}/web/src`, pushed: true }],
      providers: []
    })
    // web#1 is the PR of the pushed branch (docs#4 shares the branch name in another repository);
    // api#3 acted on beats named; owner/repo#1 is not known; api#2 is on a shared branch; payments#5 only shares a ticket.
    expect(work.prs.map((p) => `${p.pr.repo}#${p.pr.number}`)).toEqual(['api#3', 'web#1', 'payments#6', 'web#7'])
    // The pushed branch's key; payments' branch is not the session's.
    expect(work.ticketKeys).toEqual(['WAL-12'])
  })

  it("keeps only the profile tracker's tickets, the ones changed first, then typed, then branches and replies", () => {
    const work = sessionWork({
      items: [],
      repos: [{ name: 'api', branch: 'feat/wal-77-fix' }],
      branches: [{ name: 'feat/wal-78-fix' }],
      linkedTickets: ['WAL-9'],
      mentionedTickets: ['UTF-8', 'OPS-2', 'WAL-5', 'WAL-6', 'WAL-5'],
      replyTickets: ['WAL-80', 'WAL-9'],
      titles: ['WAL-4: the name the user gave it'],
      providers: [{ provider: 'jira', projectKeys: ['WAL'] }]
    })
    // Newest mention first; OPS and UTF are not the profile's projects; the repo's own branch (wal-77) is not the session's.
    expect(work.ticketKeys).toEqual(['WAL-9', 'WAL-4', 'WAL-5', 'WAL-6', 'WAL-78', 'WAL-80'])
  })

  it('finds nothing in the branches of the repositories it touched or the open PRs of their repositories', () => {
    expect(sessionWork({ items, repos })).toEqual({ prs: [], ticketKeys: [] })
  })

  it('places a PR number of a prompt only when one repository it worked in has it', () => {
    const urls = (number: number) => sessionPullRequestUrls([{ source: 'user', number }], items, repos)
    expect(urls(7)).toEqual([{ url: 'https://github.com/acme/web/pull/7', source: 'user' }])
    // Not in a repository it worked in.
    expect(urls(4)).toEqual([])
    const twice = [...items, item('api', 7, 'feat/x')]
    expect(sessionPullRequestUrls([{ source: 'user', number: 7 }], twice, repos)).toEqual([])
    // A number from a command, outside the known lists: the folder's repository on GitHub.
    expect(sessionPullRequestUrls([{ source: 'acted', number: 99, folder: `${BASE}/web` }], items, repos)).toEqual([{ url: 'https://github.com/acme/web/pull/99', source: 'acted' }])
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
