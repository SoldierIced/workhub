import { useEffect, useState, type ReactNode } from 'react'
import { appOptions, parseThresholds, setCeiling, type Result, type UsageBudgetOptions, type WorkhubConfig } from '@workhub/core'
import type { AccountUsage, ConfigSnapshot } from '@shared/api'
import { Button, Input, Switch } from '../components/atoms'
import { Card, Field, HelpTip, SwitchRow } from '../components/molecules'
import { usageWindowName } from '../lib/usage-window'
import { useI18n } from '../i18n/I18nProvider'
import { budgetWindows } from '../lib/agent-usage'
import { useAccountLabel, useAccountUsage } from '../lib/usage'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

function Group({ title, help, footnote, children }: { title: string; help?: ReactNode; footnote?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 px-1 text-md font-semibold">
        {title}
        {help && <HelpTip text={help} label={title} />}
      </h2>
      <Card className="divide-y divide-border px-4">{children}</Card>
      {footnote && <p className="px-1 text-xs text-subtle">{footnote}</p>}
    </section>
  )
}

/** A number field saved when it loses focus or on Enter; empty means "none". */
function NumberField({ label, value, placeholder, hint, disabled, onCommit }: { label: string; value: number | undefined; placeholder?: string; hint?: ReactNode; disabled?: boolean; onCommit: (value: number | null) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  const commit = () => {
    const trimmed = text.trim()
    const n = trimmed === '' ? null : Number(trimmed)
    if (n !== null && !Number.isFinite(n)) return setText(value === undefined ? '' : String(value))
    if (n !== (value ?? null)) onCommit(n)
  }
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={1}
        max={100}
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </Field>
  )
}

function AccountBudget({ read, budget, editable, save }: { read: AccountUsage; budget: UsageBudgetOptions; editable: boolean; save: (next: UsageBudgetOptions) => void }) {
  const { t } = useI18n()
  const label = useAccountLabel()
  const own = budget.ceilings[read.key]
  return (
    <div className="flex flex-col gap-2 py-3" data-testid="usage-budget-account">
      <span className="text-base">{label(read.agentId, read.name)}</span>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {budgetWindows(read.windows, own, read.agentId).map((window) => {
          const current = read.windows.find((w) => w.window === window)
          return (
            <div key={window} className="flex items-end gap-1.5">
              <NumberField
                label={t('agentUsage.settings.ceiling', { window: usageWindowName(window, t) })}
                value={own?.[window]}
                placeholder={t('agentUsage.settings.none')}
                hint={current ? t('agentUsage.settings.current', { percent: Math.round(current.percent) }) : undefined}
                disabled={!editable}
                onCommit={(n) => save(setCeiling(budget, read.key, window, n === null ? null : Math.min(100, Math.max(1, n))))}
              />
              {own?.[window] !== undefined && (
                <Button size="sm" variant="ghost" className={current ? 'mb-5' : undefined} disabled={!editable} onClick={() => save(setCeiling(budget, read.key, window, null))}>
                  {t('agentUsage.settings.clear')}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Settings → Usage: which agents' plan usage is read, the ceilings per account and window, and the alerts. */
export function UsageSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const options = appOptions(snap.config)
  const budget = options.usageBudget
  const editable = !snap.loadError
  const reads = useAccountUsage()
  const [thresholds, setThresholds] = useState(budget.thresholds.join(', '))
  useEffect(() => setThresholds(budget.thresholds.join(', ')), [budget.thresholds])

  const saveBudget = (next: UsageBudgetOptions) => void run(() => window.hub.config.saveOptions({ usageBudget: next }))
  const toggle = (key: 'claudePlanUsage' | 'codexUsage' | 'kiroUsage', on: boolean) => void run(() => window.hub.config.saveOptions({ [key]: on })).then((ok) => ok && void window.hub.usage.get(true))

  return (
    <div className="flex flex-col gap-6">
      <Group title={t('agentUsage.settings.reading')} help={t('help.usage.reading')} footnote={<>{t('settings.planUsageNote')} {t('agentUsage.settings.codexNote')}</>}>
        <SwitchRow label={t('agentUsage.settings.claude')} hint={t('settings.planUsageHint')}>
          <Switch checked={options.claudePlanUsage} disabled={!editable} onChange={(on) => toggle('claudePlanUsage', on)} />
        </SwitchRow>
        <SwitchRow label={t('agentUsage.settings.codex')} hint={t('agentUsage.settings.codexHint')}>
          <Switch checked={options.codexUsage} disabled={!editable} onChange={(on) => toggle('codexUsage', on)} />
        </SwitchRow>
        <SwitchRow label={t('agentUsage.settings.kiro')} hint={t('agentUsage.settings.kiroHint')} help={t('agentUsage.settings.kiroNote')}>
          <Switch checked={options.kiroUsage} disabled={!editable} onChange={(on) => toggle('kiroUsage', on)} />
        </SwitchRow>
      </Group>

      <Group title={t('agentUsage.settings.budgets')} help={t('help.usage.budgets')} footnote={t('agentUsage.settings.budgetsNote')}>
        {reads.length === 0 ? (
          <p className="py-3 text-sm text-subtle">{t('agentUsage.settings.noAccounts')}</p>
        ) : (
          reads.map((r) => <AccountBudget key={r.key} read={r} budget={budget} editable={editable} save={saveBudget} />)
        )}
        <div className="py-3">
          <NumberField
            label={t('agentUsage.settings.margin')}
            hint={t('agentUsage.settings.marginHint')}
            value={budget.warnMargin}
            disabled={!editable}
            onCommit={(n) => saveBudget({ ...budget, warnMargin: Math.min(50, Math.max(0, Math.round(n ?? 0))) })}
          />
        </div>
      </Group>

      <Group title={t('agentUsage.settings.alerts')} help={t('help.usage.alerts')}>
        <SwitchRow label={t('agentUsage.settings.alertsOn')} hint={t('agentUsage.settings.alertsHint')}>
          <Switch checked={budget.alerts} disabled={!editable} onChange={(on) => saveBudget({ ...budget, alerts: on })} />
        </SwitchRow>
        <div className="flex items-end gap-2 py-3">
          <Field label={t('agentUsage.settings.thresholds')} hint={t('agentUsage.settings.thresholdsHint')} className="flex-1">
            <Input value={thresholds} disabled={!editable} onChange={(e) => setThresholds(e.target.value)} />
          </Field>
          <Button className="mb-5" disabled={!editable || parseThresholds(thresholds).join(',') === budget.thresholds.join(',')} onClick={() => saveBudget({ ...budget, thresholds: parseThresholds(thresholds) })}>
            {t('agentUsage.settings.apply')}
          </Button>
        </div>
      </Group>
    </div>
  )
}
