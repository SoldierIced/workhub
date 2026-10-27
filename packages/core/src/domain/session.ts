/**
 * A running (or finished) agent session as Workhub tracks it, independent of the transport.
 */

export type SessionState =
  /** The agent process is up and `session/new` (or the PTY spawn) is in flight; 10-15 s for ACP agents. */
  | 'starting'
  /** Waiting for a prompt. */
  | 'ready'
  /** A prompt is running. */
  | 'busy'
  | 'stopped'
  | 'error'

/**
 * The permission mode that actually applies to the session. The agent's own default applies
 * unless Workhub sets one, so Workhub always shows it (P0 finding).
 */
export interface PermissionModeInfo {
  /** Agent-specific id, e.g. `bypassPermissions`; `agent-managed` when the agent sets trust itself. */
  id: string
  label: string
  /** `agent`: reported by the agent. `workhub`: requested by Workhub. `unknown`: not exposed. */
  source: 'agent' | 'workhub' | 'unknown'
  /** True when tools run without asking (bypass / yolo style modes). */
  unattended?: boolean
}

export interface SessionModeOption {
  id: string
  name: string
  description?: string
}

export interface Session {
  /** Workhub's id for the session (not the agent's). */
  id: string
  agentId: string
  accountId: string | null
  profileId: string | null
  cwd: string
  state: SessionState
  /** The agent's own session id (ACP `sessionId`), once known. */
  agentSessionId?: string
  permissionMode: PermissionModeInfo | null
  /** Current persona or mode id when the agent has modes. */
  currentModeId?: string
  availableModes?: SessionModeOption[]
  /** Epoch milliseconds. */
  startedAt: number
  error?: string
}

/** The permission-mode ids Workhub treats as "tools run without asking". */
const UNATTENDED_MODES = new Set(['bypassPermissions', 'yolo', 'full-auto', 'dangerously-skip-permissions'])

export function isUnattendedMode(id: string): boolean {
  return UNATTENDED_MODES.has(id)
}
