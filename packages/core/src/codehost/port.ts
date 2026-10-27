import type {
  CodeHostCapabilities,
  CodeHostStatus,
  DiffFile,
  PullRequest,
  PullRequestDetail,
  PullRequestRef,
  ReviewAction
} from './domain'

export interface PullRequestQuery {
  /**
   * Provider-specific narrowing of the search: GitHub search qualifiers (`org:acme`,
   * `repo:acme/api`), a GitLab group path (`group:acme/team`). Empty: everything the login can see.
   */
  scope?: string
}

/**
 * Pull requests of one code host, for the signed-in user. Methods throw `CodeHostError` with a
 * message fit for the user; a missing CLI or login is reported by `status()` before any read.
 */
export interface CodeHost {
  readonly provider: string
  readonly capabilities: CodeHostCapabilities
  /** Whether a URL is a pull/merge request of this host. */
  recognizes(url: string): boolean
  parseUrl(url: string): PullRequestRef | null
  /** CLI present and logged in? Reads locally where it can, so being offline is not "signed out". */
  status(): Promise<CodeHostStatus>
  /** Open PRs the user wrote. */
  listAuthored(query: PullRequestQuery): Promise<PullRequest[]>
  /** Open PRs waiting for the user's review. */
  listReviewRequested(query: PullRequestQuery): Promise<PullRequest[]>
  detail(ref: PullRequestRef): Promise<PullRequestDetail>
  diff(ref: PullRequestRef): Promise<DiffFile[]>
  /** Submits a review; `body` may be empty for an approval. */
  submitReview(ref: PullRequestRef, action: ReviewAction, body: string): Promise<void>
  /** Adds a comment to the conversation. */
  comment(ref: PullRequestRef, body: string): Promise<void>
  /** Replies in the thread of an inline comment. */
  replyToThread(ref: PullRequestRef, threadId: string, body: string): Promise<void>
  /** Closes the PR without merging, posting `comment` first when given and deleting its head branch when asked. */
  close(ref: PullRequestRef, options: { comment: string; deleteBranch: boolean; branch: string }): Promise<void>
}
