import type { AgentAccount, AgentAdapterKind, AgentCapabilities, AgentDefinition } from '../domain/agent'
import type { SessionMonitorSnapshot } from '../domain/monitor'
import type { PermissionModeInfo, SessionModeOption, SessionState } from '../domain/session'

export interface StartSessionRequest {
  /** Workhub's session id; every event of the session carries it. */
  sessionId: string
  agent: AgentDefinition
  account: AgentAccount | null
  cwd: string
  /** Environment added on top of the inherited one (see `launchEnvironment`). */
  env: Record<string, string>
  /** Initial terminal size, for terminal sessions. */
  cols?: number
  rows?: number
}

export interface StartedSession {
  /** The agent's own session id, when it has one. */
  agentSessionId?: string
  /** Name the agent reports for itself. */
  agentName: string
  permissionMode: PermissionModeInfo | null
  currentModeId?: string
  availableModes?: SessionModeOption[]
}

export interface PermissionOption {
  optionId: string
  name: string
  /** ACP option kind: allow_once, allow_always, reject_once, reject_always. */
  kind: string
}

export interface PromptResult {
  stopReason: string
}

/** Everything a runtime reports about a session, tagged with Workhub's session id. */
export type AgentEvent =
  | { sessionId: string; type: 'state'; state: SessionState; error?: string }
  | { sessionId: string; type: 'message'; role: 'agent' | 'thought'; text: string }
  | { sessionId: string; type: 'tool'; toolCallId: string; title?: string; status?: string; kind?: string }
  | { sessionId: string; type: 'permission'; requestId: string; title: string; options: PermissionOption[] }
  | { sessionId: string; type: 'permissionMode'; mode: PermissionModeInfo; currentModeId?: string }
  /** Partial monitor update; the receiver merges it (see `mergeMonitor`). */
  | { sessionId: string; type: 'monitor'; snapshot: SessionMonitorSnapshot }
  /** Raw terminal output (terminal adapter). */
  | { sessionId: string; type: 'output'; data: string }
  | { sessionId: string; type: 'stderr'; line: string }
  | { sessionId: string; type: 'exit'; code: number | null }

export type AgentEventListener = (event: AgentEvent) => void
export type Unsubscribe = () => void

/**
 * Runs agent sessions over one transport (PLAN D8). One runtime instance serves many sessions.
 */
export interface AgentRuntime {
  readonly adapter: AgentAdapterKind
  /** Capabilities of the agent when run through this runtime. */
  capabilities(agent: AgentDefinition): AgentCapabilities
  /** Spawns the agent and opens the session. Emits `state: starting` right away. */
  start(request: StartSessionRequest): Promise<StartedSession>
  prompt(sessionId: string, text: string): Promise<PromptResult>
  cancel(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  stopAll(): Promise<void>
  /** Answers a `permission` event; `null` cancels the request. */
  respondPermission(sessionId: string, requestId: string, optionId: string | null): void
  /** Event stream for every session of this runtime. */
  subscribe(listener: AgentEventListener): Unsubscribe
}

/** Raw I/O for runtimes that drive a terminal. */
export interface TerminalControl {
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
}

export function isTerminalControl(runtime: AgentRuntime): runtime is AgentRuntime & TerminalControl {
  const r = runtime as Partial<TerminalControl>
  return typeof r.write === 'function' && typeof r.resize === 'function'
}
