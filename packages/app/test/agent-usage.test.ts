import { describe, expect, it } from 'vitest'
import { DEFAULT_USAGE_BUDGET, emptyConfig, setCeiling, type PlanUsageWindow, type UsageAlertState, type UsageBudgetOptions, type UsageProvider, type WorkhubConfig } from '@workhub/core'
import type { AccountUsage, UsageAlert } from '../src/shared/api'
import { agentKeyBudget, AgentUsageService, DemoUsageProvider, usageAccounts, type UsageAccountRef } from '../src/main/agent-usage'
import { agentUsageSections, budgetWindows, formatCountdown, kiroUsageNote, sessionBudget } from '../src/renderer/lib/agent-usage'
import type { SessionSummary } from '../src/renderer/lib/home'

const NOW = Date.UTC(2026, 9, 27, 12)
const HOUR = 3_600_000

function config(extra: Partial<WorkhubConfig> = {}): WorkhubConfig {
  return { ...emptyConfig(), ...extra }
}

class FakeProvider implements UsageProvider {
  reads: (string | undefined)[] = []
  constructor(
    readonly agentId: string,
    public windows: PlanUsageWindow[] | Error
  ) {}
  async read(configDir: string | undefined): Promise<PlanUsageWindow[]> {
    this.reads.push(configDir)
    if (this.windows instanceof Error) throw this.windows
    return this.windows
  }
}

function service(providers: UsageProvider[], accounts: UsageAccountRef[], budget: UsageBudgetOptions, stored: UsageAlertState = {}) {
  const emitted: AccountUsage[][] = []
  const alerts: UsageAlert[][] = []
  const saved: UsageAlertState[] = []
  let now = NOW
  const svc = new AgentUsageService({
    providers,
    load: async () => ({ accounts, budget, knownKeys: accounts.map((a) => (a.accountId ? `${a.agentId}:${a.accountId}` : a.agentId)) }),
    emit: (u) => void emitted.push(u),
    alert: (a) => void alerts.push(a),
    alertState: { load: () => stored, save: (s) => void saved.push(s) },
    now: () => now
  })
  return { svc, emitted, alerts, saved, setNow: (t: number) => (now = t) }
}

describe('usage accounts', () => {
  it('lists the default folder and each account, once per folder', () => {
    const c = config({
      accounts: [
        { id: 'work', agentId: 'codex', name: 'Work', configDir: '/w/codex' },
        { id: 'same', agentId: 'codex', name: 'Same', configDir: '/w/codex' },
        { id: 'c1', agentId: 'claude', name: 'C1' }
      ]
    })
    expect(usageAccounts(c, 'codex', '/home/u', {})).toEqual([
      { agentId: 'codex', accountId: null, name: '' },
      { agentId: 'codex', accountId: 'work', name: 'Work', configDir: '/w/codex' }
    ])
    // A Claude account without a folder is the default folder.
    expect(usageAccounts(c, 'claude', '/home/u', {})).toEqual([{ agentId: 'claude', accountId: 'c1', name: 'C1' }])
    expect(usageAccounts(c, 'kiro', '/home/u', {})).toEqual([])
  })

  it("respects a CODEX_HOME set in the agent's or the account's env", () => {
    const codex = { id: 'codex', name: 'Codex', adapter: 'acp' as const, command: 'codex-acp', args: [], env: { CODEX_HOME: '/agent/codex' }, capabilities: { appMode: true, transcript: true, usage: true, planUsage: true, history: true, hooks: false, models: false, mcpStatus: false, mcpControl: false, subagents: false, permissionRequests: true, imageInput: false }, modeSemantics: 'none' as const, accountConfigEnv: 'CODEX_HOME' }
    const c = config({ agents: [codex], accounts: [{ id: 'alt', agentId: 'codex', name: 'Alt', env: { CODEX_HOME: '/alt/codex' } }] })
    expect(usageAccounts(c, 'codex', '/home/u', { CODEX_HOME: '/env/codex' })).toEqual([
      { agentId: 'codex', accountId: null, name: '', configDir: '/agent/codex' },
      { agentId: 'codex', accountId: 'alt', name: 'Alt', configDir: '/alt/codex' }
    ])
  })

  it('judges an agent key by the accounts it uses', () => {
    const seen: [string, string | null][] = []
    agentKeyBudget(config(), 'claude-acp:work', (a, b) => (seen.push([a, b]), { action: 'allow' }))
    agentKeyBudget(config(), 'codex', (a, b) => (seen.push([a, b]), { action: 'allow' }))
    expect(seen).toEqual([
      ['claude', 'work'],
      ['codex', null]
    ])
  })
})

