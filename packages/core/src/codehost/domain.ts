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

/** An error from the host with a message fit for the user (the CLI's own text). */
export class CodeHostError extends Error {
  constructor(
    message: string,
    readonly kind: 'missingCli' | 'signedOut' | 'failed' | 'unsupported' = 'failed'
  ) {
    super(message)
    this.name = 'CodeHostError'
  }
}
