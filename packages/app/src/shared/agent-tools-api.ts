/** A `workhub-*` skill in one skills folder: absent, Workhub's copy (current or older), or one the user made (left alone). */
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

/** Another agent that reads `SKILL.md` skills from a folder of its own (Codex, OpenCode, Gemini CLI, Kiro). */
export interface AgentToolsAgent {
  /** `agent:<agent id>`, the target of install and remove. */
  id: string
  agentId: string
  name: string
  /** The agent's skills folder. */
  dir: string
  skills: Record<string, SkillState>
}

export interface AgentToolsStatus {
  /** The skills Workhub ships, by folder name. */
  skills: string[]
  accounts: AgentToolsAccount[]
  /** The other agents installed on this computer. */
  agents: AgentToolsAgent[]
  /** False on Windows and while the endpoint does not listen: the server cannot be installed outside sessions. */
  globalMcpAvailable: boolean
}

/** Settings → Agents → Workhub tools. */
export interface AgentToolsApi {
  status(): Promise<AgentToolsStatus>
  /**
   * Copies the skills (the ones named, or all) into a target's skills folder: a Claude account id
   * (its `skills/` folder) or an agent's `agent:<id>`. Resolves to the ones written.
   */
  installSkills(targetId: string, skills?: string[]): Promise<string[]>
  /** Removes Workhub's copies (the ones named, or all); resolves to the ones removed. */
  removeSkills(targetId: string, skills?: string[]): Promise<string[]>
  installGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }>
  removeGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }>
}
