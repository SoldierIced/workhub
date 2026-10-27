import {
  CodeHostError,
  gitlabProjectPath,
  gitlabRecognizer,
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
import { mapDetail, mapDiffs, mapMergeRequestList } from './mapping'

export interface GitLabCodeHostOptions {
  run: CliRunner
  /** Web host; set for a self-managed GitLab. Defaults to gitlab.com. */
  host?: string
}

const LIST = 'state=opened&per_page=50&order_by=updated_at'

/**
 * GitLab merge requests through the `glab` CLI and the user's own `glab auth login`.
 * "Request changes" is not offered: GitLab has no such verdict on every plan, so the port says
 * so in `capabilities` and the UI hides the button instead of faking it with a comment.
 */
export class GitLabCodeHost implements CodeHost {
  readonly provider = 'gitlab'
  readonly capabilities: CodeHostCapabilities = { reviewActions: ['approve', 'comment'], replyToThread: true }
  private readonly run: CliRunner
  private readonly host: string
  private readonly recognizer
  private login: string | null = null

  constructor(options: GitLabCodeHostOptions) {
    this.run = options.run
    this.host = options.host ?? 'gitlab.com'
    this.recognizer = gitlabRecognizer(this.host)
  }

  recognizes(url: string): boolean {
    return this.recognizer.parse(url) !== null
  }

  parseUrl(url: string): PullRequestRef | null {
    return this.recognizer.parse(url)
  }

  private async glab(args: string[], fallback: string): Promise<CliResult> {
    const hostArgs = this.host === 'gitlab.com' || args[0] !== 'api' ? [] : ['--hostname', this.host]
    let result: CliResult
    try {
      result = await this.run('glab', [args[0]!, ...hostArgs, ...args.slice(1)])
    } catch (e) {
      if (e instanceof CliNotFoundError) throw new CodeHostError('The GitLab CLI (glab) is not installed', 'missingCli')
      throw e
    }
    if (result.code !== 0) {
      const text = failureText(result, fallback)
      throw new CodeHostError(text, /401|unauthori[sz]ed|not logged in|no token|authenticat/i.test(text) ? 'signedOut' : 'failed')
    }
    return result
  }

  private async pages(endpoint: string, fallback: string): Promise<unknown[]> {
    return parseJsonPages((await this.glab(['api', '--paginate', endpoint], fallback)).stdout)
  }

  private async currentLogin(): Promise<string> {
    if (this.login) return this.login
    const user = await this.glab(['api', 'user'], 'Could not read the GitLab login')
    const name = (JSON.parse(user.stdout) as { username?: unknown }).username
    if (typeof name !== 'string' || !name) throw new CodeHostError('Could not read the GitLab login')
    return (this.login = name)
  }

  async status(): Promise<CodeHostStatus> {
    try {
      return { state: 'ready', login: await this.currentLogin() }
    } catch (e) {
      if (e instanceof CodeHostError && e.kind === 'missingCli') return { state: 'missingCli', cli: 'glab' }
      if (e instanceof CodeHostError && e.kind === 'signedOut') return { state: 'signedOut', cli: 'glab' }
      return { state: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  /** A scope is `group:<path>` or `project:<path>`; anything else reads every MR the login can see. */
  private base(scope: string | undefined): string {
    const m = /^(group|project):(\S+)$/.exec((scope ?? '').trim())
    return m ? `${m[1]}s/${encodeURIComponent(m[2]!)}/merge_requests` : 'merge_requests'
  }

  private async list(path: string, filter: string): Promise<PullRequest[]> {
    const result = await this.pages(`${path}?${LIST}&${filter}`, 'GitLab search failed')
    try {
      return mapMergeRequestList(result, (u) => this.recognizer.parse(u))
    } catch {
      throw new CodeHostError('GitLab returned an answer Workhub could not read')
    }
  }

  listAuthored(query: PullRequestQuery): Promise<PullRequest[]> {
    return this.list(this.base(query.scope), 'scope=created_by_me')
  }

  async listReviewRequested(query: PullRequestQuery): Promise<PullRequest[]> {
    const login = await this.currentLogin()
    return this.list(this.base(query.scope), `scope=all&reviewer_username=${encodeURIComponent(login)}`)
  }

  private mr(ref: PullRequestRef): string {
    return `projects/${gitlabProjectPath(ref)}/merge_requests/${ref.number}`
  }

  async detail(ref: PullRequestRef): Promise<PullRequestDetail> {
    const mr = this.mr(ref)
    const view = await this.glab(['api', mr], 'Could not read the merge request')
    let parsed: unknown
    try {
      parsed = JSON.parse(view.stdout)
    } catch {
      throw new CodeHostError('GitLab returned an answer Workhub could not read')
    }
    const pipelineId = ((parsed as { head_pipeline?: { id?: unknown } }).head_pipeline ?? {}).id
    // Everything beyond the MR itself is optional: a failing call leaves that part of the view empty.
    const soft = async <T>(p: Promise<T>, empty: T): Promise<T> => p.catch(() => empty)
    const [approvalsRaw, discussions, commits, jobs] = await Promise.all([
      soft(this.glab(['api', `${mr}/approvals`], '').then((r) => JSON.parse(r.stdout) as unknown), {}),
      soft(this.pages(`${mr}/discussions?per_page=100`, ''), []),
      soft(this.pages(`${mr}/commits?per_page=100`, ''), []),
      typeof pipelineId === 'number'
        ? soft(this.pages(`projects/${gitlabProjectPath(ref)}/pipelines/${pipelineId}/jobs?per_page=100`, ''), [])
        : Promise.resolve([])
    ])
    return mapDetail({ mr: parsed, approvals: approvalsRaw, discussions, commits: [...commits].reverse(), jobs }, ref)
  }

  async diff(ref: PullRequestRef): Promise<DiffFile[]> {
    const mr = this.mr(ref)
    try {
      return mapDiffs(await this.pages(`${mr}/diffs?per_page=100`, 'Could not read the diff'))
    } catch (e) {
      // Older GitLab versions only have `changes`.
      if (e instanceof CodeHostError && e.kind !== 'failed') throw e
      const view = await this.glab(['api', `${mr}/changes`], 'Could not read the diff')
      return mapDiffs((JSON.parse(view.stdout) as { changes?: unknown[] }).changes ?? [])
    }
  }

  async submitReview(ref: PullRequestRef, action: ReviewAction, body: string): Promise<void> {
    if (!this.capabilities.reviewActions.includes(action)) throw new CodeHostError('GitLab has no "request changes" verdict', 'unsupported')
    if (action === 'approve') {
      await this.glab(['api', '--method', 'POST', `${this.mr(ref)}/approve`], 'Could not approve the merge request')
      if (body) await this.comment(ref, body)
      return
    }
    await this.comment(ref, body)
  }

  async comment(ref: PullRequestRef, body: string): Promise<void> {
    await this.glab(['api', '--method', 'POST', `${this.mr(ref)}/notes`, '--raw-field', `body=${body}`], 'Could not send the comment')
  }

  async replyToThread(ref: PullRequestRef, threadId: string, body: string): Promise<void> {
    if (!/^[0-9a-f]+$/i.test(threadId)) throw new CodeHostError('Bad thread id', 'unsupported')
    await this.glab(
      ['api', '--method', 'POST', `${this.mr(ref)}/discussions/${threadId}/notes`, '--raw-field', `body=${body}`],
      'Could not send the reply'
    )
  }
}
