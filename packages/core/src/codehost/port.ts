import type {
  CodeHostCapabilities,
  CodeHostStatus,
  DiffFile,
  MergedPullRequest,
  MergeMethod,
  NewPullRequest,
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

/** Merged pull requests read for the Merged view. */
export interface MergedQuery {
  /** As in `PullRequestQuery`. */
  scope?: string
  /** Merged at or after (epoch milliseconds). */
  since: number
  /** Merged before (epoch milliseconds). */
  until: number
  /** Only the signed-in user's pull requests. */
  mine: boolean
}

export interface MergedList {
  /** Newest merge first. */
  items: MergedPullRequest[]
  /** The host's search limit was reached: there are more merges than `items`. */
  truncated: boolean
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
  /** Pull requests merged in a period, in the scope (all authors unless `mine`). Absent: the host cannot list them. */
  listMerged?(query: MergedQuery): Promise<MergedList>
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
  /** Opens a PR for a branch already on the host; never pushes. Returns the new PR. */
  createPullRequest(input: NewPullRequest): Promise<PullRequestRef>
  /** The merge methods the PR's repository allows, in the host's order of preference. */
  mergeMethods(ref: PullRequestRef): Promise<MergeMethod[]>
  /** Merges the PR now (never queues an auto-merge), deleting its head branch when asked. */
  merge(ref: PullRequestRef, options: { method: MergeMethod; deleteBranch: boolean; branch: string }): Promise<void>
}
