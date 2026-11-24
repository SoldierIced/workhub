/**
 * Pull requests (GitHub) and merge requests (GitLab) as one domain. The adapters map each host's
 * words onto these enums, so the screens never branch on the host (PLAN section 4, `CodeHost`).
 */

export type PullRequestState = 'open' | 'merged' | 'closed'

/** The reviewers' verdict on a PR. `none`: the host has no rule that requires a review. */
export type ReviewDecision = 'approved' | 'changesRequested' | 'reviewRequired' | 'none'

/** The combined result of the checks on the PR's head commit. */
export type CiStatus = 'success' | 'failure' | 'pending' | 'none'

export type Mergeability = 'mergeable' | 'conflicting' | 'unknown'

/** Where a PR lives: enough to address it on its host. `repo` is the full project path on GitLab (`group/sub/project`). */
export interface PullRequestRef {
  provider: string
  owner: string
  repo: string
  number: number
  url: string
}

/**
 * A merged pull request, as the Merged view counts it. Lines and files are undefined when the host's
 * list does not report them (GitLab), which is not the same as zero.
 */
export interface MergedPullRequest extends PullRequestRef {
  title: string
  author: string
  /** Head (source) branch. */
  branch: string
  /** Base (target) branch, as the host names it (`main`, `master`, `release/2.4`). */
  base: string
  /** Epoch milliseconds. */
  mergedAt: number
  /** Epoch milliseconds; undefined when the host did not say. */
  createdAt?: number
  additions?: number
  deletions?: number
  changedFiles?: number
}

export interface PullRequest extends PullRequestRef {
  title: string
  author: string
  /** Head (source) branch. */
  branch: string
  /** Base (target) branch. */
  base: string
  state: PullRequestState
  isDraft: boolean
  reviewDecision: ReviewDecision
  ci: CiStatus
  mergeable: Mergeability
  additions: number
  deletions: number
  changedFiles: number
  /** Epoch milliseconds; undefined when the host did not say. */
  updatedAt?: number
  headSha?: string
  /** Conversation comments plus review threads, when the host's list reports them; used to notice new comments. */
  commentCount?: number
}

export interface PullRequestReview {
  id: string
  author: string
  isBot: boolean
  state: 'approved' | 'changesRequested' | 'commented' | 'dismissed' | 'pending'
  body: string
  submittedAt?: number
}

/** A comment in the conversation (not attached to a line of the diff). */
export interface PullRequestComment {
  id: string
  author: string
  isBot: boolean
  body: string
  createdAt?: number
}

/** A comment on a line of the diff, or a reply in that thread. */
export interface InlineComment {
  id: string
  author: string
  isBot: boolean
  body: string
  path: string
  line?: number
  createdAt?: number
}

/** The comments on one spot of the diff, the first one opening the thread. */
export interface CommentThread {
  id: string
  path: string
  line?: number
  resolved?: boolean
  comments: InlineComment[]
}

export interface PullRequestCommit {
  sha: string
  headline: string
  author: string
  date?: number
}

export interface PullRequestCheck {
  name: string
  status: CiStatus
  url?: string
}

export interface PullRequestDetail extends PullRequest {
  body: string
  labels: string[]
  requestedReviewers: string[]
  createdAt?: number
  mergedAt?: number
  reviews: PullRequestReview[]
  comments: PullRequestComment[]
  threads: CommentThread[]
  commits: PullRequestCommit[]
  checks: PullRequestCheck[]
}

export type DiffLineKind = 'added' | 'removed' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  oldNumber?: number
  newNumber?: number
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified'

export interface DiffFile {
  path: string
  oldPath?: string
  status: DiffFileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export type ReviewAction = 'approve' | 'requestChanges' | 'comment'

/** How a PR lands on its base. GitLab offers `merge` and `squash` (its project setting picks merge commit or fast-forward). */
export type MergeMethod = 'merge' | 'squash' | 'rebase'

export const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase']

/** A repository on the host: `owner/repo` (GitLab: the group path and the project). */
export interface RepositoryRef {
  owner: string
  repo: string
}

/** What "Create pull request" sends: the head branch must already be on the host (Workhub never pushes it). */
export interface NewPullRequest {
  repository: RepositoryRef
  /** Head (source) branch. */
  branch: string
  /** Base (target) branch. */
  base: string
  title: string
  body: string
  draft: boolean
}

/** What a host can do from Workhub: GitLab has no "request changes" verdict on every plan. */
export interface CodeHostCapabilities {
  reviewActions: readonly ReviewAction[]
  replyToThread: boolean
}

/** Why the host cannot be read. `missingCli`/`signedOut` are setup steps, not failures. */
export type CodeHostStatus =
  | { state: 'ready'; login: string }
  | { state: 'missingCli'; cli: string }
  | { state: 'signedOut'; cli: string }
  | { state: 'error'; message: string }

/**
 * Why a write was refused, when the host's text says so: the PR cannot be merged (conflicts, draft,
 * a branch rule), its checks fail, the login lacks the permission, or the PR already exists.
 */
export type CodeHostFailure = 'notMergeable' | 'checksFailing' | 'forbidden' | 'exists'

/** `rateLimited`: the host refused because of its rate limit (`CodeHostError.retryAt` says until when Workhub waits). */
export type CodeHostErrorKind = 'missingCli' | 'signedOut' | 'failed' | 'unsupported' | 'rateLimited' | CodeHostFailure

/** An error from the host with a message fit for the user (the CLI's own text). */
export class CodeHostError extends Error {
  constructor(
    message: string,
    readonly kind: CodeHostErrorKind = 'failed',
    /** For `rateLimited`: epoch milliseconds before which the host is not asked again. */
    readonly retryAt?: number
  ) {
    super(message)
    this.name = 'CodeHostError'
  }
}
