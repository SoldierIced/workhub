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
  /**
   * A prompt sent while a turn runs joins that turn (the native Claude adapter: Claude Code folds
   * it in between tool rounds). Without it, a message sent during a turn waits for the turn's end.
   */
  midTurnInput?: boolean
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
   * `{sessionId}` in the args is replaced with the agent's session id, `{model}` in `modelArgs`
   * with the model picked for the session.
   */
  console?: ConsoleLaunch
  /**
   * Args that pick the first session's model or reasoning effort when the agent is launched (ACP
   * agents), e.g. `--model {model}` and `--effort {effort}`; each is added only when one is set.
   */
  modelArgs?: string[]
  effortArgs?: string[]
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
  /** Args that pick the session's model, e.g. `--model {model}`; added only when a model is set. */
  modelArgs?: string[]
}

/**
 * The command line of an agent's console view: resume when the session has history, else start it
 * with its id. A model picked for the session is passed through `modelArgs`; none, or the literal
 * `default` (the agent's own choice), adds nothing.
 */
export function consoleCommand(
  launch: ConsoleLaunch,
  agentSessionId: string | undefined,
  hasHistory: boolean,
  modelId?: string
): { command: string; args: string[] } {
  const extra = !agentSessionId ? [] : hasHistory ? (launch.resumeArgs ?? []) : (launch.newSessionArgs ?? [])
  const model = modelId && modelId !== 'default' ? (launch.modelArgs ?? []).map((a) => a.replaceAll('{model}', modelId)) : []
  return { command: launch.command, args: [...launch.args, ...extra.map((a) => a.replaceAll('{sessionId}', agentSessionId ?? '')), ...model] }
}

/**
 * The args an agent is launched with: its own, then the model and effort asked for through its
 * `modelArgs` / `effortArgs`. A missing value, or the literal `default` model, adds nothing.
 */
export function launchArgs(agent: Pick<AgentDefinition, 'args' | 'modelArgs' | 'effortArgs'>, wanted: { model?: string; effort?: string }): string[] {
  const model = wanted.model && wanted.model !== 'default' ? (agent.modelArgs ?? []).map((a) => a.replaceAll('{model}', wanted.model!)) : []
  const effort = wanted.effort ? (agent.effortArgs ?? []).map((a) => a.replaceAll('{effort}', wanted.effort!)) : []
  return [...agent.args, ...model, ...effort]
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
  /**
   * The executable to start instead of the agent's own command (a full path, or another build on
   * PATH). The agent's args are kept.
   */
  command?: string
  /** Model a new session of this account starts with, unless one is picked for it. */
  defaultModel?: string
  /**
   * Mode a new session starts in, unless one is picked: an ACP session mode id, i.e. the agent or
   * persona for Kiro and OpenCode, the approval preset for Codex.
   */
  defaultMode?: string
}

/** The agent as an account runs it: the account's command replaces the agent's. */
export function accountAgent<A extends Pick<AgentDefinition, 'command'>>(agent: A, account: Pick<AgentAccount, 'command'> | null): A {
  const command = account?.command?.trim()
  return command ? { ...agent, command } : agent
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
