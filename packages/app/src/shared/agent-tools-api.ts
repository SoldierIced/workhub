/** A `workhub-*` skill in one Claude config folder: absent, Workhub's copy (current or older), or one the user made (left alone). */
export type SkillState = 'missing' | 'current' | 'outdated' | 'own'

/** Workhub's MCP server in an account's Claude Code user settings (for sessions outside Workhub). */
export type GlobalMcpState = 'installed' | 'missing' | 'noClaude' | 'unavailable'

export interface AgentToolsAccount {
  /** The account id, or `default` for Claude Code's own folder. */
  id: string
  /** Empty for the default folder. */
  name: string
  dir: string
  skills: Record<string, SkillState>
  globalMcp: GlobalMcpState
}

export interface AgentToolsStatus {
  /** The skills Workhub ships, by folder name. */
  skills: string[]
  accounts: AgentToolsAccount[]
  /** False on Windows and while the endpoint does not listen: the server cannot be installed outside sessions. */
  globalMcpAvailable: boolean
}

/** Settings → Agents → Workhub tools. */
export interface AgentToolsApi {
  status(): Promise<AgentToolsStatus>
  /** Copies the skills into the account's `skills/` folder; resolves to the ones written. */
  installSkills(accountId: string): Promise<string[]>
  /** Removes Workhub's copies; resolves to the ones removed. */
  removeSkills(accountId: string): Promise<string[]>
  installGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }>
  removeGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }>
}
