// Types of the Slack watcher and automations bridges (window.hub.slack, window.hub.automations),
// shared by main, preload and renderer.
import type {
  AutomationDefinition,
  AutomationHealth,
  AutomationRun,
  ChatMessage,
  ChatNotice,
  ChatRun,
  ChatWatcherSettings,
  GateVerdict,
  HookStatus,
  Result,
  TrackedThread,
  TrackError,
  WorkhubConfig
} from '@workhub/core'

export type SlackHealth = 'off' | 'watching' | 'checking' | 'paused' | 'failing'

/** The Claude accounts whose settings can hold the tracking hook. */
export interface SlackHookAccount {
  accountId: string | null
  name: string
  configDir: string
  status: HookStatus
}

export interface SlackSnapshot {
  settings: ChatWatcherSettings
  /** Synthetic Slack (WORKHUB_DEMO_SLACK=1): no agent query, hook setup disabled. */
  demo: boolean
  health: SlackHealth
  /** Why the last scheduled read did not run: outside the days or hours, or the usage guard. */
  skipReason?: 'days' | 'hours' | 'usage'
  /** Epoch ms. */
  nextRunAt?: number
  pausedUntil?: number
  lastError?: string
  messages: ChatMessage[]
  threads: TrackedThread[]
  runs: ChatRun[]
  me: string
  hooks: SlackHookAccount[]
}

export type SlackResult = { ok: true } | { ok: false; error: string }

export interface TrackThreadInput {
  permalink: string
  title?: string
  prUrl?: string
  ticketKey?: string
  /** Session view id to link the thread to (its identity is stored). */
  sessionId?: string
  wake?: boolean
}

/** Something to tell the user, worded by the renderer. */
export type ChatNoticeEvent =
  | ChatNotice
  | { kind: 'watchFailed'; error: string }
  | { kind: 'notWoken'; threadId: string; title: string; reason: string; replies: { user: string; text: string }[] }
  | { kind: 'automationFailed'; automationName: string; outcome: string; detail: string }

/** Demo-mode inputs (WORKHUB_DEMO_SLACK=1 only). */
export type SlackDemoInput =
  | { kind: 'message'; channelId: string; user: string; text: string; ts?: string; replay?: boolean }
  | { kind: 'reply'; threadId: string; user: string; text: string }
  /** What the tracking hook would record when a session sends a message. */
  | { kind: 'sent'; sessionId: string; channelId: string; text: string }

export interface SlackApi {
  get(): Promise<SlackSnapshot>
  saveSettings(settings: ChatWatcherSettings): Promise<Result<WorkhubConfig>>
  /** Reads now, whatever the schedule, window or usage say. */
  runNow(): Promise<void>
  track(input: TrackThreadInput): Promise<{ ok: true } | { ok: false; error: TrackError }>
  trackMessage(channelId: string, ts: string): Promise<void>
  setClosed(threadId: string, closed: boolean): Promise<void>
  setWake(threadId: string, wake: boolean): Promise<void>
  remove(threadId: string): Promise<void>
  /** Hands every reply of the thread (except the user's own) to its session now. */
  sendToSession(threadId: string): Promise<void>
  markViewed(threadIds: string[]): Promise<void>
  /** Adds or removes the tracking hook in the account's Claude settings.json; only on the user's click. */
  setHook(accountId: string | null, install: boolean): Promise<SlackResult>
  demo(input: SlackDemoInput): Promise<SlackResult>
  /** Opens the thread's owning session (reopened in its own folder when closed); the view id, or null. */
  openOwner(threadId: string): Promise<string | null>
  onChanged(cb: (snapshot: SlackSnapshot) => void): () => void
  onNotice(cb: (notice: ChatNoticeEvent) => void): () => void
}

/** One automation with what the engine knows about it right now. */
export interface AutomationStatus {
  definition: AutomationDefinition
  health: AutomationHealth
  /** `window.days`, `limit.window`, `usage`, `rateLimited`, `backoff`… */
  waitReason?: string
  waitUntil?: number
  pausedUntil?: number
  lastError?: string
  lastCheck?: { at: number; verdict: GateVerdict; fired: boolean }
  nextIntervalAt?: number
  startedInWindow: number
  startedToday: number
  /** Identity of its current dedicated session. */
  session?: string
  /** Whether the profile it belongs to has the Automations module on. */
  active: boolean
}

export interface AutomationsSnapshot {
  automations: AutomationStatus[]
  runs: AutomationRun[]
}

export interface AutomationsApi {
  get(): Promise<AutomationsSnapshot>
  save(automation: AutomationDefinition): Promise<Result<WorkhubConfig>>
  remove(id: string): Promise<Result<WorkhubConfig>>
  setEnabled(id: string, enabled: boolean): Promise<Result<WorkhubConfig>>
  runNow(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** Opens the automation's session (resumed when closed); the view id, or null. */
  openSession(id: string): Promise<string | null>
  /** The session the user is looking at, so a replaced session on screen is not stopped under them. */
  setViewing(sessionId: string | null): void
  onChanged(cb: (snapshot: AutomationsSnapshot) => void): () => void
  /** A prompt Workhub typed into a session's chat, so the chat shows it. */
  onPrompted(cb: (sessionId: string, text: string) => void): () => void
  /** The stored config changed outside the renderer (an automation moved a session's sidebar place). */
  onConfigChanged(cb: () => void): () => void
}
