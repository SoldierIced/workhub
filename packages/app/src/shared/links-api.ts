// Types of the session-links bridge (window.hub.links), shared by main, preload and renderer.
import type { Checkout } from '@workhub/core'
import type { HistoryItem } from './api'

/** The facts of a pull request a session needs; the window that asks may not be the one that runs the session. */
export interface PullRequestTarget {
  provider: string
  owner: string
  repo: string
  number: number
  url: string
  title: string
  branch: string
  base: string
  author: string
}

export interface TicketTarget {
  key: string
  title: string
  url?: string
}

/**
 * What a window asks the main window to do with sessions. Pull request and ticket windows have no
 * live sessions of their own, so they send an intent; the main window carries it out and shows the result.
 * - `pullRequestSession`: open the live session linked to the PR, else start one in the matching folder.
 * - `reviewPullRequest`: start a session with a review prompt drafted in the composer, not sent.
 * - `ticketSession`: start a session with a prompt about the ticket drafted in the composer, not sent;
 *   `agent: 'claude'` asks for a Claude session ("Talk with Claude"), else the preferred agent.
 * - `resume`: open a past session again.
 */
export type SessionIntent =
  | { kind: 'pullRequestSession'; profileId: string | null; pr: PullRequestTarget }
  | { kind: 'reviewPullRequest'; profileId: string | null; pr: PullRequestTarget }
  | { kind: 'ticketSession'; profileId: string | null; ticket: TicketTarget; agent?: 'claude' }
  | { kind: 'resume'; profileId: string | null; entry: HistoryItem; mode: 'app' | 'console' }

export interface LinksApi {
  /** Brings the main window forward and asks it to carry out the intent. */
  request(intent: SessionIntent): void
  /** The profile's folders, plus the git worktrees of each, with remote and branch (read-only `git` calls). */
  checkouts(profileId: string | null): Promise<Checkout[]>
  /** Fires in the main window when another window (or itself) sent an intent. */
  onIntent(cb: (intent: SessionIntent) => void): () => void
}
