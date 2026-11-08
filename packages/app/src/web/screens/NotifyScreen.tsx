import { Activity, Bell, Check, CircleHelp, GitPullRequest, Info } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { useClient, useClientStatus } from '../app-context'
import { isStandalone, pushSupported, subscribeToPush } from '../browser'
import { NOTIFY_ASKED_KEY } from '../device'
import { BigButton, Screen } from '../ui'

function Item({ icon, tone, title, hint }: { icon: ReactNode; tone: string; title: string; hint: string }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <strong className="text-md font-semibold">{title}</strong>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </li>
  )
}

/** Asked once after pairing: whether the desktop's notifications should reach this phone. */
export function NotifyScreen({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const client = useClient()
  const status = useClientStatus()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const supported = pushSupported()

  const finish = () => {
    localStorage.setItem(NOTIFY_ASKED_KEY, '1')
    onDone()
  }
  const allow = async () => {
    if (!status.vapidPublicKey) return
    setBusy(true)
    try {
      const sub = await subscribeToPush(status.vapidPublicKey)
      if (!sub) {
        setError(Notification.permission === 'denied' ? t('web.notify.denied') : t('web.notify.unsupported'))
        return
      }
      client.setPushSubscription(sub)
      finish()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <div className="safe-top flex flex-1 flex-col gap-5 px-6 pt-6">
        {status.desktop && (
          <div className="flex items-center gap-2 self-center rounded-full bg-success-soft px-3 py-1.5 text-sm font-medium text-success">
            <Check className="size-4" aria-hidden />
            {t('web.pair.pairedWith', { desktop: status.desktop.name })}
          </div>
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Bell className="size-8" aria-hidden />
          </span>
          <h1 className="mt-2 text-xl font-semibold">{t('web.notify.title')}</h1>
          <p className="text-sm text-muted">{t('web.notify.intro')}</p>
        </div>
        <ul className="flex flex-col gap-2">
          <Item icon={<CircleHelp className="size-4" />} tone="bg-warning-soft text-warning" title={t('web.notify.permission')} hint={t('web.notify.permissionHint')} />
          <Item icon={<Check className="size-4" />} tone="bg-success-soft text-success" title={t('web.notify.finished')} hint={t('web.notify.finishedHint')} />
          <Item icon={<GitPullRequest className="size-4" />} tone="bg-info-soft text-info" title={t('web.notify.pr')} hint={t('web.notify.prHint')} />
          <Item icon={<Activity className="size-4" />} tone="bg-danger-soft text-danger" title={t('web.notify.alerts')} hint={t('web.notify.alertsHint')} />
        </ul>
        <div className="safe-bottom mt-auto flex flex-col gap-2.5 pb-4">
          {!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) && (
            <div className="flex gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-xs leading-snug text-text">
              <Info className="mt-px size-4 shrink-0 text-info" aria-hidden />
              <span>{t('web.notify.iosHint')}</span>
            </div>
          )}
          {error && <p className="text-center text-sm text-danger">{error}</p>}
          {!supported && <p className="text-center text-sm text-muted">{t('web.notify.unsupported')}</p>}
          <BigButton onClick={() => void allow()} disabled={busy || !supported || !status.vapidPublicKey}>
            {t('web.notify.allow')}
          </BigButton>
          <BigButton variant="secondary" onClick={finish}>
            {t('web.notify.later')}
          </BigButton>
          <p className="text-center text-xs text-subtle">{t('web.notify.footer')}</p>
        </div>
      </div>
    </Screen>
  )
}
