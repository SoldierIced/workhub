import {
  classifyCodeHostFailure,
  CodeHostError,
  createRefusal,
  githubRecognizer,
  isSafeRefName,
  MERGE_METHODS,
  parseUnifiedDiff,
  type CodeHost,
  type CodeHostCapabilities,
  type CodeHostStatus,
  type DiffFile,
  type MergeMethod,
  type NewPullRequest,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestQuery,
  type PullRequestRef,
  type ReviewAction
} from '@workhub/core'
import { CliNotFoundError, failureText, parseJsonPages, type CliResult, type CliRunner } from '../shared/cli'
import { mapDetail, mapSearchResponse, searchNextCursor } from './mapping'

/** At most this many pull requests per list, read in at most `SEARCH_PAGES` pages of 50. */
const SEARCH_CAP = 500
const SEARCH_PAGES = 10

const SEARCH_QUERY = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number title url state isDraft updatedAt headRefName baseRefName additions deletions changedFiles
  reviewDecision mergeable author { login } repository { name owner { login } }
  comments { totalCount } reviewThreads { totalCount }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
} } } }`

const VIEW_FIELDS = [
  'number', 'title', 'body', 'url', 'author', 'state', 'isDraft', 'baseRefName', 'headRefName', 'headRefOid',
  'createdAt', 'updatedAt', 'mergedAt', 'mergeable', 'reviewDecision', 'labels', 'reviewRequests', 'reviews',
  'comments', 'commits', 'statusCheckRollup', 'additions', 'deletions', 'changedFiles'
].join(',')

const REVIEW_FLAG: Record<ReviewAction, string> = { approve: '--approve', requestChanges: '--request-changes', comment: '--comment' }

const MERGE_FLAG: Record<MergeMethod, string> = { merge: '--merge', squash: '--squash', rebase: '--rebase' }
const MERGE_ALLOWED: Record<MergeMethod, string> = { merge: 'mergeCommitAllowed', squash: 'squashMergeAllowed', rebase: 'rebaseMergeAllowed' }

/** What `gh` says when its login is missing, expired or revoked. */
const SIGNED_OUT = /gh auth login|not logged in|requires authentication|authentication (?:required|failed)|bad credentials|HTTP 401/i

/** How long a login read stays valid while the token is the same. */
const LOGIN_TTL_MS = 10 * 60_000

export interface GitHubCodeHostOptions {
  run: CliRunner
  /** Web host; set for GitHub Enterprise Server. Defaults to github.com. */
  host?: string
}

/** GitHub through the `gh` CLI and the user's own `gh auth login`: no token is stored by Workhub. */
export class GitHubCodeHost implements CodeHost {
  readonly provider = 'github'
  readonly capabilities: CodeHostCapabilities = { reviewActions: ['approve', 'requestChanges', 'comment'], replyToThread: true }
  private readonly run: CliRunner
  private readonly host: string
  private readonly recognizer
  /** The login behind the last token seen, so a status check costs one local `gh auth token` and no request. A new token (`gh auth switch`) reads the login again. */
  private login: { token: string; value: string; at: number } | null = null

  constructor(options: GitHubCodeHostOptions) {
    this.run = options.run
    this.host = options.host ?? 'github.com'
    this.recognizer = githubRecognizer(this.host)
  }

  recognizes(url: string): boolean {
    return this.recognizer.parse(url) !== null
  }

  parseUrl(url: string): PullRequestRef | null {
    return this.recognizer.parse(url)
  }

  private get hostArgs(): string[] {
    return this.host === 'github.com' ? [] : ['--hostname', this.host]
  }

  private async gh(args: string[], fallback: string): Promise<CliResult> {
    let result: CliResult
    try {
      result = await this.run('gh', args)
    } catch (e) {
      if (e instanceof CliNotFoundError) throw new CodeHostError('The GitHub CLI (gh) is not installed', 'missingCli')
      throw e
    }
    if (result.code !== 0) {
      const text = failureText(result, fallback)
      throw new CodeHostError(text, SIGNED_OUT.test(text) ? 'signedOut' : 'failed')
    }
    return result
  }

  /** A write whose failure text may say why (not mergeable, checks failing, no permission, already exists). */
  private async write(args: string[], fallback: string): Promise<CliResult> {
    try {
      return await this.gh(args, fallback)
    } catch (e) {
      if (e instanceof CodeHostError && e.kind === 'failed') throw new CodeHostError(e.message, classifyCodeHostFailure(e.message) ?? 'failed')
      throw e
    }
  }

  /** `owner/repo`, with the host in front on GitHub Enterprise (`gh --repo HOST/OWNER/REPO`). */
  private repoArg(owner: string, repo: string): string {
    return this.host === 'github.com' ? `${owner}/${repo}` : `${this.host}/${owner}/${repo}`
  }

  async status(): Promise<CodeHostStatus> {
    try {
      // `auth token` is read locally: being offline does not look like being signed out.
      const token = await this.run('gh', ['auth', 'token', ...this.hostArgs])
      if (token.code !== 0) {
        this.login = null
        return { state: 'signedOut', cli: 'gh' }
      }
      const known = this.login
      if (known && known.token === token.stdout && Date.now() - known.at < LOGIN_TTL_MS) return { state: 'ready', login: known.value }
      const user = await this.run('gh', ['api', ...this.hostArgs, 'user', '--jq', '.login'])
      if (user.code !== 0) {
        this.login = null
        const text = failureText(user, 'Could not read the GitHub login')
        return SIGNED_OUT.test(text) ? { state: 'signedOut', cli: 'gh' } : { state: 'error', message: text }
      }
      this.login = { token: token.stdout, value: user.stdout.trim(), at: Date.now() }
      return { state: 'ready', login: this.login.value }
    } catch (e) {
      if (e instanceof CliNotFoundError) return { state: 'missingCli', cli: 'gh' }
      return { state: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  private async search(qualifier: string, query: PullRequestQuery): Promise<PullRequest[]> {
    const q = `is:pr is:open archived:false ${qualifier} ${query.scope ?? ''}`.trim()
    const out: PullRequest[] = []
    let after: string | null = null
    for (let page = 0; page < SEARCH_PAGES && out.length < SEARCH_CAP; page++) {
      const result = await this.gh(
        ['api', ...this.hostArgs, 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])],
        'GitHub search failed'
      )
      try {
        out.push(...mapSearchResponse(result.stdout))
        after = searchNextCursor(result.stdout)
      } catch {
        throw new CodeHostError('GitHub returned an answer Workhub could not read')
      }
      if (!after) break
    }
    return out.slice(0, SEARCH_CAP)
  }

  listAuthored(query: PullRequestQuery): Promise<PullRequest[]> {
    return this.search('author:@me', query)
  }

  listReviewRequested(query: PullRequestQuery): Promise<PullRequest[]> {
    return this.search('review-requested:@me', query)
  }

  async detail(ref: PullRequestRef): Promise<PullRequestDetail> {
    const [view, inline] = await Promise.all([
      this.gh(['pr', 'view', ref.url, '--json', VIEW_FIELDS], 'Could not read the pull request'),
      // Inline comments are a nice-to-have: a failure here leaves the rest of the view intact.
      this.run('gh', ['api', ...this.hostArgs, '--paginate', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`]).catch(() => null)
    ])
    try {
      const pages = inline && inline.code === 0 ? parseJsonPages(inline.stdout) : []
      return mapDetail(JSON.parse(view.stdout), pages, ref)
    } catch {
      throw new CodeHostError('GitHub returned an answer Workhub could not read')
    }
  }

  async diff(ref: PullRequestRef): Promise<DiffFile[]> {
    const result = await this.gh(['pr', 'diff', ref.url], 'Could not read the diff')
    return parseUnifiedDiff(result.stdout)
  }

  async submitReview(ref: PullRequestRef, action: ReviewAction, body: string): Promise<void> {
    const args = ['pr', 'review', ref.url, REVIEW_FLAG[action]]
    if (body) args.push('--body', body)
    await this.gh(args, 'gh pr review failed')
  }

  async comment(ref: PullRequestRef, body: string): Promise<void> {
    await this.gh(['pr', 'comment', ref.url, '--body', body], 'gh pr comment failed')
  }

  async close(ref: PullRequestRef, options: { comment: string; deleteBranch: boolean; branch: string }): Promise<void> {
    const args = ['pr', 'close', ref.url]
    if (options.comment) args.push('--comment', options.comment)
    if (options.deleteBranch) args.push('--delete-branch')
    await this.gh(args, 'gh pr close failed')
  }

  async createPullRequest(input: NewPullRequest): Promise<PullRequestRef> {
    const refusal = createRefusal(input)
    if (refusal) throw new CodeHostError(`create refused: ${refusal}`, 'unsupported')
    // `--head` names the branch on the host, so gh neither looks at a checkout nor offers to push.
    const args = ['pr', 'create', '--repo', this.repoArg(input.repository.owner, input.repository.repo), '--head', input.branch, '--base', input.base, '--title', input.title, '--body', input.body]
    if (input.draft) args.push('--draft')
    const result = await this.write(args, 'gh pr create failed')
    const ref = result.stdout.split(/\s+/).map((w) => this.recognizer.parse(w)).find((r) => r !== null)
    if (!ref) throw new CodeHostError('GitHub created the pull request, but Workhub could not read its address')
    return ref
  }

  async mergeMethods(ref: PullRequestRef): Promise<MergeMethod[]> {
    const fields = MERGE_METHODS.map((m) => MERGE_ALLOWED[m]).join(',')
    const result = await this.gh(['repo', 'view', this.repoArg(ref.owner, ref.repo), '--json', fields], 'Could not read the repository settings')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>
    } catch {
      throw new CodeHostError('GitHub returned an answer Workhub could not read')
    }
    return MERGE_METHODS.filter((m) => parsed[MERGE_ALLOWED[m]] === true)
  }

  async merge(ref: PullRequestRef, options: { method: MergeMethod; deleteBranch: boolean; branch: string }): Promise<void> {
    // No `--auto`: merge now or fail with the reason. No `--delete-branch` either: gh would also
    // delete a local branch of that name in whatever checkout it runs from; the API call below only
    // touches the host.
    if (options.deleteBranch && !isSafeRefName(options.branch)) throw new CodeHostError('Bad branch name', 'unsupported')
    await this.write(['pr', 'merge', ref.url, MERGE_FLAG[options.method]], 'gh pr merge failed')
    if (!options.deleteBranch) return
    const deleted = await this.run('gh', ['api', ...this.hostArgs, '--method', 'DELETE', `repos/${ref.owner}/${ref.repo}/git/refs/heads/${options.branch}`])
    // A repository that deletes head branches on merge already did it.
    if (deleted.code !== 0 && !/Reference does not exist|\b(404|422)\b/i.test(deleted.stderr + deleted.stdout)) {
      throw new CodeHostError(`Merged, but the branch could not be deleted: ${failureText(deleted, 'unknown error')}`)
    }
  }

  async replyToThread(ref: PullRequestRef, threadId: string, body: string): Promise<void> {
    if (!/^\d+$/.test(threadId)) throw new CodeHostError('Bad thread id', 'unsupported')
    await this.gh(
      ['api', ...this.hostArgs, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${threadId}/replies`, '-f', `body=${body}`],
      'Could not send the reply'
    )
  }
}
