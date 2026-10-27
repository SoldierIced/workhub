/**
 * Agents and their capabilities (PLAN D3, D8).
 *
 * An agent declares what it can do; the UI shows only what the agent supports. The adapter kind
 * picks the transport: `native` (an SDK richer than ACP, e.g. the Claude Agent SDK, P2),
 * `acp` (Agent Client Protocol over stdio) or `terminal` (any CLI in a PTY).
 */

export type AgentAdapterKind = 'native' | 'acp' | 'terminal'

export interface AgentCapabilities {
  /** Rich app mode (structured chat, tool cards) instead of a raw terminal. */
  appMode: boolean
  /** Workhub can read the agent's transcript files to fill the session monitor. */
  transcript: boolean
  /** Token, cost or credit usage is reported. */
  usage: boolean
  /** Plan or quota usage (percent of a 5 h / weekly window, credits left). */
  planUsage: boolean
  /** Past sessions can be listed and resumed. */
  history: boolean
  /** The agent runs user hooks (pre/post tool, prompt submit). */
  hooks: boolean
  /** The model can be listed and switched. */
  models: boolean
  /** Live MCP server status (name, state, tool count). */
  mcpStatus: boolean
  /** MCP servers can be reconnected or toggled from Workhub. */
  mcpControl: boolean
  /** Subagents are reported. */
  subagents: boolean
  /** The agent asks Workhub before running tools (allow/deny prompts). */
  permissionRequests: boolean
  /** Prompts can carry images (pasted screenshots). */
  imageInput: boolean
}

export type AgentCapabilityName = keyof AgentCapabilities

export const NO_CAPABILITIES: AgentCapabilities = {
  appMode: false,
  transcript: false,
  usage: false,
  planUsage: false,
  history: false,
  hooks: false,
  models: false,
  mcpStatus: false,
  mcpControl: false,
  subagents: false,
  permissionRequests: false,
  imageInput: false
}

/**
 * What the agent's session "modes" mean.
 * - `permission`: modes are permission modes (Claude: default, acceptEdits, plan, bypassPermissions).
 * - `persona`: modes are agent personas (Kiro agents); tool trust is set inside each persona.
 * - `none`: the agent exposes no modes.
 */
export type ModeSemantics = 'permission' | 'persona' | 'none'

export interface AgentDefinition {
  /** Stable id, lowercase, e.g. `kiro`, `claude`, `shell`. */
  id: string
  /** Display name. */
  name: string
  adapter: AgentAdapterKind
  /** Executable to spawn, resolved through PATH. */
  command: string
  args: string[]
  /** Extra environment for every session of this agent. */
  env?: Record<string, string>
  capabilities: AgentCapabilities
  modeSemantics: ModeSemantics
  /**
   * Environment variable that receives an account's `configDir` (Claude: `CLAUDE_CONFIG_DIR`,
   * Codex: `CODEX_HOME`). Unset when the agent has no per-account config folder.
   */
  accountConfigEnv?: string
  /**
   * The agent's own terminal UI, for the console view of a session (Workhub 1's console mode).
   * `{sessionId}` in the args is replaced with the agent's session id.
   */
  console?: ConsoleLaunch
  /** Id of the transcript reader that fills the monitor of this agent's sessions, e.g. `claude`. */
  transcript?: string
  /** Another agent whose accounts this one uses (Claude over ACP uses the native Claude accounts). */
  accountsOf?: string
  /** True for agents shipped with Workhub; false for agents defined in the user's config. */
  builtIn?: boolean
}

export interface ConsoleLaunch {
  command: string
  args: string[]
  /** Args that open an existing session, e.g. `--resume {sessionId}`. */
  resumeArgs?: string[]
  /** Args that start a new session with an id chosen by Workhub, e.g. `--session-id {sessionId}`. */
  newSessionArgs?: string[]
}

/** The command line of an agent's console view: resume when the session has history, else start it with its id. */
export function consoleCommand(launch: ConsoleLaunch, agentSessionId: string | undefined, hasHistory: boolean): { command: string; args: string[] } {
  const extra = !agentSessionId ? [] : hasHistory ? (launch.resumeArgs ?? []) : (launch.newSessionArgs ?? [])
  return { command: launch.command, args: [...launch.args, ...extra.map((a) => a.replaceAll('{sessionId}', agentSessionId ?? ''))] }
}

/** One account of an agent. An agent can have any number of accounts (not a fixed pair). */
export interface AgentAccount {
  id: string
  agentId: string
  name: string
  /** The agent's config folder for this account, passed through `accountConfigEnv`. */
  configDir?: string
  /** Extra environment for sessions started with this account. */
  env?: Record<string, string>
}

/** The agent id an agent's accounts are bound to. */
export function accountAgentId(agent: Pick<AgentDefinition, 'id' | 'accountsOf'>): string {
  return agent.accountsOf ?? agent.id
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name)
}

/**
 * The environment a session gets on top of the inherited one: the agent's env, then the
 * account's env, then the account's config folder through `accountConfigEnv`. Later wins.
 */
export function launchEnvironment(agent: AgentDefinition, account: AgentAccount | null): Record<string, string> {
  const env: Record<string, string> = { ...agent.env, ...account?.env }
  if (account?.configDir && agent.accountConfigEnv) env[agent.accountConfigEnv] = account.configDir
  return env
}
