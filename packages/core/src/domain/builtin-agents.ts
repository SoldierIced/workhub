import { NO_CAPABILITIES, type AgentDefinition } from './agent'

/**
 * Agents Workhub knows out of the box. Users can add their own in the config (`agents`), and a
 * custom agent with the same id replaces the built-in one.
 *
 * Capabilities list only what was observed (P0 spike, spike/README.md); transcript readers and
 * the native Claude adapter arrive in P2/P5 and will turn more flags on.
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code (ACP)',
    adapter: 'acp',
    // The official ACP adapter; the native Agent SDK adapter replaces it in P2 (PLAN D8).
    command: 'claude-agent-acp',
    args: [],
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      usage: true,
      history: true,
      hooks: true,
      models: true,
      permissionRequests: true
    },
    modeSemantics: 'permission',
    accountConfigEnv: 'CLAUDE_CONFIG_DIR',
    builtIn: true
  },
  {
    id: 'kiro',
    name: 'Kiro',
    adapter: 'acp',
    command: 'kiro-cli',
    args: ['acp'],
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      usage: true,
      history: true,
      models: true,
      mcpStatus: true,
      subagents: true,
      permissionRequests: true
    },
    modeSemantics: 'persona',
    builtIn: true
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    adapter: 'acp',
    command: 'opencode',
    args: ['acp'],
    capabilities: { ...NO_CAPABILITIES, appMode: true, permissionRequests: true },
    modeSemantics: 'none',
    builtIn: true
  },
  {
    id: 'shell',
    name: 'Shell',
    adapter: 'terminal',
    // Empty command: the terminal adapter starts the user's login shell.
    command: '',
    args: [],
    capabilities: { ...NO_CAPABILITIES },
    modeSemantics: 'none',
    builtIn: true
  }
]
