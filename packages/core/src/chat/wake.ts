import type { SessionState } from '../domain/session'
import { plainText } from './links'
import type { ChatReply, TrackedThread } from './types'

/** What the wake planner needs to know about an open session. */
export interface WakeCandidate {
  id: string
  /** Stable identity (`sessionIdentity`). */
  identity: string
  state: SessionState
  startedAt: number
}

/** How long a session Workhub opened for a wake is given to start before it is opened again. */
export const WAKE_OPENING_GRACE_MS = 120_000

export type WakePlan =
  /** Type the replies into this session now. */
  | { kind: 'deliver'; sessionId: string }
  /** Try again later: the owner is busy or still opening. */
  | { kind: 'wait'; reason: 'busy' | 'opening' }
  /** Open the owner in Workhub, in its own project folder, and deliver once it is ready. */
  | { kind: 'reopen'; identity: string; cwd: string; agentKey?: string }
  /** Do not wake: notify the replies instead (an automation that is off, a session open elsewhere). */
  | { kind: 'notifyOnly'; reason: string }
  /** The owner's transcript is gone: it cannot be resumed. */
  | { kind: 'missing' }

export interface WakeContext {
  /** Every session Workhub has, open or stopped. */
  sessions: readonly WakeCandidate[]
  now: number
  /** When Workhub last opened the owner for a wake, if it did. */
  openingSince?: number
  /** Why the owner must not be woken (its automation is off, or does not take replies). */
  blocked?: string | null
  /** Why the owner counts as open outside Workhub (another terminal), if it does. */
  openElsewhere?: string | null
  /** Where the owner's transcript says it worked; null when the transcript was not found. */
  transcriptCwd: string | null
}

const live = (s: WakeCandidate) => s.state !== 'stopped' && s.state !== 'error'

/** The one open session of an identity; the newest when (unexpectedly) there are several. */
export function liveSessionOf(sessions: readonly WakeCandidate[], identity: string): WakeCandidate | undefined {
  return sessions.filter((s) => s.identity === identity && live(s)).sort((a, b) => b.startedAt - a.startedAt)[0]
}

/** Whether a session of the identity was started at or after `since` (and, being here, is no longer live). */
function openedSince(sessions: readonly WakeCandidate[], identity: string, since: number): boolean {
  return sessions.some((s) => s.identity === identity && !live(s) && s.startedAt >= since)
}

/**
 * Where the replies waiting on a thread go. Replies reach exactly one session: the thread's
 * owner, open in Workhub (delivered when idle), else opened once (a second wake while it starts
 * waits instead of opening another copy, and one that failed to open is not opened again for the
 * same replies). A reopened session runs in the folder its transcript
 * records, never in the folder the message was sent from.
 */
export function planWake(thread: Pick<TrackedThread, 'owner' | 'ownerAgentKey' | 'closed' | 'wake'>, ctx: WakeContext): WakePlan {
  if (!thread.owner || thread.closed || !thread.wake) return { kind: 'notifyOnly', reason: 'not listening' }
  if (ctx.blocked) return { kind: 'notifyOnly', reason: ctx.blocked }
  const open = liveSessionOf(ctx.sessions, thread.owner)
  if (open) return open.state === 'ready' ? { kind: 'deliver', sessionId: open.id } : { kind: 'wait', reason: 'busy' }
  // The session Workhub opened for these replies failed or was stopped: opening it again would leave
  // one more chat behind on every try. The replies are notified; the next ones try once more.
  if (ctx.openingSince !== undefined && openedSince(ctx.sessions, thread.owner, ctx.openingSince)) return { kind: 'notifyOnly', reason: 'openFailed' }
  if (ctx.openingSince !== undefined && ctx.now - ctx.openingSince < WAKE_OPENING_GRACE_MS) return { kind: 'wait', reason: 'opening' }
  if (ctx.openElsewhere) return { kind: 'notifyOnly', reason: ctx.openElsewhere }
  if (!ctx.transcriptCwd) return { kind: 'missing' }
  return { kind: 'reopen', identity: thread.owner, cwd: ctx.transcriptCwd, ...(thread.ownerAgentKey ? { agentKey: thread.ownerAgentKey } : {}) }
}

/** What is typed into the session (Workhub 1's wording, which the agent reads, so kept in English). */
export function wakeText(thread: Pick<TrackedThread, 'title' | 'permalink'>, replies: readonly ChatReply[]): string {
  const lines = replies.map((r) => `${r.user}: ${plainText(r.text)}`).join('\n')
  return `New reply in the tracked Slack thread "${thread.title}" (${thread.permalink}):\n${lines}\nReview it and continue with what is needed.`
}
