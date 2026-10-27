import { CodeHostError, loadMyPullRequests, loadPullRequestView, loadReviewQueue, submitReview } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { GitLabCodeHost } from '../src/codehost-gitlab'
import { mapDiffs, mapPipelineStatus } from '../src/codehost-gitlab/mapping'
import { CliNotFoundError, type CliRunner } from '../src/shared/cli'

// Synthetic `glab api` answers. glab is not installed where this was written, so this is the only coverage.
const WEB = 'https://gitlab.com/acme-demo/team/shop/-/merge_requests'
const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  iid,
  title: `DEMO-${iid} change`,
  web_url: `${WEB}/${iid}`,
  state: 'opened',
  draft: false,
  updated_at: '2026-10-26T10:00:00.000Z',
  source_branch: `feat/demo-${iid}`,
  target_branch: 'main',
  author: { username: 'ana' },
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  changes_count: '4',
  sha: 'abc123',
  head_pipeline: { id: 77, status: 'success' },
  description: 'Does the thing',
  labels: ['backend'],
  reviewers: [{ username: 'bo' }, { username: 'cy' }],
  created_at: '2026-10-25T10:00:00.000Z',
  ...over
})

interface Route {
  match: RegExp
  out?: unknown | string
  code?: number
  err?: string
}

function runner(routes: Route[]): CliRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (command: string, args: string[]) => {
    calls.push([command, ...args])
    const endpoint = args.find((a) => /^(user|merge_requests|projects|groups)/.test(a)) ?? ''
    const route = routes.find((r) => r.match.test(endpoint))
    if (!route) return { code: 1, stdout: '', stderr: `404 Not Found: ${endpoint}` }
    if (route.code) return { code: route.code, stdout: '', stderr: route.err ?? '' }
    return { code: 0, stdout: typeof route.out === 'string' ? route.out : JSON.stringify(route.out ?? {}), stderr: '' }
  }) as CliRunner & { calls: string[][] }
  run.calls = calls
  return run
}

const DIFF = '@@ -1,2 +1,2 @@\n-old\n+new\n keep\n'
const ref = { provider: 'gitlab', owner: 'acme-demo/team', repo: 'shop', number: 5, url: `${WEB}/5` }
const DETAIL_ROUTES: Route[] = [
  { match: /merge_requests\/5$/, out: mr(5, { detailed_merge_status: 'not_approved' }) },
  { match: /merge_requests\/5\/approvals$/, out: { approvals_left: 0, approved_by: [{ user: { username: 'bo' } }] } },
  {
    match: /merge_requests\/5\/discussions/,
    out: [
        { id: 'aa11', individual_note: true, notes: [{ id: 1, type: null, body: 'Nice', author: { username: 'bo' }, created_at: '2026-10-25T11:00:00Z' }] },
        { id: 'ab22', individual_note: true, notes: [{ id: 2, system: true, body: 'added 1 commit', author: { username: 'ana' } }] },
        {
          id: 'cd33',
          individual_note: false,
          notes: [
            { id: 3, type: 'DiffNote', body: 'Rename?', author: { username: 'cy' }, created_at: '2026-10-25T12:00:00Z', resolvable: true, resolved: false, position: { new_path: 'a.ts', new_line: 3 } },
            { id: 4, type: 'DiffNote', body: 'Done', author: { username: 'ana' }, created_at: '2026-10-25T13:00:00Z', position: { new_path: 'a.ts', new_line: 3 } }
          ]
        },
        { id: 'ef44', notes: [{ id: 5, type: null, body: 'Pipeline bot says hi', author: { username: 'project_9_bot_abc', bot: true }, created_at: '2026-10-25T09:00:00Z' }] }
    ]
  },
  { match: /merge_requests\/5\/commits/, out: [{ id: 'c2', title: 'Second', author_name: 'Ana', committed_date: '2026-10-25T12:00:00Z' }, { id: 'c1', title: 'First', author_name: 'Ana', committed_date: '2026-10-25T10:00:00Z' }] },
  { match: /pipelines\/77\/jobs/, out: [{ name: 'build', status: 'success', web_url: 'https://gitlab.com/j/1' }, { name: 'test', status: 'failed' }, { name: 'deploy', status: 'manual' }] }
]

