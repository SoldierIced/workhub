/**
 * The common session monitor model (PLAN D9, "Session monitor"). Every agent fills what it has;
 * every field is optional and a missing field hides its UI, never breaks the session.
 */

export interface TokenUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

export interface Money {
  amount: number
  currency: string
}

export interface ContextUsage {
  /** Tokens in the context window, when known. */
  used?: number
  /** Window size in tokens, when known. */
  size?: number
  /** 0-100. */
  percent?: number
}

export interface ToolCallSummary {
  id: string
  /** What the call did, in words ("Read config.ts", "Ran the tests"). */
  title: string
  /** The command, path or URL behind the title. */
  detail?: string
  /** ACP tool kind: read, edit, execute, fetch, other... */
  kind?: string
  /** pending, in_progress, completed, failed. */
  status?: string
  /** Epoch milliseconds. */
  startedAt?: number
  endedAt?: number
}

export interface SubagentSummary {
  id: string
  name?: string
  /** running, completed, failed, stopped. */
  status?: string
  /** Subagent type, e.g. `general-purpose`. */
  type?: string
  description?: string
  model?: string
  tokens?: TokenUsage
  cost?: Money
  /** The last thing it did, in words. */
  lastStep?: string
  stepCount?: number
  /** Epoch milliseconds. */
  startedAt?: number
  lastActivityAt?: number
}

export interface PlanUsageWindow {
  /** e.g. `5h`, `weekly`, `monthly`. */
  window: string
  percent: number
  resetsAt?: number
  /** When the agent reported this figure (epoch ms), for a reading taken from an older local file. */
  asOf?: number
}

export type McpServerState = 'loading' | 'running' | 'needs-auth' | 'failed' | 'disabled' | 'unknown'

export interface McpServerStatus {
  name: string
  state: McpServerState
  toolCount?: number
  /** Tool names without the server prefix, when the agent reports them. */
  tools?: string[]
  /** Why the server failed, when the agent says. */
  error?: string
  /** Where the server is configured (user, project, plugin...), when the agent says. */
  source?: string
}

export interface SessionMonitorSnapshot {
  title?: string
  model?: string
  tokens?: TokenUsage
  cost?: Money
  /** Credits used by the whole session (Kiro). */
  credits?: number
  /** Credits used by the last turn (Kiro). */
  lastTurnCredits?: number
  /** Credits used by each turn, oldest first (Kiro). */
  turnCredits?: number[]
  context?: ContextUsage
  toolCalls?: ToolCallSummary[]
  subagents?: SubagentSummary[]
  /** Time the agent spent working, in ms. */
  activeTimeMs?: number
  planUsage?: PlanUsageWindow[]
  mcpServers?: McpServerStatus[]
  /** Pull request URLs the session's tool calls and commands created or touched, oldest first. */
  pullRequests?: string[]
  /** Ticket keys (`ABC-123`) named in the session's prompts, tool calls and commands, oldest first. */
  ticketKeys?: string[]
}

export type MonitorField =
  | 'title'
  | 'model'
  | 'tokens'
  | 'cost'
  | 'credits'
  | 'context'
  | 'toolCalls'
  | 'subagents'
  | 'activeTime'
  | 'planUsage'
  | 'mcpServers'
  | 'pullRequests'
  | 'tickets'
