import type { SessionMonitorSnapshot } from '../domain/monitor'
import type { WorkhubConfig } from '../config/schema'

export * from './agent-runtime'

/** Reads an agent's transcript files into the common monitor model (PLAN D9). Readers ship in P2/P5. */
export interface TranscriptReader {
  readonly agentId: string
  /**
   * Snapshot of one session. `agentSessionId` is the agent's own id; `cwd` helps agents that
   * store transcripts by folder. Fails soft: unknown data is left out, never thrown.
   */
  read(agentSessionId: string, cwd: string): Promise<SessionMonitorSnapshot>
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
