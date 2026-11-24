// Types of the pull request bridge (window.hub.codeHost), shared by main, preload and renderer.
import type { CodeHostCapabilities, CodeHostErrorKind, DiffFile, MergedPullRequest, MergeMethod, PullRequestDetail, PullRequestItem, PullRequestView, RepositoryRef, ReviewAction } from '@workhub/core'

/** Why the lists are empty: nothing is connected, a CLI is missing or logged out, or a read failed. */
export type CodeHostState = 'ready' | 'notConnected' | 'missingCli' | 'signedOut' | 'error'

export interface CodeHostLists {
  state: CodeHostState
  /** Provider id (`github`, `gitlab`) and the CLI it reads through (`gh`, `glab`), when connected. */
  provider?: string
  cli?: string
  login?: string
  /** The CLI's own text when `state` is `error`, or when only one of the two lists could be read. */
  message?: string
  mine: PullRequestItem[]
  toReview: PullRequestItem[]
  /** Epoch milliseconds of the last successful read. */
  updatedAt?: number
  /** Fixture data instead of a real host (WORKHUB_DEMO_CODEHOST). */
  demo?: boolean
}

export type PullRequestViewResult =
  | { ok: true; view: PullRequestView; capabilities: CodeHostCapabilities; provider: string; isMine: boolean }
  | { ok: false; error: string }

/** The detail view without its diff: what the panel shows first. */
export type PullRequestDetailResult =
  | { ok: true; detail: PullRequestDetail; capabilities: CodeHostCapabilities; provider: string; isMine: boolean }
  | { ok: false; error: string }

/** What the Merged view asks: a period (epoch milliseconds, `until` excluded) and whose pull requests. */
export interface MergedRequest {
  since: number
  until: number
  mine: boolean
}

/**
 * The merged pull requests of a period in the profile's scope (its repositories, owners and hidden
 * repositories apply). `state` is the lists' meaning when not `ready`; `unsupported`: the host cannot list merges.
 */
/**
 * What the merged search was narrowed to, for the header: the profile's repositories, its owners,
 * the connection's scope text, the repositories behind its folders, or nothing (only `mine` is allowed then).
 */
export interface MergedScope {
  kind: 'repos' | 'owners' | 'connection' | 'folders' | 'none'
  values: string[]
}

export type MergedPullRequestsResult =
  | { ok: true; items: MergedPullRequest[]; truncated: boolean; provider: string; fetchedAt: number; scope: MergedScope; demo?: boolean }
  | { ok: false; state: CodeHostState | 'unsupported' | 'noScope'; error: string }

/** The files changed by a pull request, read on their own (the diff is the slowest read). */
export type PullRequestDiffResult = { ok: true; files: DiffFile[] } | { ok: false; error: string }

/** `kind`: why the host refused, when it said so (not mergeable, checks failing, no permission, already exists). */
export type CodeHostActionResult = { ok: true } | { ok: false; error: string; kind?: CodeHostErrorKind }

/** Why a session's branch offers no "Create pull request". */
export type PullRequestDraftUnavailable = 'notConnected' | 'notRepo' | 'detached' | 'badBranch' | 'noRemote' | 'onBase' | 'noCommits'

/**
 * What "Create pull request" starts from for a session's branch: the form's first values, or
 * the push the user has to make first (Workhub never pushes), or why there is nothing to offer.
 */
export type PullRequestDraftResult =
  | { state: 'ready'; repository: RepositoryRef; branch: string; base: string; title: string; body: string }
  | { state: 'notPushed'; repository: RepositoryRef; branch: string; /** Commits the remote does not have; 0 when the branch is not on the remote at all. */ unpushed: number; onRemote: boolean; command: string }
  | { state: 'unavailable'; reason: PullRequestDraftUnavailable }

/** What the user confirmed in the form; the repository and branch are read again from the session. */
export interface PullRequestForm {
  title: string
  body: string
  base: string
  draft: boolean
}

