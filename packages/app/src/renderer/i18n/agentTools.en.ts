/** English copy of Workhub's tools for agents (Settings → Agents → Workhub tools). */
export const agentToolsEn = {
  'agentTools.title': 'Workhub tools for agents',
  'agentTools.help':
    'How agents in your sessions reach Workhub: Plan, automations, history, the review of their changes and flow maps. The MCP server gives them tools; the skills teach them when and how to use them. Both can be on.',
  'agentTools.mcp': 'Give sessions the Workhub MCP server',
  'agentTools.mcpHint': 'Every new session (except reviewers) gets Workhub’s tools. They add some tokens to each turn; Claude Code loads them on demand when there are many.',
  'agentTools.account': 'Claude Code folder',
  'agentTools.defaultAccount': 'Default folder',
  'agentTools.skills': 'Skills',
  'agentTools.skillsHint': 'Copies the workhub-* skills into {dir}/skills. Folders you made with the same name are left alone.',
  'agentTools.skills.missing': 'Not installed',
  'agentTools.skills.current': 'Installed',
  'agentTools.skills.outdated': 'Update available',
  'agentTools.skills.own': 'Your own copy',
  'agentTools.install': 'Install',
  'agentTools.update': 'Update',
  'agentTools.remove': 'Remove',
  'agentTools.globalMcp': 'MCP outside Workhub',
  'agentTools.globalMcpHint': 'Adds the server to Claude Code’s user settings, so `claude` in any terminal reaches this Workhub while it is open.',
  'agentTools.globalMcp.installed': 'Installed',
  'agentTools.globalMcp.missing': 'Not installed',
  'agentTools.globalMcp.noClaude': 'Claude Code not found',
  'agentTools.globalMcp.unavailable': 'Not available here',
  'agentTools.done': 'Done',
  'agentTools.failed': 'It did not work: {error}'
} as const
