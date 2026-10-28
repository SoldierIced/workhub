/**
 * The targets of "Review with another agent": the repositories a session can be reviewed in (the
 * ones it touched, its own, and the ones right inside a folder of repositories), and a picked
 * target resolved to its diff. Local targets need git only; a pull request is read with the
 * user's own `gh` login, read-only (`gh pr view`, `gh pr diff`), and nothing else.
 */
import { basename } from 'node:path'
import {
  parseCommitRange,
  parsePullRequestInput,
  repoSlugOfRemote,
  type ResolvedReviewTarget,
  type ReviewRepoOption,
  type GhState,
  type ReviewTargetError,
  type ReviewTargetRequest
} from '@workhub/core'
import { CliNotFoundError, type CliRunner } from '../shared/cli'
import { childRepositories } from './local'
import { parseStatus, runGit, type GitReview, type GitRunner } from './index'

/** Git's empty tree: what a root commit is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Diffs are read up to this size; the prompt cuts them further. */
const DIFF_BUFFER = 256 * 1024 * 1024
const NO_DRIVERS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']
const GH_TIMEOUT_MS = 60_000

export type TargetResolution = { ok: true; target: ResolvedReviewTarget; inRepo: boolean } | { ok: false; reason: ReviewTargetError; detail?: string }

const fail = (reason: ReviewTargetError, detail?: string): TargetResolution => ({ ok: false, reason, ...(detail ? { detail } : {}) })

/** `owner/repo` of a GitHub pull request URL, lowercased. */
function slugOfPullUrl(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(url)
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
}

interface GhPullRequest {
  number: number
  title: string
  body: string
  url: string
  state: string
  baseRefName?: string
  headRefName?: string
  mergedAt?: string | null
  commits?: { oid: string; messageHeadline: string }[]
  files?: { path: string; additions: number; deletions: number }[]
}

export class ReviewTargets {
  constructor(
    private readonly repos: Pick<GitReview, 'repositoryOf' | 'repoChanges' | 'probe' | 'mergeBase' | 'commits'>,
    /** Runs `gh` (the user's login PATH); `CliNotFoundError` when it is not installed. */
    private readonly run: CliRunner,
    private readonly git: GitRunner = runGit
  ) {}

  private async out(cwd: string, args: string[]): Promise<string | null> {
    const r = await this.git(cwd, args, { maxBuffer: DIFF_BUFFER })
    return r.ok ? r.stdout.replace(/\s+$/, '') : null
  }

  /**
   * The repositories offered for a session: the ones it worked in (most recent first), then its
   * folder's own, then each one right inside its folder (a folder of repositories), once each.
   */
  async repositories(cwd: string, workPaths: readonly string[] = []): Promise<ReviewRepoOption[]> {
    const touched: string[] = []
    for (const path of [...workPaths].reverse()) {
      const root = await this.repos.repositoryOf(path)
      if (root && !touched.includes(root)) touched.push(root)
      if (touched.length >= 20) break
    }
    const own = await this.repos.repositoryOf(cwd)
    const roots = [...touched]
    if (own && !roots.includes(own)) roots.push(own)
    if (!own) for (const r of await childRepositories(cwd)) if (!roots.includes(r)) roots.push(r)
    return Promise.all(
      roots.map(async (root) => {
        const c = await this.repos.repoChanges(root)
        return { root, name: c.name, branch: c.branch, touched: touched.includes(root), dirtyFiles: c.files }
      })
    )
  }

  /** Whether `gh` is installed and signed in (read locally: being offline does not look signed out). */
  async ghState(): Promise<GhState> {
    try {
      // The token is printed by this command: it is read for the exit code only and dropped.
      const r = await this.run('gh', ['auth', 'token'], { timeoutMs: 10_000 })
      return r.code === 0 ? 'ready' : 'signedOut'
    } catch (e) {
      if (e instanceof CliNotFoundError) return 'missing'
      return 'signedOut'
    }
  }

  /** A picked target as the reviewer reads it. `baseBranch` is the profile's base for the branch target. */
  async resolve(request: ReviewTargetRequest, baseBranch: string): Promise<TargetResolution> {
    if (request.kind === 'pr') return this.pullRequest(request.pr, request.repo)
    if (!request.repo?.trim()) return fail('noRepo')
    const root = await this.out(request.repo, ['rev-parse', '--show-toplevel'])
    if (!root) return fail('notRepo', request.repo)
    if (request.kind === 'uncommitted') return this.uncommitted(root)
    if (request.kind === 'branch') return this.branch(root, request.base?.trim() || baseBranch)
    return this.commitRange(root, request.range)
  }

