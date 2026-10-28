import { Gauge } from 'lucide-react'
import { AgentIcon } from '../atoms/AgentIcon'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { accountTitle, UsageRowTooltip, UsageWindowRow, useWindowHover } from '../molecules/UsageWindowRow'
import { UsageRefreshButton } from '../molecules/UsageRefreshButton'
import { ApiSpendList } from '../molecules/ApiSpendList'
import type { UsageGroup } from '../../lib/home'
import { useApiSpend, useKiroSpend, useNow, useUsageSettings } from '../../lib/usage'
import { accountHoverText, compactWindows, shortReset } from '../../lib/agent-usage'
import { cn } from '../../lib/cn'
import { KiroSpent, useKiroSpendHover } from './AgentUsageCard'

/** One account in the card: the whole block is the tooltip's target, and shows it is one. */
const ROW = '-mx-1.5 flex cursor-default flex-col rounded-md px-1.5 py-0.5 outline-none hover:bg-surface-hover/60 focus-visible:ring-2 focus-visible:ring-accent/40'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/**
 * Plan usage at the bottom of the sidebar (Workhub 1's "Claude usage"), compact so the folders
 * above stay visible: per account its name and next reset, then its main windows side by side on
 * one line (`5h ▮▮▮▯ 47%  week ▮▮▮▮ 91%`). The other windows, full dates and credits are on hover. Claude,
 * Codex and Kiro, from what running agents report or from each account's own read (Settings →
 * Usage). Kiro reads like a Claude account (its monthly credits); what it spent is on hover, and
 * on the row only while its credits left are not read.
 */
export function UsageCard({ groups, running }: { groups: UsageGroup[]; running: number }) {
  const { t, tn, formatDate } = useI18n()
  const hover = useWindowHover()
  const spendHover = useKiroSpendHover()
  const now = useNow()
  const { budget } = useUsageSettings()
  const kiroSpend = useKiroSpend()
  const apiSpend = useApiSpend()
  const hasKiro = groups.some((g) => g.agentId === 'kiro')
  const agentName = (g: UsageGroup) => (AGENT_NAME[g.agentId] ? t(AGENT_NAME[g.agentId]!) : g.agentId)
  const name = (g: UsageGroup) => (g.agentId === 'kiro' && !g.name ? agentName(g) : accountTitle(agentName(g), g.name || t('usage.defaultAccount')))
  // On the row the agent's mark stands in for its name: "Cuenta por defecto" rather than "Claude · Cuenta por defecto".
  const shortName = (g: UsageGroup) => (g.agentId === 'kiro' && !g.name ? agentName(g) : g.name || t('usage.defaultAccount'))
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
        <div className="mt-1 flex flex-col gap-0.5">
          {groups.map((g) => {
            const { shown } = compactWindows(g.windows)
            const ceilings = budget.ceilings[g.key]
            const reset = shown.find((w) => w.resetsAt !== undefined)?.resetsAt
            const plan = g.windows.find((w) => w.plan)?.plan
            const kiro = g.agentId === 'kiro' && kiroSpend
            // Every window (also the ones only counted as "+n") and Kiro's spend, on hover anywhere over the account.
            const text = accountHoverText(plan ? `${name(g)} · ${plan}` : name(g), [
              ...g.windows.map((w) => hover(w, ceilings?.[w.window], now)),
              g.error,
              kiro ? spendHover(kiroSpend, true) : undefined
            ])
            return (
              <UsageRowTooltip key={g.key} text={text} side="right">
                <div data-testid="usage-account" tabIndex={0} className={ROW}>
                  {/* The agent's mark says which agent it is, so the name gets the room; a long one wraps to a second line. */}
                  <div className="flex items-start gap-1.5 text-xs">
                    <AgentIcon agentId={g.agentId} label={agentName(g)} className="mt-px size-3.5 rounded-sm" />
                    <span className="line-clamp-2 min-w-0 flex-1 leading-snug font-medium break-words text-text" data-testid="usage-account-name">
                      {shortName(g)}
                    </span>
                    {!g.error && reset !== undefined && (
                      <span className="mt-px shrink-0 text-2xs text-subtle tabular-nums" data-testid="usage-reset">
                        {t('usage.resetsShort', { when: shortReset(reset, now, formatDate) })}
                      </span>
                    )}
                  </div>
                  {g.error ? (
                    <p className="text-xs text-danger">{t('usage.readFailed')}</p>
                  ) : (
                    <div className="mt-0.5 flex min-w-0 items-center gap-2.5 pl-5">
                      {shown.map((w) => (
                        <UsageWindowRow key={w.window} w={w} ceiling={ceilings?.[w.window]} now={now} compact className="min-w-0 flex-1" />
                      ))}
                    </div>
                  )}
                </div>
              </UsageRowTooltip>
            )
          })}
          {!hasKiro && kiroSpend && (
            <UsageRowTooltip text={accountHoverText(t('agentUsage.agent.kiro'), [spendHover(kiroSpend, false)])} side="right">
              <div data-testid="usage-account" tabIndex={0} className={cn(ROW, 'flex-row items-baseline gap-2 text-xs')}>
                <span className="min-w-0 flex-1 truncate font-medium text-text">{t('agentUsage.agent.kiro')}</span>
                <KiroSpent spend={kiroSpend} compact />
              </div>
            </UsageRowTooltip>
          )}
          <ApiSpendList spend={apiSpend} compact />
        </div>
      )}
    </section>
  )
}