describe('GitLabCodeHost lists', () => {
  it('lists my open MRs through the REST API and maps the domain', async () => {
    const run = runner([
      {
        match: /^merge_requests\?/,
        out: [mr(5, { head_pipeline: { status: 'failed' }, has_conflicts: true, detailed_merge_status: 'conflict' }), mr(6, { draft: true, state: 'opened', detailed_merge_status: 'requested_changes' }), { iid: 7, web_url: 'https://gitlab.com/x/issues/7' }]
      }
    ])
    const host = new GitLabCodeHost({ run })
    const mine = await loadMyPullRequests(host, {}, Date.UTC(2026, 9, 27))
    expect(mine.map((i) => [i.pr.number, i.status])).toEqual([[5, 'conflicts'], [6, 'changesRequested']])
    expect(mine[0]!.pr).toMatchObject({ provider: 'gitlab', owner: 'acme-demo/team', repo: 'shop', branch: 'feat/demo-5', base: 'main', ci: 'failure', changedFiles: 4 })
    expect(run.calls[0]).toEqual(['glab', 'api', '--paginate', 'merge_requests?state=opened&per_page=50&order_by=updated_at&scope=created_by_me'])
  })

  it('reads the review queue by reviewer username and honors a group scope', async () => {
    const run = runner([{ match: /^user$/, out: { username: 'me.dev' } }, { match: /^groups\//, out: [mr(9)] }])
    const host = new GitLabCodeHost({ run })
    const queue = await loadReviewQueue(host, { scope: 'group:acme-demo/team' })
    expect(queue.map((i) => i.pr.number)).toEqual([9])
    expect(run.calls[1]![3]).toBe('groups/acme-demo%2Fteam/merge_requests?state=opened&per_page=50&order_by=updated_at&scope=all&reviewer_username=me.dev')
  })

  it('maps pipeline statuses', () => {
    expect(['success', 'failed', 'running', 'manual', undefined].map(mapPipelineStatus)).toEqual(['success', 'failure', 'pending', 'none', 'none'])
  })
})

describe('GitLabCodeHost status', () => {
  it('shows "glab not found" as a missing CLI', async () => {
    const run: CliRunner = async (c) => Promise.reject(new CliNotFoundError(c))
    const host = new GitLabCodeHost({ run })
    expect(await host.status()).toEqual({ state: 'missingCli', cli: 'glab' })
    await expect(host.listAuthored({})).rejects.toMatchObject({ kind: 'missingCli' })
  })
  it('reports a signed-out login and a ready one', async () => {
    expect(await new GitLabCodeHost({ run: runner([{ match: /^user$/, code: 1, err: '401 Unauthorized' }]) }).status()).toEqual({ state: 'signedOut', cli: 'glab' })
    expect(await new GitLabCodeHost({ run: runner([{ match: /^user$/, out: { username: 'me.dev' } }]) }).status()).toEqual({ state: 'ready', login: 'me.dev' })
  })
  it('passes --hostname for a self-managed host', async () => {
    const run = runner([{ match: /^user$/, out: { username: 'u' } }])
    await new GitLabCodeHost({ run, host: 'git.example.com' }).status()
    expect(run.calls[0]).toEqual(['glab', 'api', '--hostname', 'git.example.com', 'user'])
  })
})

describe('GitLabCodeHost detail and diff', () => {
  it('assembles the detail from the MR, approvals, discussions, commits and jobs', async () => {
    const run = runner([...DETAIL_ROUTES, { match: /merge_requests\/5\/diffs/, out: [{ old_path: 'a.ts', new_path: 'a.ts', diff: DIFF }, { old_path: 'o.txt', new_path: 'n.txt', renamed_file: true, diff: '' }, { old_path: 'i.png', new_path: 'i.png', new_file: true, diff: '' }] }])
    const host = new GitLabCodeHost({ run })
    const view = await loadPullRequestView(host, ref)
    const d = view.detail
    expect(d).toMatchObject({ reviewDecision: 'approved', ci: 'success', labels: ['backend'], requestedReviewers: ['cy'], body: 'Does the thing' })
    expect(d.reviews).toEqual([{ id: 'approval-bo', author: 'bo', isBot: false, state: 'approved', body: '', submittedAt: undefined }])
    expect(d.comments.map((c) => [c.author, c.isBot])).toEqual([['project_9_bot_abc', true], ['bo', false]])
    expect(d.threads).toHaveLength(1)
    expect(d.threads[0]).toMatchObject({ id: 'cd33', path: 'a.ts', line: 3, resolved: false })
    expect(d.threads[0]!.comments.map((c) => c.author)).toEqual(['cy', 'ana'])
    expect(d.commits.map((c) => c.headline)).toEqual(['First', 'Second'])
    expect(d.checks.map((c) => [c.name, c.status])).toEqual([['build', 'success'], ['test', 'failure']])
    expect(view.files!.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ['a.ts', 'modified', 1, 1, false],
      ['n.txt', 'renamed', 0, 0, false],
      ['i.png', 'added', 0, 0, true]
    ])
    expect(run.calls.some((c) => c.includes('projects/acme-demo%2Fteam%2Fshop/merge_requests/5'))).toBe(true)
  })

  it('keeps the detail when optional calls fail, and falls back to `changes` for the diff', async () => {
    const run = runner([
      { match: /merge_requests\/5$/, out: mr(5, { head_pipeline: null }) },
      { match: /merge_requests\/5\/changes$/, out: { changes: [{ old_path: 'a.ts', new_path: 'a.ts', diff: DIFF }] } }
    ])
    const host = new GitLabCodeHost({ run })
    const view = await loadPullRequestView(host, ref)
    expect(view.detail.threads).toEqual([])
    expect(view.detail.ci).toBe('none')
    expect(view.files).toHaveLength(1)
  })

  it('reports a requested-changes MR', async () => {
    const run = runner([{ match: /merge_requests\/5$/, out: mr(5, { detailed_merge_status: 'requested_changes' }) }])
    expect((await new GitLabCodeHost({ run }).detail(ref)).reviewDecision).toBe('changesRequested')
  })

  it('marks too-large diffs as text-less but not binary', () => {
    expect(mapDiffs([{ old_path: 'big.sql', new_path: 'big.sql', diff: '', too_large: true }])[0]).toMatchObject({ binary: false, hunks: [] })
  })
})

describe('GitLabCodeHost writes (mock runner only)', () => {
  it('approves through the API, with an optional note', async () => {
    const run = runner([{ match: /approve$/ }, { match: /notes$/ }])
    const host = new GitLabCodeHost({ run })
    await submitReview(host, ref, 'approve', '', false)
    await submitReview(host, ref, 'approve', 'LGTM', false)
    await submitReview(host, ref, 'comment', 'A question', false)
    await host.replyToThread(ref, 'cd33', 'Answer')
    const p = 'projects/acme-demo%2Fteam%2Fshop/merge_requests/5'
    expect(run.calls).toEqual([
      ['glab', 'api', '--method', 'POST', `${p}/approve`],
      ['glab', 'api', '--method', 'POST', `${p}/approve`],
      ['glab', 'api', '--method', 'POST', `${p}/notes`, '--raw-field', 'body=LGTM'],
      ['glab', 'api', '--method', 'POST', `${p}/notes`, '--raw-field', 'body=A question'],
      ['glab', 'api', '--method', 'POST', `${p}/discussions/cd33/notes`, '--raw-field', 'body=Answer']
    ])
  })

  it('offers no "request changes" and refuses it before running anything', async () => {
    const run = runner([])
    const host = new GitLabCodeHost({ run })
    expect(host.capabilities.reviewActions).toEqual(['approve', 'comment'])
    await expect(submitReview(host, ref, 'requestChanges', 'no', false)).rejects.toBeInstanceOf(CodeHostError)
    await expect(host.submitReview(ref, 'requestChanges', 'no')).rejects.toMatchObject({ kind: 'unsupported' })
    expect(run.calls).toEqual([])
  })

  it('recognizes only its own URLs', () => {
    const host = new GitLabCodeHost({ run: runner([]) })
    expect(host.recognizes(`${WEB}/5/diffs`)).toBe(true)
    expect(host.recognizes('https://github.com/a/b/pull/1')).toBe(false)
  })
})
