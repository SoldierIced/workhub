import { describe, expect, it } from 'vitest'
import { chooseFolderForPullRequest, historyForPullRequest, historyForTicket, repoSlugOfRemote, type HistoryEntry, type PullRequest } from '../src'

const pr: PullRequest = {
  provider: 'github',
  owner: 'Acme',
  repo: 'billing-api',
  number: 133,
  url: 'https://github.com/Acme/billing-api/pull/133',
  title: 'DEMO-230 Retry failed webhooks',
  author: 'me',
  branch: 'feat/demo-230-webhook-retry',
  base: 'main',
  state: 'open',
  isDraft: false,
  reviewDecision: 'none',
  ci: 'none',
  mergeable: 'mergeable',
  additions: 1,
  deletions: 1,
  changedFiles: 1
}

describe('repoSlugOfRemote', () => {
  it('reads https, scp-style and ssh remotes, case-insensitively and without .git', () => {
    expect(repoSlugOfRemote('https://github.com/Acme/billing-api.git')).toBe('acme/billing-api')
    expect(repoSlugOfRemote('git@github.com:Acme/billing-api.git')).toBe('acme/billing-api')
    expect(repoSlugOfRemote('ssh://git@gitlab.example.com:2222/group/sub/project.git')).toBe('group/sub/project')
    expect(repoSlugOfRemote('https://github.com/Acme/billing-api/')).toBe('acme/billing-api')
  })
  it('returns null for something that is not a host URL', () => {
    expect(repoSlugOfRemote('')).toBeNull()
    expect(repoSlugOfRemote('C:\\repos\\billing')).toBeNull()
    expect(repoSlugOfRemote('https://github.com/justone')).toBeNull()
  })
})

describe('chooseFolderForPullRequest', () => {
  const mine = { owner: pr.owner, repo: pr.repo, branch: pr.branch }
  const remote = 'git@github.com:acme/billing-api.git'
  it('prefers a checkout of the repository that is already on the PR branch', () => {
    const choice = chooseFolderForPullRequest(mine, [
      { path: '/w/other', remote: 'git@github.com:acme/other.git', branch: pr.branch },
      { path: '/w/billing', remote, branch: 'main' },
      { path: '/w/billing-wt', remote, branch: pr.branch }
    ])
    expect(choice).toEqual({ path: '/w/billing-wt', reason: 'branch' })
  })
  it('takes the repository checkout when none is on the branch', () => {
    expect(chooseFolderForPullRequest(mine, [{ path: '/w/x' }, { path: '/w/billing', remote, branch: 'main' }])).toEqual({ path: '/w/billing', reason: 'repo' })
  })
  it('falls back to a folder named like the repository, on either path separator', () => {
    expect(chooseFolderForPullRequest(mine, [{ path: '/w/x' }, { path: 'C:\\work\\Billing-API\\' }])).toEqual({ path: 'C:\\work\\Billing-API\\', reason: 'name' })
  })
  it('falls back to the first folder, and to none without folders', () => {
    expect(chooseFolderForPullRequest(mine, [{ path: '/w/x' }, { path: '/w/y' }])).toEqual({ path: '/w/x', reason: 'first' })
    expect(chooseFolderForPullRequest(mine, [])).toEqual({ path: null, reason: 'none' })
  })
})

const entry = (over: Partial<HistoryEntry> & { agentSessionId: string }): HistoryEntry => ({ agentId: 'claude', accountId: null, title: 'untitled', lastModified: 1, ...over })
const providers = [{ provider: 'jira', projectKeys: ['DEMO'] }]

describe('historyForPullRequest', () => {
  const entries = [
    entry({ agentSessionId: 'ticket', title: 'Work on DEMO-230 retries', lastModified: 10 }),
    entry({ agentSessionId: 'branch', gitBranch: pr.branch, lastModified: 20 }),
    entry({ agentSessionId: 'url', firstPrompt: `Review ${pr.url} please`, lastModified: 5 }),
    entry({ agentSessionId: 'shared', gitBranch: 'main', title: 'unrelated', lastModified: 30 }),
    entry({ agentSessionId: 'other', title: 'DEMO-999 something else', gitBranch: 'feat/other', lastModified: 40 })
  ]
  it('matches by URL, branch and ticket key, strongest reason first', () => {
    const links = historyForPullRequest(pr, entries, providers)
    expect(links.map((l) => [l.entry.agentSessionId, l.reason])).toEqual([
      ['url', 'url'],
      ['branch', 'branch'],
      ['ticket', 'ticket']
    ])
  })
  it('hides sessions that are open now and lists the same session once', () => {
    const skip = new Set(['claude\u0000branch'])
    const links = historyForPullRequest(pr, [...entries, entry({ agentSessionId: 'url', firstPrompt: pr.url, lastModified: 99 })], providers, skip)
    expect(links.map((l) => l.entry.agentSessionId)).toEqual(['url', 'ticket'])
    expect(links[0]!.entry.lastModified).toBe(99)
  })
  it('finds a self-hosted PR URL written in the prompt', () => {
    const own = { ...pr, url: 'https://git.example.com/acme/billing-api/pull/133', title: 'No key', branch: 'x' }
    const links = historyForPullRequest(own, [entry({ agentSessionId: 'a', title: 'see https://git.example.com/acme/billing-api/pull/133/files' })], [])
    expect(links.map((l) => l.reason)).toEqual(['url'])
  })
})

describe('historyForTicket', () => {
  it('matches the key in title, first prompt, folder or branch, newest first', () => {
    const found = historyForTicket(
      'DEMO-230',
      [
        entry({ agentSessionId: 'a', title: 'DEMO-230 fix', lastModified: 1 }),
        entry({ agentSessionId: 'b', gitBranch: 'feat/demo-230-x', lastModified: 3 }),
        entry({ agentSessionId: 'c', firstPrompt: 'about DEMO-230', lastModified: 2 }),
        entry({ agentSessionId: 'd', title: 'DEMO-2300' })
      ],
      providers
    )
    expect(found.map((e) => e.agentSessionId)).toEqual(['b', 'c', 'a'])
  })
})
