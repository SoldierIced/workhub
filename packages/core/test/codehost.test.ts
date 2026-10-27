import { describe, expect, it } from 'vitest'
import {
  canonicalUrl,
  classifyPullRequest,
  CodeHostError,
  diffFileFromHunks,
  extractTicketKeys,
  findPullRequestRefs,
  githubRecognizer,
  githubScopeFromRemotes,
  gitlabProjectPath,
  gitlabRecognizer,
  isStale,
  itemsForFilter,
  loadMyPullRequests,
  loadPullRequestView,
  loadReviewQueue,
  parseUnifiedDiff,
  postComment,
  pullRequestsForSession,
  pullRequestsForTicket,
  reviewerStates,
  reviewRefusal,
  searchPullRequests,
  sessionsForPullRequest,
  submitReview,
  toItem,
  type CodeHost,
  type PullRequest,
  type PullRequestDetail
} from '../src'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 27)

export function pr(over: Partial<PullRequest> = {}): PullRequest {
  const number = over.number ?? 1
  return {
    provider: 'github',
    owner: 'acme',
    repo: 'api',
    number,
    url: `https://github.com/acme/api/pull/${number}`,
    title: 'Add widgets',
    author: 'ana',
    branch: 'feat/widgets',
    base: 'main',
    state: 'open',
    isDraft: false,
    reviewDecision: 'none',
    ci: 'success',
    mergeable: 'mergeable',
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    updatedAt: NOW - DAY,
    ...over
  }
}

function fakeHost(over: Partial<CodeHost> = {}): CodeHost & { calls: string[] } {
  const calls: string[] = []
  const detail = { ...pr(), body: '', labels: [], requestedReviewers: [], reviews: [], comments: [], threads: [], commits: [], checks: [] } as PullRequestDetail
  return {
    calls,
    provider: 'github',
    capabilities: { reviewActions: ['approve', 'requestChanges', 'comment'], replyToThread: true },
    recognizes: () => true,
    parseUrl: () => null,
    status: async () => ({ state: 'ready', login: 'me' }),
    listAuthored: async () => [pr({ number: 1, updatedAt: NOW - 40 * DAY }), pr({ number: 2, updatedAt: NOW - DAY })],
    listReviewRequested: async () => [pr({ number: 3, updatedAt: NOW - 3 * DAY }), pr({ number: 4, updatedAt: NOW - DAY })],
    detail: async () => detail,
    diff: async () => [],
    submitReview: async (_r, a, b) => void calls.push(`review:${a}:${b}`),
    comment: async (_r, b) => void calls.push(`comment:${b}`),
    replyToThread: async () => undefined,
    ...over
  }
}

describe('classifyPullRequest', () => {
  it('follows Workhub 1 priority: conflicts, CI, changes, draft, approved, running CI', () => {
    expect(classifyPullRequest(pr({ mergeable: 'conflicting', ci: 'failure' }))).toBe('conflicts')
    expect(classifyPullRequest(pr({ ci: 'failure', reviewDecision: 'changesRequested' }))).toBe('ciFailed')
    expect(classifyPullRequest(pr({ reviewDecision: 'changesRequested', isDraft: true }))).toBe('changesRequested')
    expect(classifyPullRequest(pr({ isDraft: true, reviewDecision: 'approved' }))).toBe('draft')
    expect(classifyPullRequest(pr({ reviewDecision: 'approved' }))).toBe('approved')
    expect(classifyPullRequest(pr({ ci: 'pending' }))).toBe('ciRunning')
    expect(classifyPullRequest(pr())).toBe('waitingReview')
    expect(classifyPullRequest(pr({ state: 'merged', ci: 'failure' }))).toBe('merged')
    expect(classifyPullRequest(pr({ state: 'closed' }))).toBe('closed')
  })
})

