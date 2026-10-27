/**
 * What needs the user's eyes. A session carries an "unseen" flag when it finishes a turn, asks for
 * a permission or an answer, or fails while it is not on screen; viewing the session clears it.
 * Groups roll their members up into a count and one state dot.
 */
import type { SessionState } from './session'

/** Why a session is unseen. */
export type AttentionKind = 'error' | 'needsAnswer' | 'replied'

const KIND_RANK: Record<AttentionKind, number> = { error: 3, needsAnswer: 2, replied: 1 }

export function strongestAttention(a: AttentionKind | undefined, b: AttentionKind | undefined): AttentionKind | undefined {
  if (!a) return b
  if (!b) return a
  return KIND_RANK[b] > KIND_RANK[a] ? b : a
}

/**
 * The unseen flag after something happened. On screen nothing is flagged (the user is looking);
 * otherwise the flag keeps the most urgent reason until the session is viewed.
 */
export function raiseAttention(current: AttentionKind | undefined, incoming: AttentionKind, onScreen: boolean): AttentionKind | undefined {
  return onScreen ? current : strongestAttention(current, incoming)
}

/**
 * What a state change means for the user: a turn that ended (`busy` to `ready`) is a reply, and
 * a failure is an error. Starting up, stopping on purpose and the first ready are not events.
 */
export function attentionFromTransition(prev: SessionState | undefined, next: SessionState): AttentionKind | null {
  if (prev === next) return null
  if (next === 'error') return 'error'
  if (prev === 'busy' && next === 'ready') return 'replied'
  return null
}

/** The state a session or group shows, most urgent first. */
export type StatusLevel = 'error' | 'needsAnswer' | 'readyToReview' | 'working'

export const STATUS_PRIORITY: readonly StatusLevel[] = ['error', 'needsAnswer', 'readyToReview', 'working']

export interface AttentionInput {
  state: SessionState
  unseen?: AttentionKind
  /** A permission request or question is still waiting, seen or not. */
  awaitingAnswer?: boolean
}

export function statusLevel(s: AttentionInput): StatusLevel | null {
  if (s.state === 'error' || s.unseen === 'error') return 'error'
  if (s.awaitingAnswer || s.unseen === 'needsAnswer') return 'needsAnswer'
  if (s.unseen === 'replied') return 'readyToReview'
  if (s.state === 'busy' || s.state === 'starting') return 'working'
  return null
}

export interface AttentionSummary {
  /**
   * Sessions that need you: an error, a question or permission still waiting (seen or not), an
   * unread reply. The rule the app icon badge and the menu bar icon count by; working ones do not count.
   */
  count: number
  /** The highest-priority state among the sessions, null when none shows one. */
  level: StatusLevel | null
}

export function aggregateAttention(sessions: readonly AttentionInput[]): AttentionSummary {
  let level: StatusLevel | null = null
  let count = 0
  for (const s of sessions) {
    const l = statusLevel(s)
    if (l && l !== 'working') count += 1
    if (l && (!level || STATUS_PRIORITY.indexOf(l) < STATUS_PRIORITY.indexOf(level))) level = l
  }
  return { count, level }
}

/** A notification's title: "<group> · <session title>" for a grouped session. */
export function notificationTitle(sessionTitle: string, groupName?: string): string {
  return groupName ? `${groupName} · ${sessionTitle}` : sessionTitle
}
