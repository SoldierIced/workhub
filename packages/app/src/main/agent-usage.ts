import { join, resolve } from 'node:path'
import {
  accountAgentId,
  accountBudgetStatus,
  evaluateUsageAlerts,
  knownAgents,
  launchEnvironment,
  parseUsageAlertState,
  pruneUsageAlerts,
  usageAccountKey,
  type BudgetStatus,
  type PlanUsageWindow,
  type UsageAlertState,
  type UsageBudgetOptions,
  type UsageProvider,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, UsageAlert } from '../shared/api'

/** One account whose plan usage is read. */
export interface UsageAccountRef {
  /** The agent the accounts belong to (`claude`, `codex`, `kiro`). */
  agentId: string
  /** Null: the agent's own default folder, used by sessions without an account. */
  accountId: string | null
  /** Empty for the default folder; the renderer names it. */
  name: string
  /** Undefined: the provider's own default folder. */
  configDir?: string
}

/** Where each agent keeps its config when nothing points elsewhere. */
const DEFAULT_FOLDER: Record<string, string> = { claude: '.claude', codex: '.codex' }

/**
 * Every config folder of one agent that Workhub knows: each account's folder, plus the default
 * one unless an account already is it. The folder is the one a session of that account gets: the
 * account's `configDir`, else a folder set in the account's or the agent's env (e.g. `CODEX_HOME`
 * in the Codex agent's config), else the variable in Workhub's own environment, else `~/.<agent>`.
 */
export function usageAccounts(config: WorkhubConfig, agentId: string, home: string, env: NodeJS.ProcessEnv = process.env): UsageAccountRef[] {
  const agent = knownAgents(config).find((a) => a.id === agentId)
  const variable = agent?.accountConfigEnv
  if (!agent || !variable) return []
  const configured = agent.env?.[variable] || env[variable]
  const defaultDir = resolve(configured || join(home, DEFAULT_FOLDER[agentId] ?? `.${agentId}`))
  const seen = new Set<string>()
  const out: UsageAccountRef[] = []
  for (const a of config.accounts.filter((x) => x.agentId === agentId)) {
    const own = launchEnvironment(agent, a)[variable]
    const dir = own ? resolve(own) : defaultDir
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({ agentId, accountId: a.id, name: a.name, ...(own ? { configDir: own } : configured ? { configDir: configured } : {}) })
  }
  if (!seen.has(defaultDir)) out.unshift({ agentId, accountId: null, name: '', ...(configured ? { configDir: configured } : {}) })
  return out
}

export interface AgentUsageDeps {
  providers: readonly UsageProvider[]
  /**
   * What to read now: the accounts of every agent whose usage option is on, the budget settings,
   * and the keys of every usage account in the config (alert state of the others is dropped).
   */
  load: () => Promise<{ accounts: UsageAccountRef[]; budget: UsageBudgetOptions; knownKeys: string[] }>
  emit: (usage: AccountUsage[]) => void
  /** Crossings to notify; only called while alerts are on. */
  alert: (alerts: UsageAlert[]) => void
  alertState: { load(fallback: UsageAlertState): UsageAlertState; save(state: UsageAlertState): void }
  now?: () => number
  intervalMs?: number
}

/**
 * Reads plan usage per agent account while the user has it on (Settings → Usage), evaluates the
 * budgets and fires the alerts. The latest reads also gate prompts and automations.
 */
export class AgentUsageService {
  private last: AccountUsage[] = []
  private budget: UsageBudgetOptions | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private alerts: UsageAlertState

