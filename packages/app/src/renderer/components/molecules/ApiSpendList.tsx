import type { ApiAgentSpend } from '@workhub/core'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatTokens } from '../../lib/home'
import { apiSpendDetail } from '../../lib/usage'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/**
 * Spend of agents billed by API key, one line per agent: today and the last 7 days in USD, each
 * day and any unpriced tokens on hover. Renders nothing when no agent spent anything.
 */
export function ApiSpendList({ spend, className, compact = false }: { spend: readonly ApiAgentSpend[]; className?: string; /** Name and amount on two lines (the sidebar). */ compact?: boolean }) {
  const { t, formatNumber } = useI18n()
  const agents = useConfig()?.agents ?? []
  if (!spend.length) return null
  const money = (usd: number) => formatNumber(usd, { style: 'currency', currency: 'USD', maximumFractionDigits: usd > 0 && usd < 1 ? 3 : 2 })
  const name = (id: string) => (AGENT_NAME[id] ? t(AGENT_NAME[id]!) : (agents.find((a) => a.id === id)?.name ?? id))
  return (
    <div className={className} data-testid="api-spend">
      <div className="text-xs font-medium text-muted" title={t('agentUsage.apiSpendHelp')}>
        {t('agentUsage.apiSpend')}
      </div>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {spend.map((s) => (
          <li
            key={s.agent}
            className={compact ? 'flex flex-col text-xs tabular-nums' : 'grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 text-xs tabular-nums'}
            title={`${t('agentUsage.apiSpendDays')}\n${apiSpendDetail(s, money, (n) => t('agentUsage.apiUnpriced', { tokens: formatTokens(n) }))}`}
            data-testid="api-spend-agent"
          >
            <span className="truncate font-medium text-text">{name(s.agent)}</span>
            <span className="text-muted">{t('agentUsage.apiSpendShort', { today: money(s.today), week: money(s.week) })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