describe('the usage service', () => {
  const weekly92: PlanUsageWindow[] = [
    { window: '5h', percent: 40, resetsAt: NOW + 2 * HOUR },
    { window: 'weekly', percent: 92, resetsAt: NOW + 40 * HOUR }
  ]

  it('reads each account with its provider, evaluates budgets and keeps failures readable', async () => {
    const claude = new FakeProvider('claude', weekly92)
    const codex = new FakeProvider('codex', new Error('No Codex ChatGPT sign-in for this folder'))
    const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude', 'weekly', 90)
    const { svc, emitted } = service([claude, codex], [{ agentId: 'claude', accountId: null, name: '' }, { agentId: 'codex', accountId: 'w', name: 'W', configDir: '/w' }], budget)
    const usage = await svc.refresh()
    expect(codex.reads).toEqual(['/w'])
    expect(usage.map((u) => [u.key, u.budget.action, u.error ?? null])).toEqual([
      ['claude', 'block', null],
      ['codex:w', 'allow', 'No Codex ChatGPT sign-in for this folder']
    ])
    expect(emitted).toHaveLength(1)
    expect(svc.budgetOf('claude', null)).toMatchObject({ action: 'block', window: 'weekly' })
    // Fails open for unknown accounts and failed reads.
    expect(svc.budgetOf('codex', 'w').action).toBe('allow')
    expect(svc.budgetOf('claude', 'nobody').action).toBe('allow')
  })

  it('lets the gate open once the window resets, without a new read', async () => {
    const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude', 'weekly', 90)
    const { svc, setNow } = service([new FakeProvider('claude', weekly92)], [{ agentId: 'claude', accountId: null, name: '' }], budget)
    await svc.refresh()
    expect(svc.budgetOf('claude', null).action).toBe('block')
    setNow(NOW + 41 * HOUR)
    expect(svc.budgetOf('claude', null).action).toBe('allow')
  })

  it('alerts once per crossing and window, and stays quiet while alerts are off', async () => {
    const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude', 'weekly', 90)
    const provider = new FakeProvider('claude', weekly92)
    const { svc, alerts, saved } = service([provider], [{ agentId: 'claude', accountId: null, name: '' }], budget)
    await svc.refresh()
    await svc.refresh()
    expect(alerts).toEqual([[{ agentId: 'claude', key: 'claude', name: '', window: 'weekly', threshold: 90, percent: 92, ceiling: true, resetsAt: NOW + 40 * HOUR }]])
    expect(saved).toHaveLength(1)
    const quiet = service([provider], [{ agentId: 'claude', accountId: null, name: '' }], { ...budget, alerts: false })
    await quiet.svc.refresh()
    expect(quiet.alerts).toEqual([])
    expect(quiet.saved).toHaveLength(1)
  })

  it('serves demo windows without reading anything', async () => {
    const windows = await new DemoUsageProvider('claude', () => NOW).read(undefined)
    expect(windows.find((w) => w.window === 'weekly')?.percent).toBe(91)
  })
})

describe('the Usage by agent card', () => {
  const owner = (id: string) => (id === 'claude-acp' ? 'claude' : id)
  const summary = (agentId: string, accountId: string | null, planUsage?: PlanUsageWindow[], credits?: number): SessionSummary => ({
    view: { id: `${agentId}-${accountId}`, state: 'ready', cwd: '/x', startedAt: 1, agentId, accountId },
    items: [],
    monitor: { ...(planUsage ? { planUsage } : {}), ...(credits !== undefined ? { credits } : {}) }
  })
  const read = (agentId: string, accountId: string | null, windows: PlanUsageWindow[], error?: string): AccountUsage => ({
    agentId,
    key: accountId ? `${agentId}:${accountId}` : agentId,
    accountId,
    name: accountId ?? '',
    windows,
    at: NOW,
    budget: { action: 'allow' },
    ...(error ? { error } : {})
  })

  it('groups reads and session reports per agent, Claude first, and drops windows that have reset', () => {
    const sections = agentUsageSections(
      [summary('claude-acp', null, [{ window: '5h', percent: 30, resetsAt: NOW + HOUR }]), summary('codex', 'w', [{ window: '5h', percent: 50, resetsAt: NOW - HOUR }])],
      [read('codex', 'w', [{ window: 'weekly', percent: 61, resetsAt: NOW + 9 * HOUR }]), read('codex', 'x', [], 'HTTP 401')],
      setCeiling(DEFAULT_USAGE_BUDGET, 'codex:w', 'weekly', 60),
      owner,
      NOW
    )
    expect(sections.map((s) => [s.agentId, s.accounts.map((a) => [a.key, a.windows.map((w) => w.window), a.budget.action, a.error ?? null])])).toEqual([
      ['claude', [['claude', ['5h'], 'allow', null]]],
      [
        'codex',
        [
          ['codex:w', ['weekly'], 'block', null],
          ['codex:x', [], 'allow', 'HTTP 401']
        ]
      ]
    ])
  })

  it("notes Kiro only when Kiro ran, with the credits its sessions reported", () => {
    expect(kiroUsageNote([summary('claude', null)], owner)).toBeNull()
    expect(kiroUsageNote([summary('kiro', null, undefined, 1.5), summary('kiro', null, undefined, 2)], owner)).toEqual({ sessions: 2, credits: 3.5 })
  })

  it('gives the composer the verdict of the session account under the current settings', () => {
    const reads = [read('claude', 'work', [{ window: 'weekly', percent: 85, resetsAt: NOW + HOUR }])]
    const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude:work', 'weekly', 80)
    expect(sessionBudget({ agentId: 'claude-acp', accountId: 'work' }, reads, budget, owner, NOW)).toMatchObject({ key: 'claude:work', status: { action: 'block', ceiling: 80 } })
    expect(sessionBudget({ agentId: 'claude-acp', accountId: 'work' }, reads, setCeiling(budget, 'claude:work', 'weekly', null), owner, NOW).status.action).toBe('allow')
    expect(sessionBudget({ agentId: 'shell', accountId: null }, reads, budget, owner, NOW).status.action).toBe('allow')
  })

  it('formats countdowns and lists the windows a budget can be set for', () => {
    expect(formatCountdown(NOW + 45 * 60_000, NOW)).toBe('45m')
    expect(formatCountdown(NOW + 2 * HOUR + 15 * 60_000, NOW)).toBe('2h 15m')
    expect(formatCountdown(NOW + 3 * HOUR, NOW)).toBe('3h')
    expect(formatCountdown(NOW + 76 * HOUR, NOW)).toBe('3d 4h')
    expect(formatCountdown(NOW - HOUR, NOW)).toBe('0m')
    expect(budgetWindows([{ window: 'weekly Opus', percent: 1 }], { custom: 50 })).toEqual(['5h', 'weekly', 'weekly Opus', 'custom'])
  })
})
