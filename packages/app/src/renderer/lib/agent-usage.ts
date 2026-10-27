import { accountBudgetStatus, liveWindows, usageAccountKey, type BudgetStatus, type PlanUsageWindow, type UsageBudgetOptions } from '@workhub/core'
import type { AccountUsage, SessionView } from '@shared/api'
import type { SessionSummary } from './home'

/** The agents whose usage the Home card lists, in this order. Kiro is listed only to say its limits are not available. */
export const USAGE_CARD_AGENTS = ['claude', 'codex'] as const

/** One account in the "Usage by agent" card. */
export interface AgentAccountUsage {
  key: string
  accountId: string | null
  /** Empty for the agent's default folder. */
  name: string
  windows: PlanUsageWindow[]
  budget: BudgetStatus
  /** The account's own read failed (the message is shown as a tooltip). */
  error?: string
  /** Epoch ms of the account's own read; undefined when only running sessions reported. */
  readAt?: number
}

export interface AgentUsageSection {
  agentId: string
  accounts: AgentAccountUsage[]
}

/** Kiro sessions report credits spent, but Kiro exposes no remaining credits or limits locally. */
export interface KiroUsageNote {
  sessions: number
  credits: number
}

/** Keeps the highest percent per window name. */
function mergeWindows(...lists: readonly (readonly PlanUsageWindow[])[]): PlanUsageWindow[] {
  const byWindow = new Map<string, PlanUsageWindow>()
  for (const list of lists) {
    for (const w of list) {
      const prev = byWindow.get(w.window)
      if (!prev || w.percent > prev.percent) byWindow.set(w.window, w)
    }
  }
  return [...byWindow.values()]
}

/**
 * The "Usage by agent" card: each account's own read (Settings → Usage) where there is one, else
 * what its running sessions reported. Windows that have reset since they were reported are left
 * out. `accountsOf` maps an agent id to the agent whose accounts it uses (Claude over ACP → Claude).
 */
export function agentUsageSections(
  sessions: readonly SessionSummary[],
  reads: readonly AccountUsage[],
  budget: UsageBudgetOptions,
  accountsOf: (agentId: string) => string,
  now: number
): AgentUsageSection[] {
  const accounts = new Map<string, AgentAccountUsage & { agentId: string }>()
  const ensure = (agentId: string, accountId: string | null, name: string) => {
    const key = usageAccountKey(agentId, accountId)
    let a = accounts.get(key)
    if (!a) {
      a = { agentId, key, accountId, name, windows: [], budget: { action: 'allow' } }
      accounts.set(key, a)
    }
    return a
  }
  for (const s of sessions) {
    const reported = s.monitor.planUsage
    const agentId = s.view.agentId ? accountsOf(s.view.agentId) : undefined
    if (!reported?.length || !agentId || !(USAGE_CARD_AGENTS as readonly string[]).includes(agentId)) continue
    const a = ensure(agentId, s.view.accountId ?? null, s.view.accountName ?? '')
    a.windows = mergeWindows(a.windows, reported)
  }
  for (const r of reads) {
    if (!(USAGE_CARD_AGENTS as readonly string[]).includes(r.agentId)) continue
    const a = ensure(r.agentId, r.accountId, r.name)
    a.name = r.name || a.name
    a.readAt = r.at
    if (r.windows.length) a.windows = [...r.windows]
    else if (r.error && !a.windows.length) a.error = r.error
  }
  const sections: AgentUsageSection[] = []
  for (const agentId of USAGE_CARD_AGENTS) {
    const list = [...accounts.values()]
      .filter((a) => a.agentId === agentId)
      .map(({ agentId: _agent, ...a }) => {
        const windows = liveWindows(a.windows, now)
        return { ...a, windows, budget: accountBudgetStatus(budget, a.key, windows, now) }
      })
      .filter((a) => a.windows.length || a.error)
    if (list.length) sections.push({ agentId, accounts: list })
  }
  return sections
}

/** Kiro sessions of this run and the credits they reported; null when there are none. */
export function kiroUsageNote(sessions: readonly SessionSummary[], accountsOf: (agentId: string) => string): KiroUsageNote | null {
  let count = 0
  let credits = 0
  for (const s of sessions) {
    const agentId = s.view.agentId
    if (!agentId || accountsOf(agentId) !== 'kiro') continue
    count++
    credits += s.monitor.credits ?? 0
  }
  return count ? { sessions: count, credits } : null
}

/**
 * The budget verdict for a session's account, for the composer: computed from the latest read of
 * that account and the current Settings, so raising or clearing a ceiling applies at once.
 */
export function sessionBudget(
  view: Pick<SessionView, 'agentId' | 'accountId'>,
  reads: readonly AccountUsage[],
  budget: UsageBudgetOptions,
  accountsOf: (agentId: string) => string,
  now: number
): { key: string; status: BudgetStatus } {
  const agentId = accountsOf(view.agentId)
  const key = usageAccountKey(agentId, view.accountId)
  const read = reads.find((r) => r.key === key)
  return { key, status: read ? accountBudgetStatus(budget, key, read.windows, now) : { action: 'allow' } }
}

/** Compact time until a moment: `45m`, `2h 15m`, `3d 4h`; `0m` once it has passed. */
export function formatCountdown(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** The windows an account's budget can be set for: the usual two, then any other the account reported. */
export function budgetWindows(reported: readonly PlanUsageWindow[], ceilings: Readonly<Record<string, number>> | undefined): string[] {
  const out = ['5h', 'weekly']
  for (const w of [...reported.map((r) => r.window), ...Object.keys(ceilings ?? {})]) if (!out.includes(w)) out.push(w)
  return out
}
