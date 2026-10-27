import { describe, expect, it } from 'vitest'
import {
  accountAgentId,
  BUILTIN_AGENTS,
  DEFAULT_USAGE_BUDGET,
  emptyConfig,
  orderAgents,
  resolveEffectiveAgents,
  setCeiling,
  type AgentAccount,
  type PlanUsageWindow,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage } from '../src/shared/api'
import { DemoUsageProvider } from '../src/main/agent-usage'
import { agentDirectory, agentEngine } from '../src/renderer/lib/agents'
import { agentUsageSections, budgetWindows, sessionBudget, shortReset, usageTone } from '../src/renderer/lib/agent-usage'
import { en } from '../src/renderer/i18n/en'

const NOW = new Date(2026, 9, 27, 12, 0).getTime()
const HOUR = 3_600_000
const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Claude Personal', configDir: '/tmp/claude-personal' }
const work: AgentAccount = { id: 'work', agentId: 'claude', name: 'Claude laboral', configDir: '/tmp/claude-work', defaultModel: 'opus' }
const owner = (id: string) => {
  const agent = BUILTIN_AGENTS.find((a) => a.id === id)
  return agent ? accountAgentId(agent) : id
}
const read = (agentId: string, accountId: string | null, windows: PlanUsageWindow[], error?: string): AccountUsage => ({
  agentId,
  key: accountId ? `${agentId}:${accountId}` : agentId,
  accountId,
  name: '',
  windows,
  at: NOW,
  budget: { action: 'allow' },
  ...(error ? { error } : {})
})

describe('Settings → Agents directory', () => {
  const config: WorkhubConfig = {
    ...emptyConfig(),
    accounts: [personal, work],
    profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: ['personal', 'work'], modules: { flows: false, health: false, chatWatcher: false, automations: false } }]
  }

  it('explains the four Claude entries: two accounts, each through two engines', () => {
    const claude = resolveEffectiveAgents(config, 'p').filter((e) => accountAgentId(e.agent) === 'claude')
    expect(claude.map((e) => e.key)).toEqual(['claude:personal', 'claude:work', 'claude-acp:personal', 'claude-acp:work'])
    expect(claude.map((e) => agentEngine(e.agent))).toEqual(['sdk', 'sdk', 'acp', 'acp'])
    // Each one is still distinct once the engine is shown next to the account.
    expect(new Set(claude.map((e) => `${e.account?.name} ${agentEngine(e.agent)}`)).size).toBe(4)
  })

  it('lists every agent, with Kiro and the Claude ACP engine right after Claude, and the sign-in state of each account', () => {
    const reads = [read('claude', 'personal', [{ window: '5h', percent: 10 }]), read('claude', 'work', [], 'Sign-in expired'), read('kiro', null, [{ window: 'monthly', percent: 25 }])]
    const dir = agentDirectory(BUILTIN_AGENTS, config.accounts, reads, { claude: true, 'claude-acp': true, kiro: true, codex: false })
    expect(dir.map((e) => e.agent.id)).toEqual(['claude', 'claude-acp', 'kiro', 'opencode', 'codex', 'gemini', 'shell'])
    const claude = dir[0]!
    expect(claude.accounts.map((a) => [a.account.id, a.login])).toEqual([
      ['personal', { state: 'ok' }],
      ['work', { state: 'error', error: 'Sign-in expired' }]
    ])
    expect(dir[1]).toMatchObject({ engine: 'acp', sharesAccountsOf: { id: 'claude' }, accounts: [] })
    expect(dir.find((e) => e.agent.id === 'kiro')).toMatchObject({ engine: 'acp', installed: true, accounts: [], defaultLogin: { state: 'ok' } })
    expect(dir.find((e) => e.agent.id === 'codex')).toMatchObject({ installed: false, defaultLogin: { state: 'unknown' } })
    expect(agentDirectory(BUILTIN_AGENTS, [], [], null)[0]!.installed).toBeUndefined()
  })

  it('keeps the order list readable: preferred keys first', () => {
    const ordered = orderAgents(['claude:work', 'kiro'], resolveEffectiveAgents(config, 'p'))
    expect(ordered.slice(0, 2).map((e) => e.key)).toEqual(['claude:work', 'kiro'])
  })

  it('has the copy for every engine', () => {
    for (const k of ['sdk', 'acp', 'terminal']) {
      expect(en[`agents.engine.${k}` as keyof typeof en]).toBeTruthy()
      expect(en[`agents.engine.${k}Hint` as keyof typeof en]).toBeTruthy()
    }
  })
})

describe('session usage limit', () => {
  const reads = [read('claude', 'work', [{ window: 'weekly', percent: 85, resetsAt: NOW + HOUR }])]
  const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude:work', 'weekly', 80)

  it("overrides the account's ceiling for this session and says so", () => {
    expect(sessionBudget({ agentId: 'claude', accountId: 'work' }, reads, budget, owner, NOW)).toMatchObject({ status: { action: 'block' }, fromSession: false })
    expect(sessionBudget({ agentId: 'claude', accountId: 'work' }, reads, budget, owner, NOW, { weekly: 95 })).toMatchObject({ status: { action: 'allow' } })
    expect(sessionBudget({ agentId: 'claude-acp', accountId: 'work' }, reads, DEFAULT_USAGE_BUDGET, owner, NOW, { weekly: 70 })).toMatchObject({
      status: { action: 'block', ceiling: 70 },
      fromSession: true
    })
  })
})

describe('compact usage card helpers', () => {
  const format = (at: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, hour12: false }).format(at)

  it('shows the time today, the weekday within a week, else the date', () => {
    expect(shortReset(new Date(2026, 9, 27, 18, 59).getTime(), NOW, format)).toBe('18:59')
    expect(shortReset(new Date(2026, 9, 29, 17, 59).getTime(), NOW, format)).toBe('Thu 17:59')
    expect(shortReset(new Date(2026, 10, 15).getTime(), NOW, format)).toBe('15 Nov')
  })

  it('keeps the colour thresholds', () => {
    expect(usageTone(50, undefined)).toBe('normal')
    expect(usageTone(76, undefined)).toBe('warning')
    expect(usageTone(91, undefined)).toBe('danger')
    expect(usageTone(56, 60)).toBe('warning')
    expect(usageTone(60, 60)).toBe('danger')
  })

  it('lists Kiro and Codex accounts with Claude, and budgets Kiro on its monthly credits', async () => {
    const kiro = await new DemoUsageProvider('kiro', () => NOW).read(undefined)
    expect(kiro[0]).toMatchObject({ window: 'monthly', used: expect.any(Number), limit: expect.any(Number) })
    const sections = agentUsageSections(
      [],
      [read('claude', 'personal', [{ window: '5h', percent: 10 }]), read('codex', null, [{ window: '5h', percent: 30 }]), read('kiro', null, kiro)],
      DEFAULT_USAGE_BUDGET,
      owner,
      NOW
    )
    expect(sections.map((s) => s.agentId)).toEqual(['claude', 'codex', 'kiro'])
    expect(budgetWindows(kiro, undefined, 'kiro')).toEqual(['monthly'])
  })
})
