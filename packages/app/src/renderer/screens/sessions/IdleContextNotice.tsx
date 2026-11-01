import { Hourglass, X } from 'lucide-react'
import type { Money } from '@workhub/core'
import { IconButton } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { formatCountdown } from '../../lib/agent-usage'
import { formatTokens } from '../../lib/home'
import type { IdleContext } from '../../lib/idle-context'

/**
 * The composer's notice on a conversation idle past the prompt cache's lifetime: the next message
 * sends the whole context again, and what that costs. It only informs; sending is never held.
 */
export function IdleContextNotice({ idle, now, onDismiss }: { idle: IdleContext; now: number; onDismiss: () => void }) {
  const { t, formatNumber } = useI18n()
  // Two significant digits under a cent (a cache read of a cheap model is a fraction of one), else cents.
  const money = (m: Money) => formatNumber(m.amount, { style: 'currency', currency: m.currency, ...(m.amount > 0 && m.amount < 0.01 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 }) })
  const params = { time: formatCountdown(now + idle.idleMs, now), tokens: formatTokens(idle.tokens) }
  return (
    <div role="status" data-testid="idle-context-notice" className="mx-3 mt-3 flex items-start gap-x-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
      <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {idle.expired && idle.expiredForMs !== undefined
          ? t('chat.idleContext.expired', { ...params, ago: formatCountdown(now + idle.expiredForMs, now) })
          : t('chat.idleContext.body', params)}
        {idle.coldCost && (
          <>
            {' '}
            {idle.warmCost
              ? t('chat.idleContext.costVsWarm', { cold: money(idle.coldCost), warm: money(idle.warmCost) })
              : t('chat.idleContext.cost', { cold: money(idle.coldCost) })}
          </>
        )}
      </span>
      <IconButton size="sm" label={t('common.close')} icon={<X className="size-3" />} onClick={onDismiss} />
    </div>
  )
}
