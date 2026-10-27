import type { PlanUsageWindow, SessionMonitorSnapshot } from '../domain/monitor'
import type { WorkhubConfig } from '../config/schema'

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
  | { kind: 'user'; text: string; images?: number }
  | { kind: 'agent'; text: string }
  | { kind: 'tool'; id: string; title: string; detail?: string; failed?: boolean }

/** Lists and reads past sessions of one agent account (Claude: the Agent SDK's session store). */
export interface SessionHistorySource {
  list(account: { agentId: string; accountId: string | null; configDir?: string }): Promise<HistoryEntry[]>
  messages(agentSessionId: string, cwd: string, configDir?: string): Promise<HistoryMessage[]>
}

/** Plan usage (5 h, weekly windows) of one agent account. */
export interface PlanUsageReader {
  read(configDir: string | undefined): Promise<PlanUsageWindow[]>
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

/** Pull requests and repositories (P3: GitHub, GitLab). */
export interface CodeHost {
  readonly provider: string
  /** Whether a URL is a pull/merge request of this host. */
  recognizes(url: string): boolean
}

/** Tickets (P4: Jira, Linear, GitHub Issues). */
export interface TicketTracker {
  readonly provider: string
  /** Whether a string is a ticket key of this tracker, e.g. `ABC-123`. */
  isTicketKey(text: string): boolean
}

/** Chat threads watched for requests (P6: Slack through the agent's MCP). */
export interface ChatSource {
  readonly provider: string
}

/** Environment health signals (P6: Elastic APM; Sentry or Datadog later). */
export interface HealthProvider {
  readonly provider: string
}
