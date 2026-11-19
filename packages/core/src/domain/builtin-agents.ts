import { NO_CAPABILITIES, type AgentDefinition, type ConsoleLaunch } from './agent'

/** `claude` itself, for the console view: a fixed session id, resumed once it has a transcript, on the session's model. */
const CLAUDE_CONSOLE: ConsoleLaunch = {
  command: 'claude',
  args: [],
  resumeArgs: ['--resume', '{sessionId}'],
  newSessionArgs: ['--session-id', '{sessionId}'],
  modelArgs: ['--model', '{model}'],
  mcpConfigArgs: ['--mcp-config', '{mcpConfig}']
}

/**
 * Agents Workhub knows out of the box. Users can add their own in the config (`agents`), and a
 * custom agent with the same id replaces the built-in one.
 *
 * Capabilities list only what was observed (P0 spike, spike/README.md) or what the native Claude
 * adapter and the Claude transcript reader provide (P2), plus the Kiro, OpenCode and Codex readers (P5).
 * `resume` on the ACP agents means Workhub tries `session/load`; whether the agent takes it is its
 * own answer to `initialize` (`loadSession`), so a version without it starts a new conversation
 * with a notice instead of failing.
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    // The Claude Agent SDK through Workhub 1's bridge (PLAN D8): MCP status and control, hooks,
    // models and usage, which ACP does not carry.
    adapter: 'native',
    command: 'claude',
    args: [],
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      transcript: true,
      usage: true,
      planUsage: true,
      history: true,
      hooks: true,
      models: true,
      mcpStatus: true,
      mcpControl: true,
      subagents: true,
      permissionRequests: true,
      imageInput: true,
      midTurnInput: true
    },
    modeSemantics: 'permission',
    accountConfigEnv: 'CLAUDE_CONFIG_DIR',
    console: CLAUDE_CONSOLE,
    transcript: 'claude',
    builtIn: true
  },
  {
    id: 'claude-acp',
    name: 'Claude Code (ACP)',
    adapter: 'acp',
    // The official ACP adapter, kept selectable next to the native one.
    command: 'claude-agent-acp',
    args: [],
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      transcript: true,
      usage: true,
      history: true,
      hooks: true,
      models: true,
      subagents: true,
      permissionRequests: true
    },
    modeSemantics: 'permission',
    accountConfigEnv: 'CLAUDE_CONFIG_DIR',
    console: CLAUDE_CONSOLE,
    transcript: 'claude',
    accountsOf: 'claude',
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
      transcript: true,
      usage: true,
      history: true,
      models: true,
      mcpStatus: true,
      subagents: true,
      permissionRequests: true,
      resume: true
    },
    modeSemantics: 'persona',
    // `kiro-cli acp` takes the first session's model and effort on its command line; ACP has no effort setting.
    modelArgs: ['--model', '{model}'],
    effortArgs: ['--effort', '{effort}'],
    transcript: 'kiro',
    builtIn: true
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    adapter: 'acp',
    command: 'opencode',
    args: ['acp'],
    // Cost, tokens, tool calls and subagents come from the OpenCode database (transcript-opencode).
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      transcript: true,
      usage: true,
      history: true,
      models: true,
      subagents: true,
      permissionRequests: true,
      resume: true
    },
    // OpenCode's modes are agents (build, plan), not permission levels.
    modeSemantics: 'persona',
    transcript: 'opencode',
    builtIn: true
  },
  {
    id: 'codex',
    name: 'Codex',
    adapter: 'acp',
    // The ACP adapter bundles the Codex CLI, so it runs through npx. @zed-industries/codex-acp is
    // deprecated in favor of @agentclientprotocol/codex-acp (npm, 2026-10-27).
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@2.3.0'],
    // Token counts and the 5 h / weekly rate limits come from the rollout files (transcript-codex).
    capabilities: {
      ...NO_CAPABILITIES,
      appMode: true,
      transcript: true,
      usage: true,
      planUsage: true,
      history: true,
      models: true,
      permissionRequests: true,
      resume: true
    },
    // Codex's ACP modes are approval presets (read-only, auto, full-access); not verified live.
    modeSemantics: 'permission',
    accountConfigEnv: 'CODEX_HOME',
    transcript: 'codex',
    // Another Codex client (the app, CLI or IDE) can hold a conversation: a refused resume is
    // reported, not replaced with a new conversation.
    strictResume: true,
    startHint: "check the sandbox, permissions and MCP servers in CODEX_HOME/config.toml (default ~/.codex/config.toml), and Codex's own logs",
    builtIn: true
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    adapter: 'acp',
    // `gemini --acp` starts the Agent Client Protocol server (Gemini CLI docs, acp-mode.md).
    // No transcript reader yet: only what the ACP stream reports.
    command: 'gemini',
    args: ['--acp'],
    capabilities: { ...NO_CAPABILITIES, appMode: true, permissionRequests: true, resume: true },
    modeSemantics: 'permission',
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
