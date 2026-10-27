import { History } from 'lucide-react'
import type { SessionView } from '@shared/api'
import { Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { pushItem } from '../../store'
import { errorText } from '../../lib/errorText'

/** A view switch that waits for the turn in progress to end (Workhub 1's PendingSwitchBar). */
export function PendingSwitchBar({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const target = view.pendingMode
  if (!target) return null
  const engine = target === 'app' ? 'console' : 'app'
  const run = (mode: 'app' | 'console', now: boolean) =>
    void window.hub.sessions.setMode(view.id, mode, now ? { now: true } : undefined).catch((e: unknown) => pushItem(view.id, 'error', errorText(e)))
  return (
    <div role="status" data-testid="pending-switch" className="flex shrink-0 items-center gap-2.5 border-b border-border bg-accent-soft px-4 py-1.5 text-sm text-text">
      <History className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1" title={t('session.pendingSwitchHint')}>
        {t('session.pendingSwitch', { mode: t(target === 'app' ? 'session.modeApp' : 'session.modeConsole') })}
      </span>
      <Button size="sm" variant="secondary" title={t('session.switchNowHint')} data-testid="switch-now" onClick={() => run(target, true)}>
        {t('session.switchNow')}
      </Button>
      <Button size="sm" variant="ghost" title={t('session.switchCancelHint')} data-testid="switch-cancel" onClick={() => run(engine, false)}>
        {t('session.switchCancel')}
      </Button>
    </div>
  )
}
