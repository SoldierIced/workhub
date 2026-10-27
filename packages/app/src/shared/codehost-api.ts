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

export interface CodeHostApi {
  lists(profileId: string | null, force?: boolean): Promise<CodeHostLists>
  view(profileId: string | null, url: string): Promise<PullRequestViewResult>
  review(profileId: string | null, url: string, action: ReviewAction, body: string): Promise<CodeHostActionResult>
  comment(profileId: string | null, url: string, body: string): Promise<CodeHostActionResult>
  reply(profileId: string | null, url: string, threadId: string, body: string): Promise<CodeHostActionResult>
  /** Opens the PR in its own window (one per PR; an open one is focused). */
  openWindow(profileId: string | null, url: string): Promise<void>
  /** Opens a recognized PR URL in the browser. */
  openExternal(profileId: string | null, url: string): Promise<void>
}
