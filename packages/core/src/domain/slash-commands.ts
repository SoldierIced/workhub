/**
 * Slash commands typed in the chat composer: the ones Workhub runs itself (`/rename`), the agent's
 * own commands, and its skills and custom commands. Pure: the composer's menu and its tests use it.
 */

/** Where a command comes from; also the order the composer's menu groups them in. */
export type SlashCommandGroup = 'workhub' | 'agent' | 'skill'

export interface SlashCommandInfo {
  /** Without the leading slash. */
  name: string
  description?: string
  /** What the command takes, e.g. `<name>`. */
  argumentHint?: string
  group: SlashCommandGroup
}

/** The groups in menu order. */
export const SLASH_COMMAND_GROUPS: readonly SlashCommandGroup[] = ['workhub', 'agent', 'skill']

/** A command name: letters, digits and `_ - . :` (plugin skills read `plugin:skill`), never a path. */
const COMMAND = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/

/** `/name args` -> its name and arguments (trimmed); null when the text is not a slash command. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = COMMAND.exec(text.trim())
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : null
}

/** The command name being typed: the draft is `/` plus a word and nothing after it; null otherwise. */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith('/') || /\s/.test(draft)) return null
  return draft.slice(1)
}

/**
 * The commands that match what was typed, by group (Workhub, agent, skills). Inside a group the
 * names that start with the query come first, then the ones that only contain it; shorter names
 * first, as Workhub 1 sorted its completions.
 */
export function filterSlashCommands(commands: readonly SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.toLowerCase()
  const rank = (c: SlashCommandInfo) => (c.name.toLowerCase().startsWith(q) ? 0 : 1)
  return commands
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        SLASH_COMMAND_GROUPS.indexOf(a.group) - SLASH_COMMAND_GROUPS.indexOf(b.group) ||
        rank(a) - rank(b) ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name)
    )
}

/** One entry per name: the first wins, so Workhub's own commands hide an agent's command of the same name. */
export function uniqueSlashCommands(commands: readonly SlashCommandInfo[]): SlashCommandInfo[] {
  const seen = new Set<string>()
  return commands.filter((c) => {
    const key = c.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const builtin = (name: string, description: string, argumentHint?: string): SlashCommandInfo => ({ name, description, group: 'agent', ...(argumentHint ? { argumentHint } : {}) })

/**
 * Claude Code's built-in commands that work in a chat session, from its documentation
 * (docs.claude.com, "Slash commands"). Shown until the session reports its own list, which also
 * carries the user's and the project's skills and custom commands.
 */
export const CLAUDE_BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  builtin('clear', 'Clear the conversation and start a new one'),
  builtin('compact', 'Compact the conversation, with optional instructions', '[instructions]'),
  builtin('context', 'Show what fills the context window'),
  builtin('cost', 'Show the cost and duration of this session'),
  builtin('usage', 'Show plan usage limits'),
  builtin('init', 'Write a CLAUDE.md for this project'),
  builtin('memory', 'Show the memory files in use'),
  builtin('model', 'Change the model', '[model]'),
  builtin('mcp', 'Show the MCP servers'),
  builtin('review', 'Review a pull request'),
  builtin('security-review', 'Review the pending changes for security issues'),
  builtin('pr-comments', 'Get the comments of a pull request'),
  builtin('status', 'Show the version, model and account'),
  builtin('todos', 'List the current to-dos'),
  builtin('release-notes', 'Show the release notes'),
  builtin('help', 'Show the available commands')
]

/**
 * Kiro CLI's built-in commands, from its documentation (kiro.dev, "Slash commands"). Kiro reports
 * its list over ACP once the session starts (`_kiro.dev/commands/available`).
 */
export const KIRO_BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  builtin('agent', 'Select or list the available agents'),
  builtin('model', 'Select the model', '[model]'),
  builtin('context', 'Manage the context files'),
  builtin('compact', 'Summarize the conversation to free context'),
  builtin('clear', 'Clear the conversation'),
  builtin('tools', 'Show the tools and their permissions'),
  builtin('mcp', 'Show the MCP servers'),
  builtin('prompts', 'List the saved prompts'),
  builtin('hooks', 'Show the context hooks'),
  builtin('usage', 'Show the usage and credits'),
  builtin('todos', 'Show the to-do lists'),
  builtin('help', 'Show the available commands')
]

/**
 * The Codex ACP adapter's built-in commands, from its README (github.com/zed-industries/codex-acp).
 * It reports them with `available_commands_update` once the session starts.
 */
export const CODEX_BUILTIN_COMMANDS: readonly SlashCommandInfo[] = [
  builtin('init', 'Write an AGENTS.md for this project'),
  builtin('review', 'Review the current changes'),
  builtin('compact', 'Summarize the conversation to free context')
]

/** The built-in commands known for an agent before its session reports any, by agent id. */
export function knownAgentCommands(agentId: string): readonly SlashCommandInfo[] {
  if (agentId === 'claude' || agentId === 'claude-acp') return CLAUDE_BUILTIN_COMMANDS
  if (agentId === 'kiro') return KIRO_BUILTIN_COMMANDS
  if (agentId === 'codex') return CODEX_BUILTIN_COMMANDS
  return []
}

/**
 * What a session's menu lists after Workhub's own commands: what the agent reported, else its
 * known built-ins (an agent reports nothing until its session has started).
 */
export function agentSlashCommands(agentId: string, reported: readonly SlashCommandInfo[] | undefined): readonly SlashCommandInfo[] {
  return reported?.length ? reported : knownAgentCommands(agentId)
}

/** Reads one command as an agent reports it (`name` with or without its slash); null when it has no name. */
export function readSlashCommand(raw: unknown, group: Exclude<SlashCommandGroup, 'workhub'>): SlashCommandInfo | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o['name'] === 'string' ? o['name'].trim().replace(/^\//, '') : ''
  if (!name || /\s/.test(name)) return null
  const description = typeof o['description'] === 'string' && o['description'].trim() ? o['description'].trim() : undefined
  // Claude's SDK: `argumentHint`; ACP: `input.hint`.
  const input = o['input'] !== null && typeof o['input'] === 'object' ? (o['input'] as Record<string, unknown>) : undefined
  const hint = [o['argumentHint'], input?.['hint']].find((h): h is string => typeof h === 'string' && h.trim().length > 0)?.trim()
  return { name, group, ...(description ? { description } : {}), ...(hint ? { argumentHint: hint } : {}) }
}
