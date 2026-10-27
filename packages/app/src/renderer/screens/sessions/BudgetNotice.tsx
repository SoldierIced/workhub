import { Gauge } from 'lucide-react'
import type { BudgetStatus } from '@workhub/core'
import { Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formatCountdown } from '../../lib/agent-usage'

/**
 * The composer's usage budget notice. Near the ceiling it only informs; past it, a prompt needs
 * "Send anyway" (this prompt only) and the ceiling can be cleared from here.
 */
export function BudgetNotice({
  status,
  account,
  now,
  needsConfirm,
  canSend,
  onSendAnyway,
  onClear
}: {
  status: BudgetStatus
  /** "Codex · Work". */
  account: string
  now: number
  /** A send was attempted and is waiting for "Send anyway". */
  needsConfirm: boolean
  canSend: boolean
  onSendAnyway: () => void
  onClear: () => void
}) {
  const { t } = useI18n()
  if (status.action === 'allow' || status.window === undefined || status.percent === undefined || status.ceiling === undefined) return null
  const params = { account, percent: Math.round(status.percent), window: status.window, ceiling: status.ceiling }
  const blocked = status.action === 'block'
  return (
    <div
      role={blocked ? 'alert' : 'status'}
      data-testid="budget-notice"
      className={cn('mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-3 py-2 text-sm', blocked ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning', needsConfirm && 'ring-2 ring-danger/50')}
    >
      <Gauge className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t(blocked ? 'agentUsage.gate.block' : 'agentUsage.gate.warn', params)}
        {status.resetsAt !== undefined && <> {t('agentUsage.gate.resets', { time: formatCountdown(status.resetsAt, now) })}</>}
        {blocked && needsConfirm && <> {t('agentUsage.gate.confirm')}</>}
      </span>
      {blocked && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={onClear}>
            {t('agentUsage.gate.clear')}
          </Button>
          <Button size="sm" variant="primary" disabled={!canSend} onClick={onSendAnyway}>
            {t('agentUsage.gate.sendAnyway')}
          </Button>
        </div>
      )}
    </div>
  )
}
