/**
 * Chat watcher domain (PLAN P6, Workhub 1's Slack watcher). Workhub reads chat through an agent's
 * own connector, read-only; it never posts. Everything here is plain data, persisted by the app
 * in its data folder (not in config.json, which only holds the watcher's settings).
 */

/** A channel the watcher reads, by its chat id (`C0123456789` on Slack). */
export interface WatchedChannel {
  id: string
  name: string
  /** What the channel is for ("PR reviews"); given to the agent as context. */
  purpose: string
}

/** A message of a watched channel, as the source returned it. */
export interface ChatMessage {
  channelId: string
  ts: string
  /** The thread it belongs to; equal to `ts` (or absent) for a top-level message. */
  threadTs?: string
  user: string
  text: string
  permalink?: string
  replyCount?: number
  /** Pull request URLs (canonical) and ticket keys found in the text when it was stored. */
  prUrls: string[]
  tickets: string[]
}

export interface ChatReply {
  ts: string
  user: string
  text: string
}

export type WakeOutcome = 'delivered' | 'pending' | 'notifyOnly'

export interface WakeEvent {
  /** Epoch milliseconds. */
  at: number
  outcome: WakeOutcome
  detail: string
}

/** How a thread started being followed. */
export type ThreadSource = 'hook' | 'manual'

/**
 * A chat thread the user follows. New replies notify and, when `wake` is on, are typed into the
 * one session that owns the thread.
 *
 * Ownership is explicit: `owner` is the stable identity (the agent's session id) of the single
 * session that receives the replies. It only changes when the thread had no owner, when the user
 * links it to another session, or when an automation replaces its session (`transferThreads`).
 */
export interface TrackedThread {
  id: string
  channelId: string
  /** The thread root's timestamp. */
  ts: string
  permalink: string
  title: string
  prUrl?: string
  ticketKey?: string
  /** Stable identity of the owning session. */
  owner?: string
  /** `effectiveAgentKey` of the owner, to reopen it with the right agent and account. */
  ownerAgentKey?: string
  /** Whether replies are typed into the owner. */
  wake: boolean
  /** The newest reply already read. */
  lastSeenReplyTs: string
  /** The newest reply the user has looked at; later replies (not from the user) are unread. */
  lastViewedReplyTs?: string
  /** Epoch milliseconds. */
  createdAt: number
  closed: boolean
  /** Why it closed on its own ("pr merged"); unset while open and when the user closed it. */
  closedReason?: AutoCloseReason
  /** When a closed thread was reopened; closing on the PR's state no longer applies. */
  reopenedAt?: number
  /** Set after the first read, which only stores what was already there. */
  seeded: boolean
  replies: ChatReply[]
  source: ThreadSource
  /** The agent account folder the hook reported (`CLAUDE_CONFIG_DIR`). */
  configDir?: string
  /**
   * The folder the session was in when it sent the message, as the hook reported it. Shown for
   * information only: reopening a session always uses its transcript's own folder.
   */
  sentFromCwd?: string
  /** Messages the owner itself sent to the thread; they never wake it. */
  sentTs: string[]
  /** Replies waiting to be handed to the owner (busy, or still opening). */
  pendingWake: ChatReply[]
  lastWakeAt?: number
  /** Latest wake attempts, newest first. */
  wakeLog: WakeEvent[]
}

export type AutoCloseReason = 'prMerged' | 'prClosed' | 'idle'

/** One watcher cycle, for the run log. */
export interface ChatRun {
  id: string
  /** Epoch milliseconds. */
  at: number
  durationMs: number
  costUsd?: number
  ok: boolean
  /** "ok", "nothing new" or the failure text. */
  outcome: string
  messages: number
  replies: number
  /** Tools the source refused because they are not read-only. */
  deniedTools: string[]
}

/** The answer of one read: new messages per channel and new replies per thread. */
export interface ChatDigest {
  channels: { id: string; messages: ChatMessage[] }[]
  threads: { channelId: string; ts: string; replies: ChatReply[] }[]
  /** The user's display name as the source reported it; empty when unknown. */
  me: string
}

/** One message a session sent, as the tracking hook recorded it. */
export interface HookRecord {
  /** The agent's session id: the stable identity of the sender. */
  sessionId: string
  cwd?: string
  configDir?: string
  channelId: string
  ts?: string
  threadTs?: string
  permalink?: string
  title?: string
  text?: string
}

/** Everything the watcher keeps between launches, for every profile and account at once. */
export interface ChatWatcherState {
  messages: Record<string, ChatMessage[]>
  threads: TrackedThread[]
  runs: ChatRun[]
  /** Per channel: the newest message ts stored. */
  cursors: Record<string, string>
  /** False until the first successful read, which only learns what is already there. */
  seeded: boolean
  me: string
}

export const EMPTY_CHAT_STATE: ChatWatcherState = { messages: {}, threads: [], runs: [], cursors: {}, seeded: false, me: '' }

/** What the watcher is set to do; stored in config.json (`chatWatcher`). */
export interface ChatWatcherSettings {
  enabled: boolean
  /** The agent account whose chat connector is read; null for the agent's default folder. */
  accountId: string | null
  model: string
  intervalMinutes: number
  startHour: number
  endHour: number
  /** JavaScript weekdays, 0 = Sunday. Monday to Friday by default. */
  weekdays: number[]
  /** Runs are skipped while the account's 5 h usage is at or above this percentage. */
  usageThreshold: number
  channels: WatchedChannel[]
}

export const MIN_WATCH_INTERVAL_MINUTES = 3

export const DEFAULT_CHAT_WATCHER: ChatWatcherSettings = {
  enabled: false,
  accountId: null,
  model: 'haiku',
  intervalMinutes: 10,
  startHour: 9,
  endHour: 19,
  weekdays: [1, 2, 3, 4, 5],
  usageThreshold: 85,
  channels: []
}
