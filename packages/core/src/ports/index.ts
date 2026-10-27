import type { PlanUsageWindow, SessionMonitorSnapshot } from '../domain/monitor'
import type { SubagentConversation, ToolResultView, ToolView } from '../domain/tool-view'
import type { WorkhubConfig } from '../config/schema'
import type { ImageInput } from './agent-runtime'

export * from './agent-runtime'

/** Which transcript to read: the agent's own session id plus where the agent keeps its files. */
export interface TranscriptQuery {
  agentSessionId: string
  cwd: string
  /** The account's config folder (Claude: `CLAUDE_CONFIG_DIR`); the agent's default when unset. */
  configDir?: string
  /** Ticket project keys to look for (`ABC` for `ABC-123`); any key-like text when empty. */
  ticketPrefixes?: string[]
}

/** Reads an agent's transcript files into the common monitor model (PLAN D9). Claude in P2, the others in P5. */
export interface TranscriptReader {
  /** Matches `AgentDefinition.transcript`. */
  readonly id: string
  /**
   * Snapshot of one session, null while the agent has not written a transcript yet. Repeated
   * calls read only what was appended. Fails soft: unknown data is left out, never thrown.
   */
  read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null>
  /** Whether the session has a transcript on disk (it can be resumed). */
  exists(query: TranscriptQuery): Promise<boolean>
  /** Drops the incremental state kept for a session. */
  forget(agentSessionId: string): void
  /** One subagent's conversation (prompt, steps, answer); null when the agent has none on disk. */
  subagent?(query: TranscriptQuery, subagentId: string): Promise<SubagentConversation | null>
}

/** One past session of an agent account, for the session history screen. */
export interface HistoryEntry {
  agentId: string
  accountId: string | null
  agentSessionId: string
  /** Custom title, generated summary or first prompt. */
  title: string
  firstPrompt?: string
  cwd?: string
  gitBranch?: string
  /** Epoch milliseconds. */
  lastModified: number
  createdAt?: number
}

/** A message of a past session, enough to replay the conversation when it is resumed in the app. */
export type HistoryMessage =
  /** `images`: how many the message carried; `imageData`: the ones that could be read back, to show them again. */
  | { kind: 'user'; text: string; images?: number; imageData?: ImageInput[] }
  | { kind: 'agent'; text: string }
  | { kind: 'tool'; id: string; title: string; detail?: string; failed?: boolean; view?: ToolView; result?: ToolResultView }

/** Lists and reads past sessions of one agent account (Claude: the Agent SDK's session store). */
export interface SessionHistorySource {
  list(account: { agentId: string; accountId: string | null; configDir?: string }): Promise<HistoryEntry[]>
  messages(agentSessionId: string, cwd: string, configDir?: string): Promise<HistoryMessage[]>
}

/** Plan usage (5 h, weekly windows) of one agent account. */
export interface PlanUsageReadOptions {
  /** The user asked for a fresh read: skip the reader's own cache (never its rate-limit backoff). */
  force?: boolean
}

export interface PlanUsageReader {
  read(configDir: string | undefined, options?: PlanUsageReadOptions): Promise<PlanUsageWindow[]>
}

/**
 * Plan usage of one agent's accounts (Claude, Codex): a `PlanUsageReader` that names its agent.
 * `read` gets the account's config folder (undefined: the agent's default) and throws a readable
 * error when the account has no usable sign-in or the read failed.
 */
export interface UsageProvider extends PlanUsageReader {
  readonly agentId: string
}

/** Stores secrets (tokens, API keys) by reference. Values never go into the config file. */
export interface SecretStore {
  get(ref: string): Promise<string | null>
  set(ref: string, value: string): Promise<void>
  delete(ref: string): Promise<void>
  has(ref: string): Promise<boolean>
}

/** Loads and saves the Workhub config. `load` returns a migrated, validated config. */
export interface ConfigStore {
  load(): Promise<WorkhubConfig>
  save(config: WorkhubConfig): Promise<void>
}

/** OS notifications (P6). */
export interface Notifier {
  notify(notification: { title: string; body: string; sessionId?: string }): Promise<void>
}

// The ports below are placeholders: their real shapes are designed in the phase noted.

export type { TicketTracker } from '../tickets/ticket-tracker'

// ChatSource and ChatTrackingHook live with the chat domain (`../chat/port`).