  constructor(private readonly deps: AgentUsageDeps) {
    this.alerts = parseUsageAlertState(deps.alertState.load({}))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? 5 * 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  current(): AccountUsage[] {
    return this.last
  }

  /**
   * The budget verdict of an account now: past windows that have reset no longer count. Allow
   * (fail open) when the account is not read or its usage is unknown.
   */
  budgetOf(agentId: string, accountId: string | null): BudgetStatus {
    const u = this.last.find((x) => x.agentId === agentId && x.accountId === accountId)
    if (!u || !this.budget) return { action: 'allow' }
    return accountBudgetStatus(this.budget, u.key, u.windows, this.now())
  }

  async refresh(): Promise<AccountUsage[]> {
    const { accounts, budget, knownKeys } = await this.deps.load()
    this.budget = budget
    const at = this.now()
    this.last = await Promise.all(
      accounts.map(async (a): Promise<AccountUsage> => {
        const key = usageAccountKey(a.agentId, a.accountId)
        const base = { agentId: a.agentId, key, accountId: a.accountId, name: a.name, at }
        const provider = this.deps.providers.find((p) => p.agentId === a.agentId)
        if (!provider) return { ...base, windows: [], error: `No usage reader for ${a.agentId}`, budget: { action: 'allow' } }
        try {
          const windows = await provider.read(a.configDir)
          return { ...base, windows, budget: accountBudgetStatus(budget, key, windows, at) }
        } catch (err) {
          return { ...base, windows: [], error: err instanceof Error ? err.message : String(err), budget: { action: 'allow' } }
        }
      })
    )
    this.checkAlerts(budget, knownKeys, at)
    this.deps.emit(this.last)
    return this.last
  }

  private checkAlerts(budget: UsageBudgetOptions, knownKeys: string[], now: number): void {
    const readings = this.last.filter((u) => u.windows.length).map((u) => ({ accountKey: u.key, windows: u.windows.filter((w) => w.resetsAt === undefined || w.resetsAt > now) }))
    const { state, events } = evaluateUsageAlerts(this.alerts, readings, budget.thresholds, budget.ceilings)
    // Accounts not read this time (failed, or their agent's option is off) keep their entries; removed accounts lose theirs.
    const next = pruneUsageAlerts(state, knownKeys)
    if (JSON.stringify(next) !== JSON.stringify(this.alerts)) this.deps.alertState.save(next)
    this.alerts = next
    if (!budget.alerts || !events.length) return
    this.deps.alert(
      events.map((e) => {
        const u = this.last.find((x) => x.key === e.accountKey)!
        return { agentId: u.agentId, key: e.accountKey, name: u.name, window: e.window, threshold: e.threshold, percent: e.percent, ceiling: e.ceiling, resetsAt: e.resetsAt }
      })
    )
  }
}

/**
 * Synthetic usage (WORKHUB_DEMO_USAGE=1) for screenshots and smoke runs: nothing is read or
 * contacted. The weekly Claude window sits at 91%, so a ceiling below that shows the gate.
 */
export class DemoUsageProvider implements UsageProvider {
  constructor(
    readonly agentId: string,
    private readonly now: () => number = Date.now
  ) {}

  async read(configDir: string | undefined): Promise<PlanUsageWindow[]> {
    const t = this.now()
    // A second account (any config folder) reads a little lower than the default one.
    const shift = configDir ? -20 : 0
    const hours = (h: number) => t + h * 3_600_000
    if (this.agentId === 'kiro') {
      // A monthly credit allowance, as Kiro's `/usage` reports it.
      const reset = new Date(t)
      reset.setMonth(reset.getMonth() + 1, 1)
      reset.setHours(0, 0, 0, 0)
      return [{ window: 'monthly', percent: 33.8, used: 3378.41, limit: 10000, resetsAt: reset.getTime() }]
    }
    if (this.agentId === 'codex') {
      return [
        { window: '5h', percent: Math.max(0, 34 + shift), resetsAt: hours(2.5) },
        { window: 'weekly', percent: Math.max(0, 62 + shift), resetsAt: hours(80) }
      ]
    }
    return [
      { window: '5h', percent: Math.max(0, 47 + shift), resetsAt: hours(1.2) },
      { window: 'weekly', percent: Math.max(0, 91 + shift), resetsAt: hours(52) },
      { window: 'weekly Sonnet', percent: Math.max(0, 23 + shift), resetsAt: hours(52) }
    ]
  }
}

/**
 * The budget verdict for an agent key (`agentId[:accountId]`, as automations and sessions name
 * an agent and account): an agent that uses another one's accounts (Claude over ACP) is judged
 * by the accounts it uses.
 */
export function agentKeyBudget(config: WorkhubConfig, agentKey: string, budgetOf: (agentId: string, accountId: string | null) => BudgetStatus): BudgetStatus {
  const at = agentKey.indexOf(':')
  const agentId = at < 0 ? agentKey : agentKey.slice(0, at)
  const accountId = at < 0 ? null : agentKey.slice(at + 1) || null
  const agent = knownAgents(config).find((a) => a.id === agentId)
  return budgetOf(agent ? accountAgentId(agent) : agentId, accountId)
}
