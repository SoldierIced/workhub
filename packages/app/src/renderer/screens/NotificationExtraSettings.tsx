import { appOptions, notificationsPaused, pauseUntil, type Result, type WorkhubConfig } from '@workhub/core'
import { Button, Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

interface RowsProps {
  config: WorkhubConfig
  editable: boolean
  run: Run
}

const KINDS = [
  ['notifySlack', 'settings.notifySlack', 'settings.notifySlackHint'],
  ['notifyAutomations', 'settings.notifyAutomations', 'settings.notifyAutomationsHint'],
  ['notifyTickets', 'settings.notifyTickets', 'settings.notifyTicketsHint'],
  ['notifyHealth', 'settings.notifyHealth', 'settings.notifyHealthHint']
] as const satisfies readonly (readonly [string, MessageKey, MessageKey])[]

/** Settings → General: the switches of the notifications that are not about one session, and the pause. */
export function OtherNotificationRows({ config, editable, run }: RowsProps) {
  const { t, formatDate } = useI18n()
  const options = appOptions(config)
  const now = Date.now()
  const paused = notificationsPaused(options, now)
  const pause = (until: number) => void run(() => window.hub.config.saveOptions({ notificationsPausedUntil: until }))
  return (
    <>
      {KINDS.map(([option, label, hint]) => (
        <SwitchRow key={option} label={t(label)} hint={t(hint)}>
          <Switch checked={options[option]} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ [option]: on }))} />
        </SwitchRow>
      ))}
      <div className="flex items-center justify-between gap-4 py-2" data-testid="notifications-pause">
        <div className="min-w-0">
          <span className="block text-base text-text">{t('settings.pause')}</span>
          <p className="text-xs text-subtle">
            {paused ? t('settings.pausedUntil', { time: formatDate(options.notificationsPausedUntil!, { hour: '2-digit', minute: '2-digit' }) }) : t('settings.pauseHint')}
          </p>
        </div>
        <div className="flex gap-2">
          {paused ? (
            <Button size="sm" disabled={!editable} onClick={() => pause(0)}>
              {t('settings.resume')}
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={!editable} onClick={() => pause(pauseUntil('hour', new Date()))}>
                {t('settings.pauseHour')}
              </Button>
              <Button size="sm" disabled={!editable} onClick={() => pause(pauseUntil('tomorrow', new Date()))}>
                {t('settings.pauseTomorrow')}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

const KEEP_LABEL: Record<string, MessageKey> = { mac: 'settings.keepInTray', windows: 'settings.keepInTrayWindows', linux: 'settings.keepInTrayLinux' }

/** Settings → General: keep running in the menu bar / notification area when the window closes. */
export function MenuBarRows({ config, editable, run }: RowsProps) {
  const { t } = useI18n()
  const options = appOptions(config)
  return (
    <SwitchRow label={t(KEEP_LABEL[window.hub.platform] ?? 'settings.keepInTray')} hint={t('settings.keepInTrayHint')}>
      <Switch checked={options.keepInTray} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ keepInTray: on }))} />
    </SwitchRow>
  )
}