export type CreatePullRequestResult = { ok: true; url: string } | { ok: false; error: string; kind?: CodeHostErrorKind }

export type MergeMethodsResult = { ok: true; methods: MergeMethod[] } | { ok: false; error: string }

/** `warning`: merged, but something after it (deleting the branch) failed. */
export type MergeResult = { ok: true; branchDeleted: boolean; warning?: string } | { ok: false; error: string; kind?: CodeHostErrorKind }

/** A tab a pull request window can be asked to open on (the Slack badge opens Slack). */
export type PullRequestWindowTab = 'slack'

export const isPullRequestWindowTab = (tab: unknown): tab is PullRequestWindowTab => tab === 'slack'

export interface CodeHostApi {
  lists(profileId: string | null, force?: boolean): Promise<CodeHostLists>
  view(profileId: string | null, url: string): Promise<PullRequestViewResult>
  /** The PR without its diff (conversation, checks, reviews): faster than `view`. Main keeps it a minute; `fresh` reads the host again. */
  detail(profileId: string | null, url: string, fresh?: boolean): Promise<PullRequestDetailResult>
  /** Merged pull requests of a period; kept a few minutes per profile and request unless `force`. */
  merged(profileId: string | null, request: MergedRequest, force?: boolean): Promise<MergedPullRequestsResult>
  /** The PR's changed files on their own. */
  diff(profileId: string | null, url: string): Promise<PullRequestDiffResult>
  /** One pull request by URL, as the lists show it (title, state, size); null when it cannot be read. Kept for a few minutes. */
  pullRequest(profileId: string | null, url: string): Promise<PullRequestItem | null>
  review(profileId: string | null, url: string, action: ReviewAction, body: string): Promise<CodeHostActionResult>
  comment(profileId: string | null, url: string, body: string): Promise<CodeHostActionResult>
  reply(profileId: string | null, url: string, threadId: string, body: string): Promise<CodeHostActionResult>
  /** Closes the user's own open PR without merging, with an optional closing comment and the head branch deleted when asked. */
  close(profileId: string | null, url: string, comment: string, deleteBranch: boolean): Promise<CodeHostActionResult>
  /** The "Create pull request" form's first values for a session's branch, or why it is not offered. */
  draftPullRequest(sessionId: string): Promise<PullRequestDraftResult>
  /** Opens a PR for the session's pushed branch with what the user confirmed. Never pushes. */
  createPullRequest(sessionId: string, form: PullRequestForm): Promise<CreatePullRequestResult>
  /** The merge methods the PR's repository allows. */
  mergeMethods(profileId: string | null, url: string): Promise<MergeMethodsResult>
  /** Merges an open, mergeable PR now; the head branch is deleted only when asked and not protected. */
  merge(profileId: string | null, url: string, method: MergeMethod, deleteBranch: boolean): Promise<MergeResult>
  /** Opens the PR in its own window (one per PR; an open one is focused), optionally on a tab. */
  openWindow(profileId: string | null, url: string, tab?: PullRequestWindowTab): Promise<void>
  /** Focuses the main window on the Pull requests screen with this PR selected (the PR window's "Show in Workhub"). */
  showInWorkhub(profileId: string | null, url: string): Promise<void>
  /** Fires in the main window when a PR window asked to show a PR there, with the profile the PR window was opened for. */
  onFocus(cb: (url: string, profileId: string | null) => void): () => void
  /** Opens a recognized PR URL in the browser. */
  openExternal(profileId: string | null, url: string): Promise<void>
  /** Fires in every window after a write on a PR succeeded (review, comment, reply, merge, close), so each drops its cached copy. */
  onChanged(cb: (url: string, profileId: string | null) => void): () => void
  /** Fires in a PR window that was already open when it was asked to show a tab. */
  onShowTab(cb: (tab: PullRequestWindowTab) => void): () => void
}
