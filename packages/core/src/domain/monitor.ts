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
  /** The parent's tool call that started it (Claude's Agent/Task call id), when known. */
  toolUseId?: string
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
  /** Amount used and the plan's limit, when the agent reports units rather than only a percent (Kiro credits). */
  used?: number
  limit?: number
  /** The plan the window belongs to, when the agent names it (Kiro's `planName`, e.g. "Kiro Pro"). */
  plan?: string
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
  /** New tokens (input + cache write + output, cache re-reads left out) of each request of the current turn, in order. */
  turnRequests?: number[]
  /** Time the agent spent working, in ms. */
  activeTimeMs?: number
  planUsage?: PlanUsageWindow[]
  mcpServers?: McpServerStatus[]
  /** Pull request URLs the session's tool calls and commands created or touched, oldest first. */
  pullRequests?: string[]
  /** Ticket keys (`ABC-123`) named in the session's prompts, tool calls and commands, oldest first. */
  ticketKeys?: string[]
  /**
   * Folders the session worked in (see `toolWorkPaths`): its cwd as it moved, and the folders its
   * edits, writes, `cd` and `git -C` commands touched; most recent last. Unset for an agent that
   * does not report them, which leaves "Local changes" on the session's folder.
   */
  workPaths?: string[]
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

/** Uncommitted changes of one repository (staged, unstaged and untracked, against HEAD). */
export interface RepoChanges {
  /** The repository folder's name. */
  name: string
  root: string
  branch: string | null
  /** `owner/repo` of its `origin` remote, to match it with a code host's pull requests. */
  slug?: string
  /** Changed paths, untracked ones included. */
  files: number
  /** Lines added and removed in tracked files; untracked files are not counted. */
  additions: number
  deletions: number
}

/**
 * The monitor's "Local changes": the repositories the session worked in (`touched`), else the
 * session folder's repository, or, for a folder of repositories, each one right inside it that has changes.
 */
export interface LocalChanges {
  /** More than one repository is listed, by name: a folder of repositories, or several touched ones. */
  nested: boolean
  /**
   * The repositories are the ones the session worked in (its `workPaths`), every one listed even
   * when clean, most recent first; empty while it has worked in none yet.
   */
  touched?: boolean
  /** Repositories read (for a folder of repositories, all of them, with or without changes). */
  scanned: number
  /** Repositories with changes; for a single repository, it is listed even when clean. */
  repos: RepoChanges[]
}
