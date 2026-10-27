import type { ChatDigest, HookRecord, TrackedThread, WatchedChannel } from './types'

/** One read of the watched channels and followed threads. */
export interface ChatReadRequest {
  channels: WatchedChannel[]
  /** Per channel: read messages after this ts. */
  cursors: Record<string, string>
  threads: Pick<TrackedThread, 'channelId' | 'ts' | 'lastSeenReplyTs'>[]
  /** The agent account folder whose chat connector is used; the agent's default when unset. */
  configDir?: string
  model: string
  /** Epoch milliseconds. */
  now: number
}

export type ChatReadFailure = 'failed' | 'noConnector' | 'invalidAnswer' | 'rateLimited'

export type ChatReadResult =
  | { ok: true; digest: ChatDigest; costUsd?: number; deniedTools: string[] }
  | { ok: false; failure: ChatReadFailure; error: string; resetsAt?: number; costUsd?: number; deniedTools: string[] }

/**
 * Chat threads watched for requests (PLAN section 4). Read-only by contract: an adapter never
 * posts, reacts or drafts. Slack is read through an agent's own Slack connector (no token).
 */
export interface ChatSource {
  readonly provider: string
  read(request: ChatReadRequest): Promise<ChatReadResult>
}

export type HookStatus = { state: 'installed' } | { state: 'notInstalled' } | { state: 'unreadable'; message: string }

/**
 * The agent hook that records the chat messages a session sends (Claude Code's PostToolUse hook
 * for Slack). Installing edits the account's agent settings, so it only ever runs on request.
 */
export interface ChatTrackingHook {
  status(configDir: string): Promise<HookStatus>
  install(configDir: string): Promise<void>
  remove(configDir: string): Promise<void>
  /** Takes every record waiting in the inbox. */
  drain(): Promise<HookRecord[]>
}
