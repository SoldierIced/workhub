import { loadMyPullRequests, loadPullRequestView, loadReviewQueue, submitReview, postComment, CodeHostError } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { createDemoRunner, DEMO_LOGIN, DEMO_PRS, GitHubCodeHost } from '../src/codehost-github'
import { mapDetail, mapSearchResponse, mapThreads } from '../src/codehost-github/mapping'
import { CliNotFoundError, parseJsonPages, type CliRunner } from '../src/shared/cli'

const NOW = Date.UTC(2026, 9, 27, 12)
const host = () => {
  const run = createDemoRunner(NOW)
  return { run, host: new GitHubCodeHost({ run }) }
}

describe('GitHubCodeHost lists', () => {
  it('reads my PRs and maps the domain enums', async () => {
    const { host: h, run } = host()
    const mine = await loadMyPullRequests(h, { scope: 'org:acme-demo' }, NOW)
    expect(mine).toHaveLength(6)
    const byNumber = Object.fromEntries(mine.map((i) => [i.pr.number, i]))
    expect(byNumber[482]).toMatchObject({ status: 'approved', pr: { ci: 'success', reviewDecision: 'approved', repo: 'storefront', owner: 'acme-demo' } })
    expect(byNumber[479]!.status).toBe('changesRequested')
    expect(byNumber[133]!.status).toBe('ciFailed')
    expect(byNumber[131]!.status).toBe('conflicts')
    expect(byNumber[57]!.status).toBe('draft')
    expect(byNumber[49]!.stale).toBe(true)
    expect(byNumber[482]!.ticketKeys).toEqual(['DEMO-212'])
    const search = run.calls.find((c) => c.includes('graphql'))!
    expect(search.some((a) => a.startsWith('q=is:pr is:open archived:false author:@me org:acme-demo'))).toBe(true)
  })

  it('reads the review queue with the review-requested qualifier', async () => {
    const { host: h, run } = host()
    const queue = await loadReviewQueue(h, {}, NOW)
    expect(queue.map((i) => i.pr.number)).toEqual([486, 484, 135, 60])
    expect(queue.every((i) => i.pr.author !== DEMO_LOGIN)).toBe(true)
    expect(run.calls[0]!.some((a) => a.includes('review-requested:@me'))).toBe(true)
  })

  it('ignores search nodes that are not pull requests', () => {
    const out = mapSearchResponse(JSON.stringify({ data: { search: { nodes: [{}, { number: 3, url: 'https://github.com/a/b/pull/3', repository: { name: 'b', owner: { login: 'a' } } }] } } }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ number: 3, ci: 'none', reviewDecision: 'none', mergeable: 'unknown', state: 'open' })
  })

  it('turns an unreadable answer into a CodeHostError', async () => {
    const run: CliRunner = async () => ({ code: 0, stdout: 'not json', stderr: '' })
    await expect(new GitHubCodeHost({ run }).listAuthored({})).rejects.toBeInstanceOf(CodeHostError)
  })
})

describe('GitHubCodeHost status', () => {
  it('is ready with the login', async () => {
    expect(await host().host.status()).toEqual({ state: 'ready', login: DEMO_LOGIN })
  })
  it('reports a missing CLI and a missing login', async () => {
    const missing: CliRunner = async (c) => Promise.reject(new CliNotFoundError(c))
    expect(await new GitHubCodeHost({ run: missing }).status()).toEqual({ state: 'missingCli', cli: 'gh' })
    const out: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'no oauth token' })
    expect(await new GitHubCodeHost({ run: out }).status()).toEqual({ state: 'signedOut', cli: 'gh' })
  })
  it('reports the error when the login cannot be read (offline)', async () => {
    const run: CliRunner = async (_c, args) => (args[0] === 'auth' ? { code: 0, stdout: 'tok', stderr: '' } : { code: 1, stdout: '', stderr: 'dial tcp: no route to host' })
    expect(await new GitHubCodeHost({ run }).status()).toEqual({ state: 'error', message: 'dial tcp: no route to host' })
  })
  it('throws missingCli from reads', async () => {
    const missing: CliRunner = async (c) => Promise.reject(new CliNotFoundError(c))
    await expect(new GitHubCodeHost({ run: missing }).listAuthored({})).rejects.toMatchObject({ kind: 'missingCli' })
  })
})

