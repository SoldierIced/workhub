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
  type MergedList,
  type MergedPullRequest,
  type MergedQuery,
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
import { mapDetail, mapMergedPage, mapSearchResponse, searchNextCursor } from './mapping'

/** At most this many pull requests per list, read in pages of `SEARCH_PAGE` (smaller after a transient failure). */
const SEARCH_CAP = 500
/** Pull requests per page of a list search; halved (down to `MIN_PAGE`) when GitHub runs out of time on its side. */
const SEARCH_PAGE = 50
const MIN_PAGE = 10
/** GitHub's answer when a query ran out of time on its side (a heavy page): read again with a smaller page. */
const TRANSIENT = /HTTP 50[234]|Bad Gateway|Service Unavailable|Gateway Time-?out|something went wrong while executing your query/i
/** Smaller pages tried after a transient failure before giving up. */
const TRANSIENT_RETRIES = 2

const SEARCH_QUERY = `query($q: String!, $after: String, $first: Int!) { search(query: $q, type: ISSUE, first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number title url state isDraft updatedAt headRefName baseRefName additions deletions changedFiles
  reviewDecision mergeable author { login } repository { name owner { login } }
  comments { totalCount } reviewThreads { totalCount }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
} } } }`

/** GitHub answers at most 1,000 results per search; a window that reports this many is split. */
const SEARCH_LIMIT = 1000
/** At most this many merged pull requests are returned (the newest). */
export const MERGED_CAP = 3000
/** Merged searches run at most this many at once, across every call on the host: more trips GitHub's secondary rate limit. */
const MERGED_PARALLEL = 2
/** At most this many merged searches (`gh api graphql` calls) in any `MERGED_LIMIT_WINDOW_MS`: a call over it waits for its turn. */
export const MERGED_LIMIT = 40
export const MERGED_LIMIT_WINDOW_MS = 60_000
/** How long the host is left alone after GitHub says it is rate limiting and gives no better time. */
export const RATE_LIMIT_WAIT_MS = 5 * 60_000
/** A window this short is not split any more: it is read as it is and the result is marked truncated. */
const MIN_WINDOW_MS = 3_600_000

// No `changedFiles`: GitHub computes it per pull request, which makes a page of 100 take about four times longer.
const MERGED_QUERY = `query($q: String!, $after: String, $first: Int!) { search(query: $q, type: ISSUE, first: $first, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
  number title url mergedAt createdAt headRefName baseRefName additions deletions author { login } repository { name owner { login } }
} } } }`

/** A search date-time: UTC, whole seconds. */
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** A merged search over `[from, to)`: the qualifier's end is inclusive, so it names the last whole second before `to`. */
export function mergedSearchQuery(scope: string | undefined, from: number, to: number, mine: boolean): string {
  const lastSecond = Math.ceil(to / 1000) * 1000 - 1000
  return `is:pr is:merged archived:false merged:${stamp(Math.floor(from / 1000) * 1000)}..${stamp(Math.max(lastSecond, Math.floor(from / 1000) * 1000))} ${scope ?? ''}${mine ? ' author:@me' : ''}`.replace(/\s+/g, ' ').trim()
}

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

/** GitHub's own wording for a rate limit (secondary, or primary: "API rate limit exceeded"). */
const RATE_LIMITED = /secondary rate limit|rate limit (?:already )?exceeded/i
const PRIMARY_LIMIT = /API rate limit (?:already )?exceeded/i

