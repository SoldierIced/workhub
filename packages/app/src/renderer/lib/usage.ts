import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { accountAgentId, appOptions, type ApiAgentSpend, type CreditSpend, type SessionCeilings, type UsageBudgetOptions } from '@workhub/core'
import type { AccountUsage, UsageAlert } from '@shared/api'
import { useConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { formatCountdown } from './agent-usage'

/** Plan usage read per agent account; empty while every agent's option is off (Settings → Usage). */
export function useAccountUsage(): AccountUsage[] {
  const [usage, setUsage] = useState<AccountUsage[]>([])
  useEffect(() => {
    void window.hub.usage.get().then(setUsage)
    return window.hub.usage.onChanged(setUsage)
  }, [])
  return usage
}

/** When the newest account read happened (epoch ms); null when nothing was read. */
export function lastReadAt(reads: readonly Pick<AccountUsage, 'at'>[]): number | null {
  let latest: number | null = null
  for (const r of reads) if (Number.isFinite(r.at) && (latest === null || r.at > latest)) latest = r.at
  return latest
}

/**
 * The usage cards' refresh button: reads every account again, bypassing the readers' caches
 * (a second press within 30 s reuses the previous read, see the main process). The new reads
 * reach every card through `usage:changed`.
 */
export function useUsageRefresh(): { refreshing: boolean; refresh: () => Promise<unknown>; updatedAt: number | null } {
  const reads = useAccountUsage()
  const [refreshing, setRefreshing] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const refresh = useCallback(() => {
    setRefreshing(true)
    return window.hub.usage
      .refreshNow()
      .catch(() => undefined)
      .finally(() => live.current && setRefreshing(false))
  }, [])
  return { refreshing, refresh, updatedAt: lastReadAt(reads) }
}

/** Every session's own ceilings, by session identity (`sessionBudgetId`). */
export function useSessionCeilings(): Record<string, SessionCeilings> {
  const [budgets, setBudgets] = useState<Record<string, SessionCeilings>>({})
  useEffect(() => {
    void window.hub.usage.sessionBudgets().then(setBudgets, () => undefined)
    return window.hub.usage.onSessionBudgetsChanged(setBudgets)
  }, [])
  return budgets
}

/** Kiro credits spent today and this week, from its session files; read on mount and every minute. */
export function useKiroSpend(): CreditSpend | null {
  const [spend, setSpend] = useState<CreditSpend | null>(null)
  useEffect(() => {
    let live = true
    const read = () =>
      void window.hub.usage.kiroSpend().then(
        (s) => live && setSpend(s),
        () => undefined
      )
    read()
    const timer = setInterval(read, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return spend
}

/** Spend of agents billed by API key, per agent over the last 7 days; read on mount and every minute. */
export function useApiSpend(): ApiAgentSpend[] {
  const [spend, setSpend] = useState<ApiAgentSpend[]>([])
  useEffect(() => {
    let live = true
    const read = () =>
      void window.hub.usage.apiSpend().then(
        (s) => live && setSpend(s),
        () => undefined
      )
    read()
    const timer = setInterval(read, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return spend
}

/** The hover text of one agent's API spend: each day's amount, and the tokens no price covers. */
export function apiSpendDetail(spend: ApiAgentSpend, money: (usd: number) => string, unpriced: (tokens: number) => string): string {
  const lines = spend.days.map((d) => `${d.day}: ${money(d.usd)}`)
  if (spend.unpricedTokens > 0) lines.push('', unpriced(spend.unpricedTokens))
  return lines.join('\n')
}

/** The current time, updated every `everyMs` (reset countdowns, windows that reset meanwhile). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/** The budget settings and the agent id → account owner mapping, from the stored config. */
export function useUsageSettings(): { budget: UsageBudgetOptions; accountsOf: (agentId: string) => string } {
  const snap = useConfig()
  return useMemo(() => {
    const agents = snap?.agents ?? []
    return {
      budget: appOptions(snap?.config ?? { options: undefined }).usageBudget,
      accountsOf: (agentId: string) => {
        const agent = agents.find((a) => a.id === agentId)
        return agent ? accountAgentId(agent) : agentId
      }
    }
  }, [snap])
}

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/** "Codex · Work", or "Claude · Default account". */
export function useAccountLabel(): (agentId: string, name: string) => string {
  const { t } = useI18n()
  return (agentId, name) => `${AGENT_NAME[agentId] ? t(AGENT_NAME[agentId]!) : agentId} · ${name || t('agentUsage.defaultAccount')}`
}

/**
 * Usage alerts from the main process, worded in the interface language and shown as OS
 * notifications; a click on one opens Home.
 */
export function useUsageAlerts(onOpen: () => void): void {
  const { t } = useI18n()
  const label = useAccountLabel()
  const latest = useRef({ t, label })
  latest.current = { t, label }
  useEffect(() => {
    const offAlerts = window.hub.usage.onAlerts((alerts: UsageAlert[]) => {
      const { t: tr, label: name } = latest.current
      for (const a of alerts) {
        const params = { window: a.window, percent: Math.round(a.percent), threshold: a.threshold, time: formatCountdown(a.resetsAt, Date.now()) }
        window.hub.usage.notify({
          title: tr('agentUsage.alert.title', { account: name(a.agentId, a.name) }),
          body: tr(a.ceiling ? 'agentUsage.alert.ceiling' : 'agentUsage.alert.threshold', params)
        })
      }
    })
    const offOpen = window.hub.usage.onOpen(onOpen)
    window.hub.usage.ready()
    return () => {
      offAlerts()
      offOpen()
    }
  }, [onOpen])
}
