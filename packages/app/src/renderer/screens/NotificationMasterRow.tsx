import { TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { appOptions, type Result, type WorkhubConfig } from '@workhub/core'
import { Button, Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

/** True when the operating system will not show this app's notifications (the warning's condition). */
export function useOsNotificationsOff(): boolean {
  const [off, setOff] = useState(false)
  useEffect(() => {
    const check = () => void window.hub.systemNotifications.status().then((s) => setOff(!s.supported))
    check()
    // Coming back from the system settings re-reads the answer.
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  return off
}

/** The master switch of every notification, and the warning when the OS refuses them. */
export function NotificationMasterRows({ config, editable, run }: { config: WorkhubConfig; editable: boolean; run: Run }) {
  const { t } = useI18n()
  const options = appOptions(config)
  const osOff = useOsNotificationsOff()
  return (
    <>
      <SwitchRow label={t('notify.master')} hint={t('notify.masterHint')}>
        <Switch checked={options.notificationsEnabled} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ notificationsEnabled: on }))} />
      </SwitchRow>
      {osOff && (
        <div role="alert" data-testid="notifications-os-warning" className="flex items-center gap-3 py-3">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-base">{t('notify.osOff')}</p>
            <p className="text-xs text-subtle">{t('notify.osOffHint')}</p>
          </div>
          <Button size="sm" onClick={() => window.hub.systemNotifications.openSystemSettings()}>
            {t('notify.turnOn')}
          </Button>
        </div>
      )}
    </>
  )
}
