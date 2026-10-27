import { ArrowRight, Gauge } from 'lucide-react'
import { Badge, Button } from '../atoms'
import { Card, CardBody, CardHeader } from '../molecules/Card'
import { UsageBar } from '../molecules/UsageBar'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatCountdown, type AgentAccountUsage, type AgentUsageSection, type KiroUsageNote } from '../../lib/agent-usage'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex' }

function AccountBlock({ account, ceilings, now }: { account: AgentAccountUsage; ceilings: Record<string, number> | undefined; now: number }) {
  const { t, formatDate } = useI18n()
  const { budget } = account
  return (
    <div data-testid="agent-usage-account" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{account.name || t('agentUsage.defaultAccount')}</span>
        {budget.action !== 'allow' && (
          <Badge tone={budget.action === 'block' ? 'danger' : 'warning'} title={budget.ceiling !== undefined ? t('agentUsage.ceiling', { ceiling: budget.ceiling }) : undefined}>
            {t(budget.action === 'block' ? 'agentUsage.state.block' : 'agentUsage.state.warn')}
          </Badge>
        )}
      </div>
      {account.windows.length === 0 ? (
        <p className="text-xs text-danger" title={account.error}>
          {t('agentUsage.readFailed')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {account.windows.map((w) => {
            const parts: string[] = []
            if (w.resetsAt) parts.push(t('agentUsage.resetsIn', { time: formatCountdown(w.resetsAt, now) }))
            if (w.asOf) parts.push(t('agentUsage.asOf', { when: formatDate(w.asOf, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }))
            return (
              <li key={w.window}>
                <UsageBar label={w.window} percent={w.percent} ceiling={ceilings?.[w.window]} caption={parts.join(' · ') || undefined} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Home's "Usage by agent": each Claude and Codex account with its plan windows (bar, percent,
 * reset countdown and the ceiling mark), and Kiro's "not available" note when Kiro ran.
 */
export function AgentUsageCard({
  sections,
  kiro,
  ceilings,
  now,
  onOpenSettings
}: {
  sections: AgentUsageSection[]
  kiro: KiroUsageNote | null
  ceilings: Record<string, Record<string, number>>
  now: number
  onOpenSettings: () => void
}) {
  const { t } = useI18n()
  return (
    <Card aria-label={t('agentUsage.title')} data-testid="agent-usage-card">
      <CardHeader
        title={t('agentUsage.title')}
        icon={<Gauge className="size-4" aria-hidden />}
        actions={
          <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpenSettings}>
            {t('agentUsage.openSettings')}
            <ArrowRight className="size-3.5" aria-hidden />
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {sections.length === 0 && !kiro && <p className="text-sm text-subtle">{t('agentUsage.empty')}</p>}
        {sections.map((s) => (
          <section key={s.agentId} aria-label={AGENT_NAME[s.agentId] ? t(AGENT_NAME[s.agentId]!) : s.agentId} className="flex flex-col gap-2.5">
            <h3 className="text-2xs font-medium tracking-wide text-subtle uppercase">{AGENT_NAME[s.agentId] ? t(AGENT_NAME[s.agentId]!) : s.agentId}</h3>
            {s.accounts.map((a) => (
              <AccountBlock key={a.key} account={a} ceilings={ceilings[a.key]} now={now} />
            ))}
          </section>
        ))}
        {kiro && (
          <section aria-label={t('agentUsage.agent.kiro')} className="flex flex-col gap-1">
            <h3 className="text-2xs font-medium tracking-wide text-subtle uppercase">{t('agentUsage.agent.kiro')}</h3>
            <p className="text-xs text-muted">{t('agentUsage.kiro')}</p>
            {kiro.credits > 0 && <p className="text-xs text-subtle">{t('agentUsage.kiroCredits', { credits: Math.round(kiro.credits * 100) / 100 })}</p>}
          </section>
        )}
      </CardBody>
    </Card>
  )
}
