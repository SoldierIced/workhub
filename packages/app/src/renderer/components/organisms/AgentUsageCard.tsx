import { ArrowRight, Gauge } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ApiAgentSpend, CreditSpend } from '@workhub/core'
import { AgentIcon, Badge, Button } from '../atoms'
import { Card, CardBody, CardHeader } from '../molecules/Card'
import { accountTitle, UsageRowTooltip, UsageWindowRow, useWindowHover } from '../molecules/UsageWindowRow'
import { UsageRefreshButton } from '../molecules/UsageRefreshButton'
import { ApiSpendList } from '../molecules/ApiSpendList'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { accountHoverText, kiroSpendLines, type AgentAccountUsage, type AgentUsageSection, type KiroUsageNote } from '../../lib/agent-usage'

const round2 = (n: number) => Math.round(n * 100) / 100

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }

/** The hover block of Kiro's spend: today and 7 days, the per-day split, and why credits left may be missing. */
export function useKiroSpendHover(): (spend: CreditSpend, remainingKnown: boolean) => string {
  const { t, formatNumber } = useI18n()
  return (spend, remainingKnown) =>
    [
      t('agentUsage.kiroSpentShort', { today: formatNumber(round2(spend.today)), week: formatNumber(round2(spend.week)) }),
      kiroSpendLines(t('agentUsage.kiroDays'), spend.days, formatNumber),
      remainingKnown ? '' : t('agentUsage.kiroNoRemaining')
    ]
      .filter(Boolean)
      .join('\n\n')
}

/** Kiro credits spent today and this week, shown when its credits left are not read (the details are in the row's tooltip). */
export function KiroSpent({ spend, compact = false }: { spend: CreditSpend; /** Only today's credits (the sidebar). */ compact?: boolean }) {
  const { t, formatNumber } = useI18n()
  if (compact) {
    return (
      <span className="min-w-0 truncate text-2xs text-subtle tabular-nums" data-testid="kiro-spend">
        {t('usage.spentToday', { today: formatNumber(round2(spend.today)) })}
      </span>
    )
  }
  return (
    <span className="block text-xs text-muted tabular-nums" data-testid="kiro-spend">
      {t('agentUsage.kiroSpentShort', { today: formatNumber(round2(spend.today)), week: formatNumber(round2(spend.week)) })}
      <span className="ml-1.5 text-2xs text-subtle underline decoration-dotted underline-offset-2">{t('agentUsage.kiroRemainingUnknown')}</span>
    </span>
  )
}

/** One account's block: the agent's mark and name (and plan) on top, its windows under them, one line each, lined up under the name. */
const ACCOUNT_BLOCK = '-mx-2 flex cursor-default flex-col gap-1.5 rounded-md px-2 py-2 outline-none hover:bg-surface-hover/60 focus-visible:ring-2 focus-visible:ring-accent/40'

/**
 * One account: its agent's mark, name and plan on the first line, its windows stacked under them,
 * one line each. The whole block shows its details on hover: every window's percent, credits,
 * ceiling and reset, plus `hoverExtra` (Kiro's spend).
 */
function AccountRow({
  agentId,
  account,
  ceilings,
  now,
  extra,
  hoverExtra
}: {
  agentId: string
  account: AgentAccountUsage
  ceilings: Record<string, number> | undefined
  now: number
  extra?: ReactNode
  hoverExtra?: string
}) {
  const { t } = useI18n()
  const hover = useWindowHover()
  const { budget } = account
  const agent = AGENT_NAME[agentId] ? t(AGENT_NAME[agentId]!) : agentId
  const title = agentId === 'kiro' && !account.name ? agent : accountTitle(agent, account.name || t('agentUsage.defaultAccount'))
  const plan = account.windows.find((w) => w.plan)?.plan
  const text = accountHoverText(plan ? `${title} · ${plan}` : title, [
    ...account.windows.map((w) => hover(w, ceilings?.[w.window], now)),
    account.windows.length === 0 ? account.error : undefined,
    budget.action !== 'allow' && budget.ceiling !== undefined ? t('agentUsage.ceiling', { ceiling: budget.ceiling }) : undefined,
    hoverExtra
  ])
  return (
    <UsageRowTooltip text={text}>
      <li data-testid="agent-usage-account" tabIndex={0} className={ACCOUNT_BLOCK}>
        <span className="flex min-w-0 items-center gap-2">
          <AgentIcon agentId={agentId} className="size-4 rounded-sm" />
          <span className="truncate text-sm font-medium">{title}</span>
          {plan && <span className="shrink-0 text-xs text-subtle">{plan}</span>}
          {budget.action !== 'allow' && (
            <Badge tone={budget.action === 'block' ? 'danger' : 'warning'} className="ml-auto shrink-0">
              {t(budget.action === 'block' ? 'agentUsage.state.block' : 'agentUsage.state.warn')}
            </Badge>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1 pl-6">
          {account.windows.length === 0 ? (
            <span className="text-xs text-danger">{t('agentUsage.readFailed')}</span>
          ) : (
            account.windows.map((w) => <UsageWindowRow key={w.window} w={w} ceiling={ceilings?.[w.window]} now={now} />)
          )}
          {extra}
        </span>
      </li>
    </UsageRowTooltip>
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
  const spendHover = useKiroSpendHover()
  const kiroSection = sections.find((s) => s.agentId === 'kiro')
  const others = sections.filter((s) => s.agentId !== 'kiro')
  return (
    <Card aria-label={t('agentUsage.title')} data-testid="agent-usage-card">
      <CardHeader
        title={t('agentUsage.title')}
        icon={<Gauge className="size-4" aria-hidden />}
        help={t('usage.help')}
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
          {/* Kiro reads like a Claude account (bar, percent, reset); what it spent is in the tooltip,
              and on the row only while its credits left could not be read. */}
          {kiroSection?.accounts.map((a) => (
            <AccountRow
              key={a.key}
              agentId="kiro"
              account={a}
              ceilings={ceilings[a.key]}
              now={now}
              extra={kiroSpend && a.windows.length === 0 ? <KiroSpent spend={kiroSpend} /> : undefined}
              hoverExtra={kiroSpend ? spendHover(kiroSpend, true) : undefined}
            />
          ))}
          {!kiroSection && (kiro || kiroSpend) && (
            <UsageRowTooltip text={accountHoverText(t('agentUsage.agent.kiro'), [kiroSpend ? spendHover(kiroSpend, false) : t('agentUsage.kiroNoRemaining')])}>
              <li tabIndex={0} className={ACCOUNT_BLOCK} data-testid="kiro-usage">
                <span className="flex min-w-0 items-center gap-2">
                  <AgentIcon agentId="kiro" className="size-4 rounded-sm" />
                  <span className="truncate text-sm font-medium">{t('agentUsage.agent.kiro')}</span>
                </span>
                <span className="min-w-0 pl-6">
                  {kiroSpend ? <KiroSpent spend={kiroSpend} /> : <span className="text-xs text-muted">{t('agentUsage.kiroCredits', { credits: formatNumber(round2(kiro?.credits ?? 0)) })}</span>}
                </span>
              </li>
            </UsageRowTooltip>
          )}
        </ul>
        <ApiSpendList spend={apiSpend} className="border-t border-border pt-1.5 pb-1" />
      </CardBody>
    </Card>
  )
}
