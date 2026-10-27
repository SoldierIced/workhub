import {
  CodeHostError,
  githubRecognizer,
  parseUnifiedDiff,
  type CodeHost,
  type CodeHostCapabilities,
  type CodeHostStatus,
  type DiffFile,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestQuery,
  type PullRequestRef,
  type ReviewAction
} from '@workhub/core'
import { CliNotFoundError, failureText, parseJsonPages, type CliResult, type CliRunner } from '../shared/cli'
import { mapDetail, mapSearchResponse } from './mapping'

const SEARCH_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
  number title url state isDraft updatedAt headRefName baseRefName additions deletions changedFiles
  reviewDecision mergeable author { login } repository { name owner { login } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
} } } }`

const VIEW_FIELDS = [
  'number', 'title', 'body', 'url', 'author', 'state', 'isDraft', 'baseRefName', 'headRefName', 'headRefOid',
  'createdAt', 'updatedAt', 'mergedAt', 'mergeable', 'reviewDecision', 'labels', 'reviewRequests', 'reviews',
  'comments', 'commits', 'statusCheckRollup', 'additions', 'deletions', 'changedFiles'
].join(',')

const REVIEW_FLAG: Record<ReviewAction, string> = { approve: '--approve', requestChanges: '--request-changes', comment: '--comment' }

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
    if (result.code !== 0) throw new CodeHostError(failureText(result, fallback))
    return result
  }

  async status(): Promise<CodeHostStatus> {
    try {
      // `auth token` is read locally: being offline does not look like being signed out.
      const token = await this.run('gh', ['auth', 'token', ...this.hostArgs])
      if (token.code !== 0) return { state: 'signedOut', cli: 'gh' }
      const user = await this.run('gh', ['api', ...this.hostArgs, 'user', '--jq', '.login'])
      if (user.code !== 0) return { state: 'error', message: failureText(user, 'Could not read the GitHub login') }
      return { state: 'ready', login: user.stdout.trim() }
    } catch (e) {
      if (e instanceof CliNotFoundError) return { state: 'missingCli', cli: 'gh' }
      return { state: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  private async search(qualifier: string, query: PullRequestQuery): Promise<PullRequest[]> {
    const q = `is:pr is:open archived:false ${qualifier} ${query.scope ?? ''}`.trim()
    const result = await this.gh(['api', ...this.hostArgs, 'graphql', '-f', `query=${SEARCH_QUERY}`, '-f', `q=${q}`], 'GitHub search failed')
    try {
      return mapSearchResponse(result.stdout)
    } catch {
      throw new CodeHostError('GitHub returned an answer Workhub could not read')
    }
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

  async replyToThread(ref: PullRequestRef, threadId: string, body: string): Promise<void> {
    if (!/^\d+$/.test(threadId)) throw new CodeHostError('Bad thread id', 'unsupported')
    await this.gh(
      ['api', ...this.hostArgs, `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${threadId}/replies`, '-f', `body=${body}`],
      'Could not send the reply'
    )
  }
}