export interface GitHubCodeHostOptions {
  run: CliRunner
  /** Web host; set for GitHub Enterprise Server. Defaults to github.com. */
  host?: string
  /** The clock (epoch milliseconds) behind the merged-search limit and the rate-limit cooldown; tests inject one. */
  now?: () => number
  /** Waits `ms` (the merged-search limit waits with it); tests inject one that moves the fake clock. */
  sleep?: (ms: number) => Promise<void>
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
  /** Merged searches under way and waiting, across every `listMerged` call. */
  private mergedActive = 0
  private readonly mergedWaiting: Array<() => void> = []
  /** When each of the merged searches of the last minute started. */
  private readonly mergedStarts: number[] = []
  /** After GitHub's rate limit: until when every `gh` call (status excepted) fails at once, without running `gh`. */
  private cooldown: { until: number; message: string } | null = null
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: GitHubCodeHostOptions) {
    this.run = options.run
    this.host = options.host ?? 'github.com'
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
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
    const cooling = this.cooldown
    if (cooling) {
      if (this.now() < cooling.until) throw new CodeHostError(cooling.message, 'rateLimited', cooling.until)
      this.cooldown = null
    }
    let result: CliResult
    try {
      result = await this.run('gh', args)
    } catch (e) {
      if (e instanceof CliNotFoundError) throw new CodeHostError('The GitHub CLI (gh) is not installed', 'missingCli')
      throw e
    }
    if (result.code !== 0) {
      const text = failureText(result, fallback)
      if (RATE_LIMITED.test(text)) {
        const retryAt = await this.startCooldown(text)
        throw new CodeHostError(text, 'rateLimited', retryAt)
      }
      throw new CodeHostError(text, SIGNED_OUT.test(text) ? 'signedOut' : 'failed')
    }
    return result
  }

  /**
   * GitHub refused because of its rate limit: no `gh` call runs until the returned time. A secondary limit
   * waits `RATE_LIMIT_WAIT_MS`; for the primary limit `gh api rate_limit` (which does not count) says when it resets.
   */
  private async startCooldown(message: string): Promise<number> {
    let retryAt = this.now() + RATE_LIMIT_WAIT_MS
    if (PRIMARY_LIMIT.test(message) && !/secondary rate limit/i.test(message)) retryAt = (await this.primaryReset()) ?? retryAt
    // Calls that failed together agree on the later time.
    const until = Math.max(retryAt, this.cooldown?.until ?? 0)
    this.cooldown = { until, message }
    return until
  }

  private async primaryReset(): Promise<number | null> {
    try {
      const result = await this.run('gh', ['api', ...this.hostArgs, 'rate_limit'])
      if (result.code !== 0) return null
      const resources = (JSON.parse(result.stdout) as { resources?: Record<string, { reset?: unknown } | undefined> }).resources
      const resets = [resources?.graphql?.reset, resources?.search?.reset].filter((r): r is number => typeof r === 'number' && Number.isFinite(r)).map((r) => r * 1000)
      const reset = resets.length > 0 ? Math.max(...resets) : null
      return reset !== null && reset > this.now() ? reset : null
    } catch {
      return null
    }
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
    // A page that had to be smaller keeps that size for the rest of the list.
    let size = SEARCH_PAGE
    // Bounded by the cap: pages are never smaller than MIN_PAGE.
    for (let page = 0; page < SEARCH_CAP / MIN_PAGE && out.length < SEARCH_CAP; page++) {
      const read = await this.searchPage(SEARCH_QUERY, q, after, size, (args) => this.gh(args, 'GitHub search failed'))
      size = read.size
      const result = read.result
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

  /**
   * One page of a GraphQL search. GitHub answers 502/503/504 when a heavy page runs out of time on its side: the same
   * page is asked again with half the pull requests (down to `MIN_PAGE`), up to `TRANSIENT_RETRIES` times.
   */
  private async searchPage(query: string, q: string, after: string | null, first: number, call: (args: string[]) => Promise<CliResult>): Promise<{ result: CliResult; size: number }> {
    let size = first
    for (let attempt = 0; ; attempt++) {
      try {
        return { size, result: await call(['api', ...this.hostArgs, 'graphql', '-f', `query=${query}`, '-f', `q=${q}`, '-F', `first=${size}`, ...(after ? ['-f', `after=${after}`] : [])]) }
      } catch (e) {
        if (!(e instanceof CodeHostError) || e.kind !== 'failed' || !TRANSIENT.test(e.message) || attempt >= TRANSIENT_RETRIES || size <= MIN_PAGE) throw e
        size = Math.max(MIN_PAGE, Math.floor(size / 2))
      }
    }
  }

  /** Waits until fewer than `MERGED_LIMIT` merged searches started in the last minute, then counts this one. */
  private async mergedTurn(): Promise<void> {
    for (;;) {
      const now = this.now()
      while (this.mergedStarts.length > 0 && this.mergedStarts[0]! <= now - MERGED_LIMIT_WINDOW_MS) this.mergedStarts.shift()
      if (this.mergedStarts.length < MERGED_LIMIT) {
        this.mergedStarts.push(now)
        return
      }
      await this.sleep(Math.max(1, this.mergedStarts[0]! + MERGED_LIMIT_WINDOW_MS - now))
    }
  }

  private async mergedSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.mergedActive >= MERGED_PARALLEL) await new Promise<void>((resolve) => this.mergedWaiting.push(resolve))
    else this.mergedActive++
    try {
      await this.mergedTurn()
      return await task()
    } finally {
      // The slot passes straight to the next waiter.
      const next = this.mergedWaiting.shift()
      if (next) next()
      else this.mergedActive--
    }
  }

  /**
   * Merged pull requests of `[since, until)`. One search is capped at 1,000 results, so the period is
   * read as windows: a window that reports 1,000 or more is halved (down to an hour) and its halves
   * are read newest first, at most two searches at once. Windows are dropped from the end once the
   * newest `MERGED_CAP` are certain; then, and when a window could not be split, the list is `truncated`.
   */
  async listMerged(query: MergedQuery): Promise<MergedList> {
    const found = new Map<string, MergedPullRequest>()
    const pending: Array<{ from: number; to: number }> = query.until > query.since ? [{ from: query.since, to: query.until }] : []
    let truncated = false
    let active = 0
    let failed = false
    let completed = 0
    let interrupted: CodeHostError | null = null
    /** The `to` of every window whose merges are not all in `found`: the list is certain only after the latest. */
    let uncertainTo = query.since
    const uncertain = (to: number): void => {
      uncertainTo = Math.max(uncertainTo, to)
    }

    const newerThan = (cutoff: number): number => {
      let n = 0
      for (const p of found.values()) if (p.mergedAt >= cutoff && p.mergedAt >= query.since && p.mergedAt < query.until) n++
      return n
    }

    const readWindow = async (w: { from: number; to: number }): Promise<void> => {
      const q = mergedSearchQuery(query.scope, w.from, w.to, query.mine)
      let after: string | null = null
      const items: MergedPullRequest[] = []
      let size = 100
      // Until the search says there is no next page; GitHub never pages past its 1,000th result.
      for (let page = 0; page < SEARCH_LIMIT / MIN_PAGE; page++) {
        // Each try takes its own turn (the per-minute limit counts it); a smaller page keeps its size for the window.
        const read = await this.searchPage(MERGED_QUERY, q, after, size, (args) => this.mergedSlot(() => this.gh(args, 'GitHub search failed')))
        size = read.size
        const result = read.result
        let parsed: ReturnType<typeof mapMergedPage>
        try {
          parsed = mapMergedPage(result.stdout)
        } catch {
          throw new CodeHostError('GitHub returned an answer Workhub could not read')
        }
        if (page === 0 && parsed.issueCount >= SEARCH_LIMIT) {
          if (w.to - w.from > MIN_WINDOW_MS) {
            const mid = Math.floor((w.from + w.to) / 2000) * 1000
            if (mid > w.from && mid < w.to) {
              pending.push({ from: mid, to: w.to }, { from: w.from, to: mid })
              pending.sort((a, b) => b.to - a.to)
              return
            }
          }
          // Cannot be split further: what the search returns is all there is.
          truncated = true
          uncertain(w.to)
        }
        items.push(...parsed.items)
        after = parsed.next
        if (!after) break
      }
      for (const p of items) found.set(p.url, p)
      completed++
    }

    await new Promise<void>((resolve, reject) => {
      const pump = (): void => {
        if (failed) return
        // Every window still waiting is older than the ones being read; once the newest CAP are known from newer windows, the rest cannot matter.
        while (!interrupted && active < MERGED_PARALLEL && pending.length > 0) {
          if (newerThan(pending[0]!.to) >= MERGED_CAP) {
            truncated = true
            uncertain(pending[0]!.to)
            pending.length = 0
            break
          }
          const w = pending.shift()!
          active++
          readWindow(w).then(
            () => {
              active--
              pump()
            },
            (e: unknown) => {
              if (e instanceof CodeHostError && e.kind === 'rateLimited' && !failed) {
                // Windows under way finish or fail; nothing new starts.
                interrupted ??= e
                uncertain(w.to)
                active--
                pump()
                return
              }
              failed = true
              reject(e)
            }
          )
        }
        if (active === 0 && (pending.length === 0 || interrupted)) resolve()
      }
      pump()
    })

    if (interrupted) {
      const stop: CodeHostError = interrupted
      // Nothing was read: the caller learns it as an error.
      if (completed === 0) throw stop
      truncated = true
      for (const w of pending) uncertain(w.to)
    }
    const items = [...found.values()].filter((p) => p.mergedAt >= query.since && p.mergedAt < query.until).sort((a, b) => b.mergedAt - a.mergedAt || b.number - a.number)
    let kept = items
    if (items.length > MERGED_CAP) {
      kept = items.slice(0, MERGED_CAP)
      truncated = true
      // Everything newer than the newest dropped merge is in the list.
      uncertain(items[MERGED_CAP]!.mergedAt + 1)
    }
    const list: MergedList = { items: kept, truncated }
    if (truncated) list.coveredSince = Math.min(query.until, Math.max(query.since, uncertainTo))
    if (interrupted) {
      const stop: CodeHostError = interrupted
      list.interrupted = { kind: 'rateLimited', message: stop.message, retryAt: stop.retryAt ?? this.now() + RATE_LIMIT_WAIT_MS }
    }
    return list
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
