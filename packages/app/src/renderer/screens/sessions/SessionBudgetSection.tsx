import { useEffect, useState } from 'react'
import { sessionIdentity, setSessionCeiling, usageAccountKey, USAGE_AGENTS, type SessionCeilings } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { Button, Input } from '../../components/atoms'
import { HelpTip } from '../../components/molecules'
import { usageCeilingLabel, usageWindowName } from '../../lib/usage-window'
import { useI18n } from '../../i18n/I18nProvider'
import { budgetWindows } from '../../lib/agent-usage'
import { useAccountUsage, useSessionCeilings, useUsageSettings } from '../../lib/usage'
import { MonitorSection } from './MonitorSection'

/** One window's ceiling for this session, saved on blur or Enter; empty goes back to the account's. */
function CeilingInput({
  window,
  value,
  placeholder,
  title,
  current,
  onCommit
}: {
  window: string
  value: number | undefined
  placeholder: string
  title: string
  current?: number
  onCommit: (value: number | null) => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  const commit = () => {
    const trimmed = text.trim()
    const n = trimmed === '' ? null : Number(trimmed)
    if (n !== null && !Number.isFinite(n)) return setText(value === undefined ? '' : String(value))
    if (n !== (value ?? null)) onCommit(n === null ? null : Math.min(100, Math.max(1, n)))
  }
  return (
    <label className="flex items-center gap-2 text-sm" title={title}>
      <span className="w-16 shrink-0 text-muted">{usageWindowName(window, t)}</span>
      <Input
        type="number"
        min={1}
        max={100}
        inputMode="numeric"
        className="h-7 w-20"
        aria-label={usageCeilingLabel(window, t)}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        data-testid={`session-ceiling-${window}`}
      />
      {current !== undefined && <span className="text-xs text-subtle tabular-nums">{t('agentUsage.session.now', { percent: Math.round(current) })}</span>}
    </label>
  )
}

/**
 * The monitor's "Usage limit for this session": a ceiling per window that overrides the
 * account's (Settings → Usage) for this session only. Stored by session identity in main.
 */
export function SessionBudgetSection({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const reads = useAccountUsage()
  const { budget, accountsOf } = useUsageSettings()
  const all = useSessionCeilings()
  const agentId = accountsOf(view.agentId)
  if (!(USAGE_AGENTS as readonly string[]).includes(agentId) || view.readOnly) return null
  const identity = sessionIdentity(view)
  const own: SessionCeilings | undefined = all[identity]
  const key = usageAccountKey(agentId, view.accountId)
  const read = reads.find((r) => r.key === key)
  const account = budget.ceilings[key]
  const save = (next: SessionCeilings) => void window.hub.usage.setSessionBudget(identity, Object.keys(next).length ? next : null)
  const overridden = !!own && Object.keys(own).length > 0
  return (
    <MonitorSection
      id="sessionBudget"
      title={t('agentUsage.session.title')}
      action={<HelpTip text={t('agentUsage.session.help')} label={t('agentUsage.session.title')} />}
    >
      <div className="flex flex-col gap-1.5" data-testid="monitor-session-budget">
        {!read ? (
          <p className="text-xs text-subtle">{t('agentUsage.session.noRead')}</p>
        ) : (
          <>
            {budgetWindows(read.windows, { ...account, ...own }, agentId).map((w) => (
              <CeilingInput
                key={w}
                window={w}
                value={own?.[w]}
                placeholder={account?.[w] !== undefined ? String(account[w]) : '–'}
                title={t('agentUsage.session.account', { value: account?.[w] !== undefined ? `${account[w]}%` : t('agentUsage.settings.none') })}
                current={read.windows.find((x) => x.window === w)?.percent}
                onCommit={(n) => save(setSessionCeiling(own, w, n))}
              />
            ))}
            {overridden && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => save({})}>
                {t('agentUsage.session.reset')}
              </Button>
            )}
          </>
        )}
      </div>
    </MonitorSection>
  )
}
