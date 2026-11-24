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
  /**
   * `items` hold every merge of `[coveredSince, until)`: windows the cap left unread or cut, windows the
   * host could not split below its search limit, and windows an interruption left unread all lie before it.
   * Absent: the whole period when not `truncated` and not `interrupted`, nothing certain otherwise.
   * Equal to `until`: nothing certain.
   */
  coveredSince?: number
  /** The read stopped early (the host's rate limit): `items` are what was read before, `coveredSince` says how far. */
  interrupted?: { kind: 'rateLimited'; message: string; retryAt: number }
}

/** A saved merged pull request and the profile whose read found it. */
export interface StoredMergedPullRequest {
  profileId: string
  pr: MergedPullRequest
}

/** A range of time whose merges were all read for one search, and when the read of its newest end ended. */
export interface MergedCoverage {
  since: number
  until: number
  /** Epoch milliseconds of the read that set `until` (reading an older range joined to it does not change it). */
  at: number
}

/** One search of one profile: `key` names its scope and whose merges (see the service). */
export interface MergedSearch {
  profileId: string
  key: string
}

/**
 * Merged pull requests kept between launches (a merge does not change once made). A pull request is saved
 * once per profile and URL, and remembers which searches of that profile found it, so a change of scope
 * (a new key) neither shows the old scope's rows nor counts the old reads as done.
 */
export interface MergedStore {
  /** Inserts or replaces by profile and URL, and records that this search found them. */
  save(search: MergedSearch, items: readonly MergedPullRequest[]): Promise<void>
  /** The saved pull requests found by any of these searches, merged in `[since, until)`, newest merge first; one entry per profile and URL. */
  read(searches: readonly MergedSearch[], since: number, until: number): Promise<StoredMergedPullRequest[]>
  /** How many `read` would return, without reading them. */
  count(searches: readonly MergedSearch[], since: number, until: number): Promise<number>
  /** The ranges read completely for that search, sorted, overlapping and touching ones joined. */
  covered(search: MergedSearch): Promise<MergedCoverage[]>
  /** Records that `[since, until)` was read completely at `at` (joined with what touches it; nothing when `since >= until`). */
  cover(search: MergedSearch, since: number, until: number, at: number): Promise<void>
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