  private async uncommitted(root: string): Promise<TargetResolution> {
    const head = await this.out(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    const status = await this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    const files = status.ok ? parseStatus(status.stdout) : []
    if (!files.length) return fail('noChanges', basename(root))
    const from = head ? 'HEAD' : EMPTY_TREE
    const [diff, diffStat, untracked, branch] = await Promise.all([
      this.out(root, ['diff', ...NO_DRIVERS, from]),
      this.out(root, ['diff', ...NO_DRIVERS, '--stat=160', from]),
      this.out(root, ['ls-files', '--others', '--exclude-standard']),
      this.out(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ])
    return {
      ok: true,
      inRepo: true,
      target: {
        kind: 'uncommitted',
        repoRoot: root,
        repoName: basename(root),
        description: `the uncommitted changes (staged, unstaged and untracked) on ${branch ? `branch \`${branch}\`` : 'a detached HEAD'}`,
        commits: [],
        diffStat: diffStat ?? '',
        diff: diff ?? '',
        untracked: (untracked ?? '').split('\n').filter(Boolean)
      }
    }
  }

  private async branch(root: string, base: string): Promise<TargetResolution> {
    const probe = await this.repos.probe(root, base)
    if (!probe) return fail('noHead', basename(root))
    if (!probe.baseRef) return fail('noBase', base)
    if (probe.ahead <= 0) return fail('noCommits', probe.baseRef)
    const mergeBase = (await this.repos.mergeBase(root, probe.baseRef, probe.headSha)) ?? probe.baseRef
    const [commits, diffStat, diff] = await Promise.all([
      this.repos.commits(root, mergeBase, probe.headSha),
      this.out(root, ['diff', ...NO_DRIVERS, '--stat=160', mergeBase, probe.headSha]),
      this.out(root, ['diff', ...NO_DRIVERS, mergeBase, probe.headSha])
    ])
    const name = probe.branch ? `branch \`${probe.branch}\`` : `the detached HEAD \`${probe.headSha.slice(0, 10)}\``
    return {
      ok: true,
      inRepo: true,
      target: {
        kind: 'branch',
        repoRoot: root,
        repoName: basename(root),
        description: `${name} against \`${probe.baseRef}\` (${probe.ahead} commit${probe.ahead === 1 ? '' : 's'} since merge base \`${mergeBase.slice(0, 10)}\`; uncommitted changes are not part of it)`,
        commits,
        diffStat: diffStat ?? '',
        diff: diff ?? ''
      }
    }
  }

  private async commitRange(root: string, text: string): Promise<TargetResolution> {
    const range = parseCommitRange(text)
    if (!range) return fail('badRange', text.trim())
    const verify = (rev: string) => this.out(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])
    const to = await verify(range.to)
    if (!to) return fail('unknownCommit', range.to)
    let from: string
    if (range.from) {
      const f = await verify(range.from)
      if (!f) return fail('unknownCommit', range.from)
      from = f
    } else from = (await verify(`${to}^`)) ?? EMPTY_TREE
    const [commits, diffStat, diff, subject] = await Promise.all([
      from === EMPTY_TREE ? this.out(root, ['log', '--no-color', '-1', '--format=%h %s', to]).then((s) => (s ? [s] : [])) : this.repos.commits(root, from, to),
      this.out(root, ['diff', ...NO_DRIVERS, '--stat=160', from, to]),
      this.out(root, ['diff', ...NO_DRIVERS, from, to]),
      this.out(root, ['log', '--no-color', '-1', '--format=%s', to])
    ])
    if (!diff?.trim() && !commits.length) return fail('noCommits', range.from ? `${range.from}..${range.to}` : range.to)
    const description = range.from
      ? `the commits \`${range.from}..${range.to}\` (\`${from.slice(0, 10)}..${to.slice(0, 10)}\`, ${commits.length} commit${commits.length === 1 ? '' : 's'})`
      : `the single commit \`${to.slice(0, 10)}\`${subject ? ` "${subject}"` : ''}, against its parent`
    return { ok: true, inRepo: true, target: { kind: 'commits', repoRoot: root, repoName: basename(root), description, commits, diffStat: diffStat ?? '', diff: diff ?? '' } }
  }

  /** `gh` with its failure turned into a reason: not installed, signed out, not found, or its own message. */
  private async gh(args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: ReviewTargetError; detail?: string }> {
    let r
    try {
      r = await this.run('gh', args, { timeoutMs: GH_TIMEOUT_MS })
    } catch (e) {
      if (e instanceof CliNotFoundError) return { ok: false, reason: 'ghMissing' }
      return { ok: false, reason: 'ghFailed', detail: e instanceof Error ? e.message : String(e) }
    }
    if (r.code === 0) return { ok: true, stdout: r.stdout }
    const line = r.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
    if (/gh auth login|not logged in|authentication/i.test(r.stderr) || (await this.ghState()) === 'signedOut') return { ok: false, reason: 'ghSignedOut' }
    if (/could not resolve to a pullrequest|no pull requests? found|not found/i.test(r.stderr)) return { ok: false, reason: 'prNotFound', detail: line.slice(0, 200) }
    return { ok: false, reason: 'ghFailed', detail: line.slice(0, 200) || `gh exited with ${r.code}` }
  }

  private async pullRequest(text: string, repo: string | undefined): Promise<TargetResolution> {
    const parsed = parsePullRequestInput(text)
    if (!parsed) return fail('badPr', text.trim())
    if (parsed.url && !/\/pull\/\d+$/.test(parsed.url)) return fail('prNotGitHub', parsed.url)
    // The repository the reviewer runs in, when there is one: the picked one, if it is the PR's.
    const root = repo?.trim() ? await this.out(repo, ['rev-parse', '--show-toplevel']) : null
    const remote = root ? await this.out(root, ['config', '--get', 'remote.origin.url']) : null
    const repoSlug = remote ? repoSlugOfRemote(remote) : null
    let ref: string
    let prSlug: string | null
    if (parsed.url) {
      ref = parsed.url
      prSlug = slugOfPullUrl(parsed.url)
    } else {
      if (!root) return fail(repo?.trim() ? 'notRepo' : 'prNeedsRepo', repo)
      if (!repoSlug) return fail('prNoRemote', basename(root))
      ref = String(parsed.number)
      prSlug = repoSlug
    }
    const repoArgs = parsed.url ? [] : ['--repo', prSlug!]
    const view = await this.gh(['pr', 'view', ref, ...repoArgs, '--json', 'number,title,body,url,state,baseRefName,headRefName,mergedAt,commits,files'])
    if (!view.ok) return fail(view.reason, view.detail)
    let pr: GhPullRequest
    try {
      pr = JSON.parse(view.stdout) as GhPullRequest
    } catch {
      return fail('ghFailed', 'gh returned an answer Workhub could not read')
    }
    const diff = await this.gh(['pr', 'diff', ref, ...repoArgs])
    if (!diff.ok) return fail(diff.reason, diff.detail)
    const inRepo = Boolean(root && repoSlug && prSlug && repoSlug === prSlug)
    const files = pr.files ?? []
    const width = Math.min(100, Math.max(0, ...files.map((f) => f.path.length)))
    const state = pr.state.toLowerCase()
    return {
      ok: true,
      inRepo,
      target: {
        kind: 'pr',
        repoRoot: inRepo ? root! : '',
        repoName: inRepo ? basename(root!) : (prSlug ?? `PR #${pr.number}`),
        description: `the ${state} pull request #${pr.number} "${pr.title}"${pr.headRefName && pr.baseRefName ? ` (\`${pr.headRefName}\` into \`${pr.baseRefName}\`)` : ''}`,
        commits: (pr.commits ?? []).map((c) => `${c.oid.slice(0, 7)} ${c.messageHeadline}`),
        diffStat: files.map((f) => `${f.path.padEnd(width)} | +${f.additions} -${f.deletions}`).join('\n'),
        diff: diff.stdout,
        pr: {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          body: pr.body ?? '',
          state: pr.state,
          ...(pr.baseRefName ? { baseRefName: pr.baseRefName } : {}),
          ...(pr.headRefName ? { headRefName: pr.headRefName } : {}),
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {})
        }
      }
    }
  }
}