describe('lists and filters', () => {
  it('marks stale PRs of mine, sorts newest first and splits the filters', async () => {
    const host = fakeHost()
    const mine = await loadMyPullRequests(host, {}, NOW)
    const toReview = await loadReviewQueue(host, {}, NOW)
    expect(mine.map((i) => [i.pr.number, i.stale])).toEqual([[2, false], [1, true]])
    expect(toReview.map((i) => [i.pr.number, i.stale])).toEqual([[4, false], [3, false]])
    const lists = { mine, toReview }
    expect(itemsForFilter(lists, 'mine').map((i) => i.pr.number)).toEqual([2])
    expect(itemsForFilter(lists, 'stale').map((i) => i.pr.number)).toEqual([1])
    expect(itemsForFilter(lists, 'toReview').map((i) => i.pr.number)).toEqual([4, 3])
    expect(itemsForFilter(lists, 'all')).toHaveLength(4)
  })

  it('lists a PR once under "all" when it is both mine and waiting for me', () => {
    const a = toItem(pr(), NOW, { markStale: true })
    expect(itemsForFilter({ mine: [a], toReview: [a] }, 'all')).toHaveLength(1)
  })

  it('isStale needs an update time', () => {
    expect(isStale({ updatedAt: undefined }, NOW)).toBe(false)
    expect(isStale({ updatedAt: NOW - 31 * DAY }, NOW)).toBe(true)
    expect(isStale({ updatedAt: NOW - 29 * DAY }, NOW)).toBe(false)
  })

  it('searches title, name, author, branches and ticket keys', () => {
    const items = [
      toItem(pr({ number: 7, title: 'ABC-12 fix totals' }), NOW, { markStale: false }),
      toItem(pr({ number: 8, author: 'zoe', branch: 'chore/deps' }), NOW, { markStale: false })
    ]
    expect(searchPullRequests(items, 'abc-12').map((i) => i.pr.number)).toEqual([7])
    expect(searchPullRequests(items, 'ZOE').map((i) => i.pr.number)).toEqual([8])
    expect(searchPullRequests(items, 'api#8').map((i) => i.pr.number)).toEqual([8])
    expect(searchPullRequests(items, '')).toHaveLength(2)
  })
})

describe('review rules', () => {
  const all = { reviewActions: ['approve', 'requestChanges', 'comment'], replyToThread: true } as const
  it('refuses own PRs, unsupported verdicts and empty bodies', () => {
    expect(reviewRefusal(all, 'approve', '', true)).toBe('ownPullRequest')
    expect(reviewRefusal(all, 'comment', 'hi', true)).toBeNull()
    expect(reviewRefusal(all, 'approve', '', false)).toBeNull()
    expect(reviewRefusal(all, 'requestChanges', '  ', false)).toBe('bodyRequired')
    expect(reviewRefusal({ reviewActions: ['approve', 'comment'], replyToThread: false }, 'requestChanges', 'x', false)).toBe('unsupported')
  })

  it('sends accepted reviews trimmed and never reaches the host when refused', async () => {
    const host = fakeHost()
    const ref = pr()
    await submitReview(host, ref, 'requestChanges', '  fix this ', false)
    await postComment(host, ref, ' ok ')
    expect(host.calls).toEqual(['review:requestChanges:fix this', 'comment:ok'])
    await expect(submitReview(host, ref, 'approve', '', true)).rejects.toBeInstanceOf(CodeHostError)
    await expect(postComment(host, ref, ' ')).rejects.toBeInstanceOf(CodeHostError)
    expect(host.calls).toHaveLength(2)
  })
})

describe('loadPullRequestView', () => {
  it('keeps the conversation when the diff fails', async () => {
    const host = fakeHost({ diff: async () => Promise.reject(new CodeHostError('diff too large')) })
    const view = await loadPullRequestView(host, pr())
    expect(view.files).toBeNull()
    expect(view.filesError).toBe('diff too large')
    expect(view.detail.number).toBe(1)
  })

  it('fails when the detail fails', async () => {
    const host = fakeHost({ detail: async () => Promise.reject(new CodeHostError('gone')) })
    await expect(loadPullRequestView(host, pr())).rejects.toThrow('gone')
  })
})

describe('reviewerStates', () => {
  it('keeps each reviewer latest verdict and appends the ones still asked', () => {
    const states = reviewerStates({
      reviews: [
        { id: '1', author: 'bo', isBot: false, state: 'changesRequested', body: '', submittedAt: 1 },
        { id: '2', author: 'bo', isBot: false, state: 'approved', body: '', submittedAt: 2 },
        { id: '3', author: 'al', isBot: false, state: 'commented', body: '', submittedAt: 3 }
      ],
      requestedReviewers: ['cy', 'bo']
    })
    expect(states).toEqual([{ name: 'bo', state: 'approved' }, { name: 'cy', state: 'requested' }])
  })
})

