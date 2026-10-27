import { ArrowRightLeft, Clock, Send } from 'lucide-react'
import type { ContinuityTarget } from '@shared/continuity-api'
import { Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { formatCountdown } from '../../lib/agent-usage'
import { accountOfLabel } from '../../lib/continuity'

/**
 * The choices when a Claude account ran out (the agent's limit, or the user's ceiling): continue
 * the same conversation in another account, hand it off to another agent, or wait.
 */
export function ContinuityNotice({
  reason,
  account,
  window: usageWindow,
  resetsAt,
  now,
  target,
  handoff,
  busy,
  onContinue,
  onHandoff,
  onWait
}: {
  reason: 'limit' | 'ceiling'
  account: string
  window?: string
  resetsAt?: number
  now: number
  target?: ContinuityTarget
  handoff?: ContinuityTarget
  /** An action is running. */
  busy: boolean
  onContinue: (target: ContinuityTarget) => void
  onHandoff: (target: ContinuityTarget) => void
  onWait: () => void
}) {
  const { t } = useI18n()
  if (!target && !handoff) return null
  const message = reason === 'ceiling' ? t('continuity.offer.ceiling', { account }) : usageWindow ? t('continuity.offer.limitWindow', { account, window: usageWindow }) : t('continuity.offer.limit', { account })
  return (
    <div role="alert" data-testid="continuity-notice" className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info">
      <ArrowRightLeft className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {message}
        {resetsAt !== undefined && resetsAt > now && <> {t('continuity.offer.resets', { time: formatCountdown(resetsAt, now) })}</>}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {target && (
          <Button size="sm" variant="primary" disabled={busy} icon={<ArrowRightLeft className="size-3.5" aria-hidden />} onClick={() => onContinue(target)}>
            {t('continuity.offer.continueIn', { account: accountOfLabel(target.label) })}
          </Button>
        )}
        {handoff && (
          <Button size="sm" variant="secondary" disabled={busy} icon={<Send className="size-3.5" aria-hidden />} onClick={() => onHandoff(handoff)}>
            {t('continuity.offer.handOffTo', { agent: handoff.label })}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} icon={<Clock className="size-3.5" aria-hidden />} onClick={onWait}>
          {t('continuity.offer.wait')}
        </Button>
      </div>
    </div>
  )
}
