import type { AgentAccount, AgentAdapterKind, AgentCapabilities, AgentDefinition } from '../domain/agent'
import type { SessionMonitorSnapshot } from '../domain/monitor'
import type { PermissionModeInfo, SessionModeOption, SessionState } from '../domain/session'
import type { ToolResultView, ToolView } from '../domain/tool-view'

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
  /**
   * The agent's session id, chosen by Workhub so every view of the session (app, console) and
   * its transcript share it. With `resume` the session already exists and is continued.
   */
  agentSessionId?: string
  resume?: boolean
  /** Model to start with; the agent's default when unset. */
  model?: string
  /**
   * Start in the most read-only mode the agent supports (an AI reviewer): Claude's `plan` mode
   * with edit tools denied, or an ACP permission mode such as `plan` / `read-only`.
   */
  readOnly?: boolean
}

/** An image pasted into a prompt, base64 without the `data:` prefix. */
export interface ImageInput {
  mediaType: string
  data: string
}

export interface ModelOption {
  id: string
  name: string
  description?: string
}

export interface StartedSession {
  /** The agent's own session id, when it has one. */
  agentSessionId?: string
  /** Name the agent reports for itself. */
  agentName: string
  permissionMode: PermissionModeInfo | null
  currentModeId?: string
  availableModes?: SessionModeOption[]
  /** A model was asked for but the agent cannot select one (or refused): it runs with its default. */
  modelIgnored?: boolean
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
  /** `view` and `result`: what the call did, per tool (a diff, a command's output), when the agent says. */
  | { sessionId: string; type: 'tool'; toolCallId: string; title?: string; status?: string; kind?: string; detail?: string; view?: ToolView; result?: ToolResultView }
  | { sessionId: string; type: 'permission'; requestId: string; title: string; options: PermissionOption[]; detail?: string }
  /** The agent withdrew a permission request (the turn was interrupted). */
  | { sessionId: string; type: 'permissionCancelled'; requestId: string }
  /** Models the session can switch to, and the current one. */
  | { sessionId: string; type: 'models'; models: ModelOption[]; currentModelId?: string }
  /**
   * Something the agent's harness reports outside the conversation: a hook's output, an
   * informational banner. Shown as its own block, never merged into the agent's reply.
   */
  | { sessionId: string; type: 'notice'; noticeId: string; kind: 'hook' | 'info' | 'warning'; title: string; text: string; failed?: boolean }
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
  /** Runs one prompt turn; `images` only reach agents whose capabilities include `imageInput`. */
  prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<PromptResult>
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

/** Live controls some runtimes offer (the native Claude adapter): model and MCP servers. */
export interface SessionControls {
  setModel(sessionId: string, modelId: string | null): Promise<void>
  /** Asks for a fresh MCP status; it arrives as a `monitor` event. */
  refreshMcp(sessionId: string): void
  reconnectMcp(sessionId: string, server: string): void
  toggleMcp(sessionId: string, server: string, enabled: boolean): void
}

export function hasSessionControls(runtime: AgentRuntime): runtime is AgentRuntime & SessionControls {
  const r = runtime as Partial<SessionControls>
  return typeof r.setModel === 'function' && typeof r.reconnectMcp === 'function' && typeof r.toggleMcp === 'function'
}
