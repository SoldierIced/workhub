import { ArrowRight, Gauge } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ApiAgentSpend, CreditSpend } from '@workhub/core'
import { Badge, Button } from '../atoms'
import { Card, CardBody, CardHeader } from '../molecules/Card'
import { accountTitle, UsageWindowRow } from '../molecules/UsageWindowRow'
import { UsageRefreshButton } from '../molecules/UsageRefreshButton'
import { ApiSpendList } from '../molecules/ApiSpendList'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import type { AgentAccountUsage, AgentUsageSection, KiroUsageNote } from '../../lib/agent-usage'

const round2 = (n: number) => Math.round(n * 100) / 100

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/** Kiro credits spent today and this week, with the per-day split (and why credits left may be missing) on hover. */
export function KiroSpent({ spend, remainingKnown }: { spend: CreditSpend; remainingKnown: boolean }) {
  const { t, formatNumber } = useI18n()
  const days = spend.days.map((d) => `${d.day}: ${formatNumber(round2(d.credits))}`).join('\n')
  const hover = `${t('agentUsage.kiroDays')}\n${days}${remainingKnown ? '' : `\n\n${t('agentUsage.kiroNoRemaining')}`}`
  return (
    <span className="block text-xs text-muted tabular-nums" title={hover} data-testid="kiro-spend">
      {t('agentUsage.kiroSpentShort', { today: formatNumber(round2(spend.today)), week: formatNumber(round2(spend.week)) })}
      {!remainingKnown && <span className="ml-1.5 cursor-help text-2xs text-subtle underline decoration-dotted underline-offset-2">{t('agentUsage.kiroRemainingUnknown')}</span>}
    </span>
  )
}

/** One account on one row: its name on the left, its windows stacked on the right, one line each. */
function AccountRow({ agentId, account, ceilings, now, extra }: { agentId: string; account: AgentAccountUsage; ceilings: Record<string, number> | undefined; now: number; extra?: ReactNode }) {
  const { t } = useI18n()
  const { budget } = account
  const agent = AGENT_NAME[agentId] ? t(AGENT_NAME[agentId]!) : agentId
  const title = agentId === 'kiro' && !account.name ? agent : accountTitle(agent, account.name || t('agentUsage.defaultAccount'))
  return (
    <li data-testid="agent-usage-account" className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-x-3 py-1.5">
      <span className="flex min-w-0 flex-col gap-0.5 pt-px">
        <span className="truncate text-sm font-medium" title={title}>
          {title}
        </span>
        {budget.action !== 'allow' && (
          <Badge tone={budget.action === 'block' ? 'danger' : 'warning'} className="self-start" title={budget.ceiling !== undefined ? t('agentUsage.ceiling', { ceiling: budget.ceiling }) : undefined}>
            {t(budget.action === 'block' ? 'agentUsage.state.block' : 'agentUsage.state.warn')}
          </Badge>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {account.windows.length === 0 ? (
          <span className="text-xs text-danger" title={account.error}>
            {t('agentUsage.readFailed')}
          </span>
        ) : (
          account.windows.map((w) => <UsageWindowRow key={w.window} w={w} ceiling={ceilings?.[w.window]} now={now} />)
        )}
        {extra}
      </span>
    </li>
  )
}

/**
 * Home's "Usage by agent", compact: one row per account (Claude, Codex, Kiro), each window on one
 * line (bar, percent, short reset; details on hover), so several accounts fit in little space.
 * Kiro shows its credits left when Kiro usage reading is on, and the credits spent from its
 * session files either way.
 */
export function AgentUsageCard({
  sections,
  kiro,
  kiroSpend = null,
  apiSpend = [],
  ceilings,
  now,
  onOpenSettings
}: {
  sections: AgentUsageSection[]
  kiro: KiroUsageNote | null
  /** Kiro credits spent today and over the last 7 days, from its session files. */
  kiroSpend?: CreditSpend | null
  /** Spend of agents billed by API key, per agent over the last 7 days. */
  apiSpend?: readonly ApiAgentSpend[]
  ceilings: Record<string, Record<string, number>>
  now: number
  onOpenSettings: () => void
}) {
  const { t, formatNumber } = useI18n()
  const kiroSection = sections.find((s) => s.agentId === 'kiro')
  const others = sections.filter((s) => s.agentId !== 'kiro')
  const spent = kiroSpend ? <KiroSpent spend={kiroSpend} remainingKnown={!!kiroSection} /> : null
  return (
    <Card aria-label={t('agentUsage.title')} data-testid="agent-usage-card">
      <CardHeader
        title={t('agentUsage.title')}
        icon={<Gauge className="size-4" aria-hidden />}
        actions={
          <span className="flex items-center gap-1">
            <UsageRefreshButton />
            <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpenSettings}>
              {t('agentUsage.openSettings')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Button>
          </span>
        }
      />
      <CardBody className="pt-0 pb-2">
        {others.length === 0 && !kiroSection && !kiro && !kiroSpend && !apiSpend.length && <p className="pb-2 text-sm text-subtle">{t('agentUsage.empty')}</p>}
        <ul className="flex flex-col divide-y divide-border">
          {others.flatMap((s) => s.accounts.map((a) => <AccountRow key={a.key} agentId={s.agentId} account={a} ceilings={ceilings[a.key]} now={now} />))}
          {kiroSection?.accounts.map((a) => (
            <AccountRow key={a.key} agentId="kiro" account={a} ceilings={ceilings[a.key]} now={now} extra={spent} />
          ))}
          {!kiroSection && (kiro || kiroSpend) && (
            <li className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-x-3 py-1.5" data-testid="kiro-usage">
              <span className="truncate text-sm font-medium">{t('agentUsage.agent.kiro')}</span>
              <span className="min-w-0">
                {spent ?? (
                  <span className="text-xs text-muted" title={t('agentUsage.kiroNoRemaining')}>
                    {t('agentUsage.kiroCredits', { credits: formatNumber(round2(kiro?.credits ?? 0)) })}
                  </span>
                )}
              </span>
            </li>
          )}
        </ul>
        <ApiSpendList spend={apiSpend} className="border-t border-border pt-1.5 pb-1" />
      </CardBody>
    </Card>
  )
}
