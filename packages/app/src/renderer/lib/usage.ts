import { useEffect, useMemo, useRef, useState } from 'react'
import { accountAgentId, appOptions, type UsageBudgetOptions } from '@workhub/core'
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

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex' }

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
