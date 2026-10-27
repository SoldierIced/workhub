import { Gauge } from 'lucide-react'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { accountTitle, UsageWindowRow } from '../molecules/UsageWindowRow'
import { UsageRefreshButton } from '../molecules/UsageRefreshButton'
import type { UsageGroup } from '../../lib/home'
import { useKiroSpend, useNow, useUsageSettings } from '../../lib/usage'
import { KiroSpent } from './AgentUsageCard'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/**
 * Plan usage at the bottom of the sidebar (Workhub 1's "Claude usage"), compact: per account a
 * small name line and one line per window (bar, percent, short reset; full date on hover), so
 * three or four accounts fit. Claude, Codex and Kiro, from what running agents report or from
 * each account's own read (Settings → Usage). Kiro also shows the credits spent.
 */
export function UsageCard({ groups, running }: { groups: UsageGroup[]; running: number }) {
  const { t, tn } = useI18n()
  const now = useNow()
  const { budget } = useUsageSettings()
  const kiroSpend = useKiroSpend()
  const hasKiro = groups.some((g) => g.agentId === 'kiro')
  const name = (g: UsageGroup) => {
    const agent = AGENT_NAME[g.agentId] ? t(AGENT_NAME[g.agentId]!) : g.agentId
    return g.agentId === 'kiro' && !g.name ? agent : accountTitle(agent, g.name || t('usage.defaultAccount'))
  }
  return (
    <section aria-label={t('usage.title')} className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-sm">
      <header className="flex items-center gap-1.5 text-sm font-medium text-muted">
        <Gauge className="size-3.5" aria-hidden />
        {t('usage.title')}
        <span className="ml-auto text-xs font-normal text-subtle">{tn('usage.running', running)}</span>
        <UsageRefreshButton className="-my-1 size-6" />
      </header>
      {groups.length === 0 && !kiroSpend ? (
        <p className="mt-2 text-xs text-subtle">{t('usage.empty')}</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {groups.map((g) => (
            <div key={g.key} data-testid="usage-account">
              <div className="truncate text-xs font-medium text-text" title={name(g)}>
                {name(g)}
              </div>
              {g.error ? (
                <p className="text-xs text-danger" title={g.error}>
                  {t('usage.readFailed')}
                </p>
              ) : (
                g.windows.map((w) => <UsageWindowRow key={w.window} w={w} ceiling={budget.ceilings[g.key]?.[w.window]} now={now} />)
              )}
              {g.agentId === 'kiro' && kiroSpend && <KiroSpent spend={kiroSpend} remainingKnown />}
            </div>
          ))}
          {!hasKiro && kiroSpend && (
            <div data-testid="usage-account">
              <div className="text-xs font-medium text-text">{t('agentUsage.agent.kiro')}</div>
              <KiroSpent spend={kiroSpend} remainingKnown={false} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
