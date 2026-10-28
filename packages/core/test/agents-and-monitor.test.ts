import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENTS,
  launchEnvironment,
  mergeMonitor,
  moduleScreens,
  NO_CAPABILITIES,
  resolveEffectiveAgents,
  sessionScreens,
  visibleMonitorFields,
  type AgentDefinition
} from '../src'
import { claudeA, claudeB, config, kiroWork, profile } from './fixtures'

const keys = (c: ReturnType<typeof config>, profileId: string | null) =>
  resolveEffectiveAgents(c, profileId).map((e) => e.key)

describe('resolveEffectiveAgents', () => {
  it('offers every known agent without a profile', () => {
    expect(keys(config(), null)).toEqual(BUILTIN_AGENTS.map((a) => a.id))
  })

  it('expands an agent into one entry per bound account', () => {
    const c = config({ accounts: [claudeA, claudeB, kiroWork], profiles: [profile({ accountIds: ['claude-a', 'claude-b'] })] })
    expect(keys(c, 'acme')).toEqual(['claude:claude-a', 'claude:claude-b', 'claude-acp:claude-a', 'claude-acp:claude-b', 'kiro', 'opencode', 'codex', 'gemini', 'shell'])
  })

  it('limits to the allowed agents, plus agents of bound accounts', () => {
    const c = config({ accounts: [kiroWork], profiles: [profile({ agentIds: ['shell'], accountIds: ['kiro-work'] })] })
    expect(keys(c, 'acme')).toEqual(['kiro:kiro-work', 'shell'])
  })

  it('uses a user agent in place of the built-in with the same id', () => {
    const custom: AgentDefinition = { ...BUILTIN_AGENTS.find((a) => a.id === 'kiro')!, name: 'Kiro (custom)', args: ['acp', '--trace'] }
    const entry = resolveEffectiveAgents(config({ agents: [custom] }), null).find((e) => e.agent.id === 'kiro')
    expect(entry?.agent.args).toEqual(['acp', '--trace'])
    expect(entry?.agent.builtIn).toBe(false)
  })

  it('labels account entries with the account name', () => {
    const c = config({ accounts: [claudeA], profiles: [profile({ accountIds: ['claude-a'], agentIds: [] })] })
    expect(resolveEffectiveAgents(c, 'acme').map((e) => e.label)).toEqual(['Claude Code · Account A'])
  })
})

describe('built-in agents over ACP', () => {
  const agent = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!

  it('start every agent with the command its ACP mode needs', () => {
    expect([agent('kiro'), agent('opencode'), agent('codex'), agent('gemini')].map((a) => [a.adapter, a.command, ...a.args])).toEqual([
      ['acp', 'kiro-cli', 'acp'],
      ['acp', 'opencode', 'acp'],
      ['acp', 'npx', '-y', '@agentclientprotocol/codex-acp@2.3.0'],
      ['acp', 'gemini', '--acp']
    ])
  })

  it('claim a transcript reader only where one exists', () => {
    expect(BUILTIN_AGENTS.filter((a) => a.transcript).map((a) => [a.id, a.transcript])).toEqual([
      ['claude', 'claude'],
      ['claude-acp', 'claude'],
      ['kiro', 'kiro'],
      ['opencode', 'opencode'],
      ['codex', 'codex']
    ])
    expect(agent('gemini').capabilities.transcript).toBe(false)
    for (const a of BUILTIN_AGENTS) expect(a.capabilities.transcript).toBe(Boolean(a.transcript))
  })

  it('show only the monitor data each reader provides', () => {
    const tokens = { total: 10 }
    const snapshot = { tokens, cost: { amount: 1, currency: 'USD' }, credits: 2, planUsage: [{ window: '5h', percent: 10 }] }
    expect(visibleMonitorFields(agent('opencode').capabilities, snapshot)).toEqual(['tokens', 'cost', 'credits'])
    expect(visibleMonitorFields(agent('codex').capabilities, snapshot)).toEqual(['tokens', 'cost', 'credits', 'planUsage'])
    expect(visibleMonitorFields(agent('gemini').capabilities, snapshot)).toEqual([])
  })

  it('pass the Codex account folder through CODEX_HOME', () => {
    expect(launchEnvironment(agent('codex'), { id: 'c', agentId: 'codex', name: 'C', configDir: '/tmp/codex-a' })).toEqual({ CODEX_HOME: '/tmp/codex-a' })
  })
})

describe('launchEnvironment', () => {
  const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!
  const kiro = BUILTIN_AGENTS.find((a) => a.id === 'kiro')!

  it('passes the account config folder through the agent variable', () => {
    expect(launchEnvironment(claude, claudeA)).toEqual({ CLAUDE_CONFIG_DIR: '/tmp/claude-a' })
  })

  it('ignores configDir for agents without a config variable and keeps account env', () => {
    expect(launchEnvironment(kiro, { ...kiroWork, configDir: '/tmp/x' })).toEqual({ ACME_ENV: 'work' })
  })

  it('is empty for the default account', () => {
    expect(launchEnvironment(kiro, null)).toEqual({})
  })
})

describe('monitor view', () => {
  const kiro = BUILTIN_AGENTS.find((a) => a.id === 'kiro')!.capabilities

  it('shows only fields the agent supports and has reported', () => {
    const fields = visibleMonitorFields(kiro, {
      credits: 1.2,
      context: { percent: 8.5 },
      mcpServers: [{ name: 'acme-docs', state: 'running', toolCount: 3 }],
      planUsage: [{ window: '5h', percent: 40 }],
      subagents: []
    })
    // planUsage: not a Kiro capability. subagents: supported but empty.
    expect(fields).toEqual(['credits', 'context', 'mcpServers'])
  })

  it('hides everything for a plain terminal agent', () => {
    expect(visibleMonitorFields(NO_CAPABILITIES, { tokens: { total: 10 }, toolCalls: [{ id: '1', title: 'x' }] })).toEqual([])
  })

  it('treats an object with only undefined values as missing', () => {
    expect(visibleMonitorFields(kiro, { context: { percent: undefined } })).toEqual([])
  })

  it('lists screens from capabilities', () => {
    expect(sessionScreens(kiro)).toEqual(['chat', 'monitor', 'history', 'transcript', 'mcp'])
    expect(sessionScreens(NO_CAPABILITIES)).toEqual(['terminal'])
  })

  it('lists module screens enabled in the profile, never a retired one (Flows)', () => {
    expect(moduleScreens({ flows: true, health: false, chatWatcher: true, automations: false })).toEqual(['chatWatcher'])
    expect(moduleScreens(undefined)).toEqual([])
  })

  it('merges partial updates without erasing fields', () => {
    expect(mergeMonitor({ credits: 1, title: 'a' }, { credits: 2, model: undefined })).toEqual({ credits: 2, title: 'a' })
  })
})