describe('URL recognizers', () => {
  const gh = githubRecognizer()
  const gl = gitlabRecognizer()
  it('recognizes GitHub PR URLs, with /files, query and fragment', () => {
    expect(gh.parse('https://github.com/acme/api/pull/42/files?x=1#diff')).toEqual({
      provider: 'github', owner: 'acme', repo: 'api', number: 42, url: 'https://github.com/acme/api/pull/42'
    })
    expect(gh.parse('https://github.com/acme/api/issues/42')).toBeNull()
    expect(gh.parse('https://gitlab.com/acme/api/-/merge_requests/4')).toBeNull()
  })
  it('recognizes GitLab MRs in nested groups', () => {
    const ref = gl.parse('https://gitlab.com/acme/team/api/-/merge_requests/9/diffs')
    expect(ref).toEqual({ provider: 'gitlab', owner: 'acme/team', repo: 'api', number: 9, url: 'https://gitlab.com/acme/team/api/-/merge_requests/9' })
    expect(gitlabProjectPath(ref!)).toBe('acme%2Fteam%2Fapi')
    expect(gl.parse('https://github.com/acme/api/pull/4')).toBeNull()
  })
  it('supports self-hosted hosts', () => {
    expect(githubRecognizer('ghe.example.com').parse('https://ghe.example.com/a/b/pull/1')?.number).toBe(1)
    expect(githubRecognizer('ghe.example.com').parse('https://github.com/a/b/pull/1')).toBeNull()
    expect(gitlabRecognizer('git.example.com').parse('https://git.example.com/g/p/-/merge_requests/2')?.number).toBe(2)
  })
  it('finds every reference in a text once', () => {
    const text = 'see https://github.com/acme/api/pull/1, and https://github.com/acme/api/pull/1/files plus https://gitlab.com/g/p/-/merge_requests/3.'
    expect(findPullRequestRefs(text, [gh, gl]).map((r) => r.url)).toEqual([
      'https://github.com/acme/api/pull/1',
      'https://gitlab.com/g/p/-/merge_requests/3'
    ])
  })
  it('canonicalizes URLs for comparison', () => {
    expect(canonicalUrl('https://GitHub.com/Acme/Api/pull/1/files?x#y')).toBe('https://github.com/acme/api/pull/1')
  })
  it('derives a GitHub scope from git remotes', () => {
    expect(githubScopeFromRemotes(['git@github.com:acme/api.git', 'https://github.com/acme/web', 'git@gitlab.com:x/y.git', 'git@github.com:acme/api.git'])).toBe(
      'repo:acme/api repo:acme/web'
    )
    expect(githubScopeFromRemotes([])).toBe('')
  })
})

describe('links', () => {
  it('extracts ticket keys', () => {
    expect(extractTicketKeys('ABC-12 fix, see also XY2-7 and abc-1 and ABC-12')).toEqual(['ABC-12', 'XY2-7'])
  })
  it('links sessions by URL, then branch, then ticket key', () => {
    const p = pr({ title: 'ABC-5 add widgets', branch: 'feat/abc-5' })
    const links = sessionsForPullRequest(p, [
      { id: 'ticket', ticketKeys: ['ABC-5'] },
      { id: 'branch', branch: 'feat/abc-5' },
      { id: 'url', pullRequestUrls: ['https://github.com/Acme/API/pull/1/files'] },
      { id: 'none', branch: 'other', ticketKeys: ['ZZ-1'] }
    ])
    expect(links).toEqual([
      { sessionId: 'url', reason: 'url' },
      { sessionId: 'branch', reason: 'branch' },
      { sessionId: 'ticket', reason: 'ticket' }
    ])
  })
  it('never links by a shared long-lived branch', () => {
    expect(sessionsForPullRequest(pr({ branch: 'main' }), [{ id: 's', branch: 'main' }])).toEqual([])
  })
  it('finds PRs of a session and of a ticket', () => {
    const prs = [pr({ number: 1, title: 'ABC-5 a' }), pr({ number: 2, branch: 'feat/x', url: 'https://github.com/acme/api/pull/2' })]
    expect(pullRequestsForSession({ id: 's', branch: 'feat/x' }, prs).map((p) => p.number)).toEqual([2])
    expect(pullRequestsForTicket('ABC-5', prs, [{ provider: 'jira' }]).map((p) => p.number)).toEqual([1])
  })
})

describe('parseUnifiedDiff', () => {
  const text = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@ fn',
    ' keep',
    '-old',
    '+new',
    ' tail',
    '\\ No newline at end of file',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+-- two',
    'diff --git a/old.png b/new.png',
    'similarity index 100%',
    'rename from old.png',
    'rename to new.png',
    'Binary files a/old.png and b/new.png differ'
  ].join('\n')
  it('numbers lines and counts changes', () => {
    const [a, n, r] = parseUnifiedDiff(text)
    expect(a).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 })
    expect(a!.hunks[0]!.lines).toEqual([
      { kind: 'context', oldNumber: 1, newNumber: 1, text: 'keep' },
      { kind: 'removed', oldNumber: 2, text: 'old' },
      { kind: 'added', newNumber: 2, text: 'new' },
      { kind: 'context', oldNumber: 3, newNumber: 3, text: 'tail' }
    ])
    expect(n).toMatchObject({ path: 'new.txt', status: 'added', additions: 2 })
    expect(r).toMatchObject({ path: 'new.png', oldPath: 'old.png', status: 'renamed', binary: true })
  })
  it('builds a file from bare hunks', () => {
    const f = diffFileFromHunks({ path: 'a.ts', status: 'modified' }, '@@ -1 +1 @@\n-a\n+b\n')
    expect(f).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 })
  })
  it('returns nothing for text that is not a diff', () => {
    expect(parseUnifiedDiff('hello\nworld')).toEqual([])
  })
})