describe('GitHubCodeHost detail and diff', () => {
  it('maps a PR with reviews, checks, commits and threaded inline comments', async () => {
    const { host: h } = host()
    const ref = h.parseUrl(`https://github.com/acme-demo/storefront/pull/${DEMO_PRS[0]!.number}`)!
    const view = await loadPullRequestView(h, ref)
    const d = view.detail
    expect(d).toMatchObject({ number: 482, reviewDecision: 'approved', ci: 'success', state: 'open', labels: ['enhancement'] })
    expect(d.reviews).toMatchObject([{ author: 'mira-kline', state: 'approved' }])
    expect(d.comments.map((c) => [c.author, c.isBot])).toEqual([['release-bot', true], ['priya-nair', false]])
    expect(d.checks.map((c) => [c.name, c.status])).toEqual([['build', 'success'], ['unit tests', 'success'], ['lint', 'success']])
    expect(d.commits).toHaveLength(2)
    expect(d.threads).toHaveLength(2)
    const thread = d.threads.find((t) => t.id === '9001')!
    expect(thread.comments.map((c) => c.author)).toEqual(['mira-kline', 'demo-dev'])
    expect(d.threads.find((t) => t.id === '9003')!.comments[0]!.isBot).toBe(true)
    expect(view.files!.map((f) => [f.path, f.status])).toEqual([['src/checkout/gift-card.ts', 'added'], ['src/checkout/totals.ts', 'modified'], ['assets/card.png', 'added']])
    expect(view.files![2]!.binary).toBe(true)
  })

  it('maps failing and pending checks into the PR CI status', async () => {
    const { host: h } = host()
    const failing = await h.detail(h.parseUrl('https://github.com/acme-demo/billing-api/pull/133')!)
    expect(failing.ci).toBe('failure')
    const pending = await h.detail(h.parseUrl('https://github.com/acme-demo/design-system/pull/57')!)
    expect(pending.ci).toBe('pending')
    expect(pending.requestedReviewers).toEqual(['mira-kline'])
  })

  it('keeps the detail when the inline comments call fails', async () => {
    const base = createDemoRunner(NOW)
    const run: CliRunner = async (c, args) => (args.some((a) => a.endsWith('/comments')) ? { code: 1, stdout: '', stderr: 'rate limited' } : base(c, args))
    const h = new GitHubCodeHost({ run })
    const d = await h.detail(h.parseUrl('https://github.com/acme-demo/storefront/pull/482')!)
    expect(d.threads).toEqual([])
    expect(d.title).toContain('gift card')
  })

  it('threads replies to a root and survives a missing parent', () => {
    const threads = mapThreads([
      { id: 2, in_reply_to_id: 1, user: { login: 'b' }, body: 'r', path: 'x', created_at: '2026-01-01T00:00:02Z' },
      { id: 1, user: { login: 'a' }, body: 'q', path: 'x', line: 4, created_at: '2026-01-01T00:00:01Z' },
      { id: 5, in_reply_to_id: 99, user: { login: 'c' }, body: 'orphan', path: 'y', created_at: '2026-01-01T00:00:03Z' }
    ])
    expect(threads.map((t) => [t.id, t.comments.length])).toEqual([['1', 2], ['99', 1]])
  })

  it('maps a minimal view without throwing', () => {
    const ref = { provider: 'github', owner: 'a', repo: 'b', number: 1, url: 'https://github.com/a/b/pull/1' }
    expect(mapDetail({}, [], ref)).toMatchObject({ number: 1, ci: 'none', reviews: [], checks: [], reviewDecision: 'none' })
  })

  it('surfaces gh errors as the user-readable text', async () => {
    const run: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' })
    const h = new GitHubCodeHost({ run })
    await expect(h.diff({ provider: 'github', owner: 'a', repo: 'b', number: 1, url: 'https://github.com/a/b/pull/1' })).rejects.toThrow('Could not resolve to a PullRequest')
  })
})

describe('GitHubCodeHost writes (mock runner only)', () => {
  const ref = { provider: 'github', owner: 'acme-demo', repo: 'storefront', number: 486, url: 'https://github.com/acme-demo/storefront/pull/486' }

  it('builds the gh review commands', async () => {
    const { host: h, run } = host()
    await submitReview(h, ref, 'approve', '', false)
    await submitReview(h, ref, 'requestChanges', 'Please add a test', false)
    await submitReview(h, ref, 'comment', 'Question: why?', false)
    await postComment(h, ref, 'Thanks!')
    await h.replyToThread(ref, '9001', 'Done')
    expect(run.calls).toEqual([
      ['gh', 'pr', 'review', ref.url, '--approve'],
      ['gh', 'pr', 'review', ref.url, '--request-changes', '--body', 'Please add a test'],
      ['gh', 'pr', 'review', ref.url, '--comment', '--body', 'Question: why?'],
      ['gh', 'pr', 'comment', ref.url, '--body', 'Thanks!'],
      ['gh', 'api', 'repos/acme-demo/storefront/pulls/486/comments/9001/replies', '-f', 'body=Done']
    ])
  })

  it('does not run anything for a refused review and rejects odd thread ids', async () => {
    const { host: h, run } = host()
    await expect(submitReview(h, ref, 'approve', '', true)).rejects.toBeInstanceOf(CodeHostError)
    await expect(h.replyToThread(ref, '1; rm -rf /', 'x')).rejects.toBeInstanceOf(CodeHostError)
    expect(run.calls).toEqual([])
  })

  it('passes the body as one argument (no shell)', async () => {
    const { host: h, run } = host()
    await h.comment(ref, '`rm -rf ~` $(whoami) "quoted"')
    expect(run.calls[0]).toEqual(['gh', 'pr', 'comment', ref.url, '--body', '`rm -rf ~` $(whoami) "quoted"'])
  })

  it('uses --hostname for GitHub Enterprise', async () => {
    const run = createDemoRunner(NOW)
    await new GitHubCodeHost({ run, host: 'ghe.example.com' }).status()
    expect(run.calls.every((c) => c.includes('--hostname'))).toBe(true)
  })
})

describe('shared CLI helpers', () => {
  it('parses paginated output', () => {
    expect(parseJsonPages('[{"a":1}][{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
    expect(parseJsonPages('[{"a":1}]\n[]\n[{"a":3}]')).toEqual([{ a: 1 }, { a: 3 }])
    expect(parseJsonPages('[{"body":"see [a][b] and \\"][\\""}][{"n":2}]')).toEqual([{ body: 'see [a][b] and "]["' }, { n: 2 }])
    expect(parseJsonPages('')).toEqual([])
  })
})
