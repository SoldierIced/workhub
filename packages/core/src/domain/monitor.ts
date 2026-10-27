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
  title: string
  /** ACP tool kind: read, edit, execute, fetch, other... */
  kind?: string
  status?: string
}

export interface SubagentSummary {
  id: string
  name?: string
  status?: string
}

export interface PlanUsageWindow {
  /** e.g. `5h`, `weekly`, `monthly`. */
  window: string
  percent: number
  resetsAt?: number
}

export type McpServerState = 'loading' | 'running' | 'needs-auth' | 'failed' | 'unknown'

export interface McpServerStatus {
  name: string
  state: McpServerState
  toolCount?: number
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
  context?: ContextUsage
  toolCalls?: ToolCallSummary[]
  subagents?: SubagentSummary[]
  /** Time the agent spent working, in ms. */
  activeTimeMs?: number
  planUsage?: PlanUsageWindow[]
  mcpServers?: McpServerStatus[]
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
