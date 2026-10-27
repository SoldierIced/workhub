import { Gauge } from 'lucide-react'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { accountTitle, UsageWindowChip, useWindowHover } from '../molecules/UsageWindowRow'
import { UsageRefreshButton } from '../molecules/UsageRefreshButton'
import { ApiSpendList } from '../molecules/ApiSpendList'
import type { UsageGroup } from '../../lib/home'
import { useApiSpend, useKiroSpend, useNow, useUsageSettings } from '../../lib/usage'
import { compactWindows, shortReset } from '../../lib/agent-usage'
import { KiroSpent } from './AgentUsageCard'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/**
 * Plan usage at the bottom of the sidebar (Workhub 1's "Claude usage"), compact so the folders
 * above stay visible: per account its name and next reset, then its main windows side by side
 * (`5h ▮▮▯ 47%  week ▮▯ 91%`). Per-model windows, full dates and credits are on hover. Claude,
 * Codex and Kiro, from what running agents report or from each account's own read (Settings →
 * Usage). Kiro also shows the credits spent today.
 */
export function UsageCard({ groups, running }: { groups: UsageGroup[]; running: number }) {
  const { t, tn, formatDate } = useI18n()
  const hover = useWindowHover()
  const now = useNow()
  const { budget } = useUsageSettings()
  const kiroSpend = useKiroSpend()
  const apiSpend = useApiSpend()
  const hasKiro = groups.some((g) => g.agentId === 'kiro')
  const name = (g: UsageGroup) => {
    const agent = AGENT_NAME[g.agentId] ? t(AGENT_NAME[g.agentId]!) : g.agentId
    return g.agentId === 'kiro' && !g.name ? agent : accountTitle(agent, g.name || t('usage.defaultAccount'))
  }
  return (
    <section aria-label={t('usage.title')} className="rounded-lg border border-border bg-surface px-3 py-2 shadow-sm">
      <header className="flex items-center gap-1.5 text-sm font-medium text-muted">
        <Gauge className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{t('usage.title')}</span>
        <span className="ml-auto shrink-0 text-xs font-normal whitespace-nowrap text-subtle">{tn('usage.running', running)}</span>
        <UsageRefreshButton className="-my-1 size-6" />
      </header>
      {groups.length === 0 && !kiroSpend && !apiSpend.length ? (
        <p className="mt-2 text-xs text-subtle">{t('usage.empty')}</p>
      ) : (
        <div className="mt-1 flex flex-col gap-1">
          {groups.map((g) => {
            const { shown, extra } = compactWindows(g.windows)
            const ceilings = budget.ceilings[g.key]
            const reset = shown.find((w) => w.resetsAt !== undefined)?.resetsAt
            return (
              <div key={g.key} data-testid="usage-account" className="flex flex-col">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium text-text" title={name(g)}>
                    {name(g)}
                  </span>
                  {!g.error && reset !== undefined && (
                    <span className="shrink-0 text-2xs text-subtle tabular-nums" title={t('usage.nextReset')}>
                      {shortReset(reset, now, formatDate)}
                    </span>
                  )}
                </div>
                {g.error ? (
                  <p className="text-xs text-danger" title={g.error}>
                    {t('usage.readFailed')}
                  </p>
                ) : (
                  <div className="flex min-w-0 items-center gap-2.5">
                    {shown.map((w) => (
                      <UsageWindowChip key={w.window} w={w} ceiling={ceilings?.[w.window]} now={now} />
                    ))}
                    {extra.length > 0 && (
                      <span className="shrink-0 cursor-help text-2xs text-subtle" title={extra.map((w) => hover(w, ceilings?.[w.window], now)).join('\n\n')} data-testid="usage-extra">
                        +{extra.length}
                      </span>
                    )}
                    {g.agentId === 'kiro' && kiroSpend && <KiroSpent spend={kiroSpend} remainingKnown compact />}
                  </div>
                )}
              </div>
            )
          })}
          {!hasKiro && kiroSpend && (
            <div data-testid="usage-account" className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-medium text-text">{t('agentUsage.agent.kiro')}</span>
              <KiroSpent spend={kiroSpend} remainingKnown={false} compact />
            </div>
          )}
          <ApiSpendList spend={apiSpend} compact />
        </div>
      )}
    </section>
  )
}
