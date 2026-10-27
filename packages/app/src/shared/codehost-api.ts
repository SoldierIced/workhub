// Types of the pull request bridge (window.hub.codeHost), shared by main, preload and renderer.
import type { CodeHostCapabilities, PullRequestItem, PullRequestView, ReviewAction } from '@workhub/core'

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

export type CodeHostActionResult = { ok: true } | { ok: false; error: string }

/** A tab a pull request window can be asked to open on (the Slack badge opens Slack). */
export type PullRequestWindowTab = 'slack'

export const isPullRequestWindowTab = (tab: unknown): tab is PullRequestWindowTab => tab === 'slack'

export interface CodeHostApi {
  lists(profileId: string | null, force?: boolean): Promise<CodeHostLists>
  view(profileId: string | null, url: string): Promise<PullRequestViewResult>
  review(profileId: string | null, url: string, action: ReviewAction, body: string): Promise<CodeHostActionResult>
  comment(profileId: string | null, url: string, body: string): Promise<CodeHostActionResult>
  reply(profileId: string | null, url: string, threadId: string, body: string): Promise<CodeHostActionResult>
  /** Closes the user's own open PR without merging, with an optional closing comment and the head branch deleted when asked. */
  close(profileId: string | null, url: string, comment: string, deleteBranch: boolean): Promise<CodeHostActionResult>
  /** Opens the PR in its own window (one per PR; an open one is focused), optionally on a tab. */
  openWindow(profileId: string | null, url: string, tab?: PullRequestWindowTab): Promise<void>
  /** Focuses the main window on the Pull requests screen with this PR selected (the PR window's "Show in Workhub"). */
  showInWorkhub(profileId: string | null, url: string): Promise<void>
  /** Fires in the main window when a PR window asked to show a PR there. */
  onFocus(cb: (url: string) => void): () => void
  /** Opens a recognized PR URL in the browser. */
  openExternal(profileId: string | null, url: string): Promise<void>
  /** Fires in a PR window that was already open when it was asked to show a tab. */
  onShowTab(cb: (tab: PullRequestWindowTab) => void): () => void
}
