import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliNotFoundError, type CliResult, type CliRunner } from '../src/shared/cli'
import { GitReview, ReviewTargets, type TargetResolution } from '../src/git-review'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

/** A `gh` stand-in: answers by the first two arguments, records every call. */
function fakeGh(answers: Record<string, CliResult | Error>): CliRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (command: string, args: string[]) => {
    calls.push([command, ...args])
    const a = answers[args.slice(0, 2).join(' ')] ?? { code: 1, stdout: '', stderr: 'unexpected call' }
    if (a instanceof Error) throw a
    return a
  }) as CliRunner & { calls: string[][] }
  run.calls = calls
  return run
}

const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: '' })
const target = (r: TargetResolution) => {
  if (!r.ok) throw new Error(`expected a target, got ${r.reason} ${r.detail ?? ''}`)
  return r.target
}

describe('ReviewTargets in a folder of repositories', () => {
  let container: string
  let pay: string
  let users: string
  let first: string
  let second: string
  const targets = new ReviewTargets(new GitReview(), fakeGh({ 'auth token': ok('x') }))

  beforeAll(() => {
    // realpath: macOS's tmpdir is a symlink, and git prints real paths.
    container = realpathSync(mkdtempSync(join(tmpdir(), 'workhub-review-targets-')))
    pay = join(container, 'pay')
    users = join(container, 'users')
    for (const repo of [pay, users]) {
      git(container, 'init', '--quiet', '-b', 'main', repo)
      writeFileSync(join(repo, 'a.txt'), 'one\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '--quiet', '-m', 'init')
    }
    git(pay, 'checkout', '--quiet', '-b', 'feat/refunds')
    writeFileSync(join(pay, 'a.txt'), 'one\ntwo\n')
    git(pay, 'commit', '--quiet', '-am', 'feat: two')
    first = git(pay, 'rev-parse', 'HEAD')
    writeFileSync(join(pay, 'b.txt'), 'b\n')
    git(pay, 'add', 'b.txt')
    git(pay, 'commit', '--quiet', '-m', 'feat: b')
    second = git(pay, 'rev-parse', 'HEAD')
    mkdirSync(join(container, 'notes'))
  })

  afterAll(() => rmSync(container, { recursive: true, force: true }))

  it('offers the touched repositories first, then every repository inside the folder', async () => {
    const repos = await targets.repositories(container, [join(container, 'notes'), join(pay, 'src')])
    expect(repos.map((r) => [r.name, r.touched, r.branch])).toEqual([
      ['pay', true, 'feat/refunds'],
      ['users', false, 'main']
    ])
    // Not touched yet: still offered, so the session can be reviewed anyway.
    expect((await targets.repositories(container)).map((r) => r.name)).toEqual(['pay', 'users'])
  })

  it('reviews a commit range in a nested repository', async () => {
    const t = target(await targets.resolve({ kind: 'commits', repo: pay, range: `${first.slice(0, 7)}..${second.slice(0, 7)}` }, 'main'))
    expect(t).toMatchObject({ kind: 'commits', repoRoot: pay, repoName: 'pay', commits: [expect.stringMatching(/ feat: b$/)] })
    expect(t.diff).toContain('+b')
    expect(t.diff).not.toContain('+two')
    expect(t.description).toContain('1 commit')
  })

  it('reviews one commit against its parent, a root commit against the empty tree', async () => {
    expect(target(await targets.resolve({ kind: 'commits', repo: pay, range: first }, 'main')).diff).toContain('+two')
    const root = git(users, 'rev-parse', 'HEAD')
    expect(target(await targets.resolve({ kind: 'commits', repo: users, range: root }, 'main')).diff).toContain('+one')
  })

  it('reviews the branch against its base and the uncommitted changes', async () => {
    const branch = target(await targets.resolve({ kind: 'branch', repo: pay }, 'main'))
    expect(branch.commits).toHaveLength(2)
    expect(branch.description).toContain('`feat/refunds` against `main`')
    writeFileSync(join(users, 'a.txt'), 'one\nedited\n')
    writeFileSync(join(users, 'new.txt'), 'n\n')
    const dirty = target(await targets.resolve({ kind: 'uncommitted', repo: users }, 'main'))
    expect(dirty.diff).toContain('+edited')
    expect(dirty.untracked).toEqual(['new.txt'])
    git(users, 'checkout', '--quiet', '--', 'a.txt')
    rmSync(join(users, 'new.txt'))
  })

  it('says exactly why a local target cannot be reviewed', async () => {
    expect(await targets.resolve({ kind: 'branch', repo: container }, 'main')).toEqual({ ok: false, reason: 'notRepo', detail: container })
    expect(await targets.resolve({ kind: 'uncommitted', repo: '' }, 'main')).toEqual({ ok: false, reason: 'noRepo' })
    expect(await targets.resolve({ kind: 'uncommitted', repo: pay }, 'main')).toEqual({ ok: false, reason: 'noChanges', detail: 'pay' })
    expect(await targets.resolve({ kind: 'branch', repo: users }, 'main')).toEqual({ ok: false, reason: 'noCommits', detail: 'main' })
    expect(await targets.resolve({ kind: 'commits', repo: pay, range: '--output=x' }, 'main')).toEqual({ ok: false, reason: 'badRange', detail: '--output=x' })
    expect(await targets.resolve({ kind: 'commits', repo: pay, range: 'deadbeef' }, 'main')).toEqual({ ok: false, reason: 'unknownCommit', detail: 'deadbeef' })
  })
})

describe('ReviewTargets for a pull request', () => {
  let repo: string
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'workhub-review-pr-')))
    git(repo, 'init', '--quiet', '-b', 'main')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/Pay.git')
  })
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  const merged = JSON.stringify({
    number: 12,
    title: 'Fix refunds',
    body: 'Closes PAY-7',
    url: 'https://github.com/acme/pay/pull/12',
    state: 'MERGED',
    baseRefName: 'main',
    headRefName: 'fix/refunds',
    mergedAt: '2026-10-01T10:00:00Z',
    commits: [{ oid: 'a1b2c3d4e5', messageHeadline: 'fix: refunds' }],
    files: [{ path: 'src/refund.ts', additions: 3, deletions: 1 }]
  })

  it('builds a merged PR target from read-only gh calls, by number in the picked repository', async () => {
    const gh = fakeGh({ 'pr view': ok(merged), 'pr diff': ok('diff --git a/src/refund.ts b/src/refund.ts\n+const x = 1\n') })
    const r = await new ReviewTargets(new GitReview(), gh).resolve({ kind: 'pr', pr: '#12', repo }, 'main')
    expect(r.ok && r.inRepo).toBe(true)
    const t = target(r)
    expect(t).toMatchObject({ kind: 'pr', repoRoot: repo, commits: ['a1b2c3d fix: refunds'], pr: { number: 12, state: 'MERGED', body: 'Closes PAY-7', mergedAt: '2026-10-01T10:00:00Z' } })
    expect(t.description).toContain('merged pull request #12')
    expect(t.diffStat).toContain('src/refund.ts | +3 -1')
    expect(t.diff).toContain('+const x = 1')
    expect(gh.calls.map((c) => c.slice(0, 5))).toEqual([
      ['gh', 'pr', 'view', '12', '--repo'],
      ['gh', 'pr', 'diff', '12', '--repo']
    ])
    expect(gh.calls[0]).toContain('acme/pay')
    // Only reads: nothing that writes to GitHub.
    expect(gh.calls.flat().some((a) => ['comment', 'review', 'create', 'merge', 'edit', 'close'].includes(a))).toBe(false)
  })

  it('reads a PR URL from any folder; the reviewer runs outside the repository then', async () => {
    const gh = fakeGh({ 'pr view': ok(merged), 'pr diff': ok('+x\n') })
    const r = await new ReviewTargets(new GitReview(), gh).resolve({ kind: 'pr', pr: 'https://github.com/other/thing/pull/12' }, 'main')
    expect(r).toMatchObject({ ok: true, inRepo: false, target: { repoRoot: '', repoName: 'other/thing' } })
  })

  it('says why a PR cannot be read: gh missing, signed out, not found, no repository', async () => {
    const t = (gh: CliRunner) => new ReviewTargets(new GitReview(), gh)
    expect(await t(fakeGh({ 'pr view': new CliNotFoundError('gh') })).resolve({ kind: 'pr', pr: '12', repo }, 'main')).toEqual({ ok: false, reason: 'ghMissing' })
    const signedOut = fakeGh({ 'pr view': { code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'auth token': { code: 1, stdout: '', stderr: '' } })
    expect(await t(signedOut).resolve({ kind: 'pr', pr: '12', repo }, 'main')).toEqual({ ok: false, reason: 'ghSignedOut' })
    const missing = fakeGh({ 'pr view': { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99.' }, 'auth token': ok('x') })
    expect(await t(missing).resolve({ kind: 'pr', pr: '99', repo }, 'main')).toMatchObject({ ok: false, reason: 'prNotFound' })
    expect(await t(fakeGh({})).resolve({ kind: 'pr', pr: '12' }, 'main')).toEqual({ ok: false, reason: 'prNeedsRepo' })
    expect(await t(fakeGh({})).resolve({ kind: 'pr', pr: 'twelve', repo }, 'main')).toEqual({ ok: false, reason: 'badPr', detail: 'twelve' })
  })

  it('reports gh state for the dialog without exposing the token', async () => {
    expect(await new ReviewTargets(new GitReview(), fakeGh({ 'auth token': ok('gho_secret') })).ghState()).toBe('ready')
    expect(await new ReviewTargets(new GitReview(), fakeGh({ 'auth token': { code: 1, stdout: '', stderr: 'not logged in' } })).ghState()).toBe('signedOut')
    expect(await new ReviewTargets(new GitReview(), fakeGh({ 'auth token': new CliNotFoundError('gh') })).ghState()).toBe('missing')
  })
})
