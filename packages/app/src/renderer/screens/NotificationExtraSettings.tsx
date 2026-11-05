import { Fragment } from 'react'
import { appOptions, notificationsPaused, pausedIndefinitely, pauseUntil, TRAY_POPOVER_MEETING_COUNTS, type TrayPopoverOptions, type WorkhubConfig } from '@workhub/core'
import { Button, Select, Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import type { Run } from './settings/run'
import { SettingRow } from './settings/SettingsLayout'

interface RowsProps {
  config: WorkhubConfig
  editable: boolean
  run: Run
}

const KINDS = [
  ['notifySlack', 'settings.notifySlack', 'settings.notifySlackHint'],
  ['notifyAutomations', 'settings.notifyAutomations', 'settings.notifyAutomationsHint'],
  ['notifyTickets', 'settings.notifyTickets', 'settings.notifyTicketsHint'],
  ['notifyHealth', 'settings.notifyHealth', 'settings.notifyHealthHint'],
  ['notifyFlowMaps', 'settings.notifyFlowMaps', 'settings.notifyFlowMapsHint'],
  ['notifyMeetings', 'settings.notifyMeetings', 'settings.notifyMeetingsHint'],
  ['notifyMetricAlerts', 'settings.notifyMetricAlerts', 'settings.notifyMetricAlertsHint']
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
            {paused
              ? pausedIndefinitely(options.notificationsPausedUntil)
                ? t('settings.pausedIndefinitely')
                : t('settings.pausedUntil', { time: formatDate(options.notificationsPausedUntil!, { hour: '2-digit', minute: '2-digit' }) })
              : t('settings.pauseHint')}
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

const BADGE_LABEL: Record<string, MessageKey> = { mac: 'settings.appBadgeMac', windows: 'settings.appBadgeWindows', linux: 'settings.appBadgeLinux' }

/** Settings → General: the count of sessions that need a look on the app icon. */
export function AppBadgeRows({ config, editable, run }: RowsProps) {
  const { t } = useI18n()
  const options = appOptions(config)
  return (
    <SwitchRow label={t('settings.appBadge')} hint={t(BADGE_LABEL[window.hub.platform] ?? 'settings.appBadgeMac')} help={t('help.general.appBadge')}>
      <Switch checked={options.showAppBadge} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ showAppBadge: on }))} />
    </SwitchRow>
  )
}

type PopoverBlock = Exclude<keyof TrayPopoverOptions, 'meetingCount'>

/** The blocks of the menu bar panel, in the order the panel draws them. */
export const TRAY_POPOVER_BLOCKS = [
  ['meetings', 'settings.trayPopover.meetings', 'settings.trayPopover.meetingsHint'],
  ['plan', 'settings.trayPopover.plan', 'settings.trayPopover.planHint'],
  ['pullRequests', 'settings.trayPopover.pullRequests', 'settings.trayPopover.pullRequestsHint'],
  ['health', 'settings.trayPopover.health', 'settings.trayPopover.healthHint'],
  ['usage', 'settings.trayPopover.usage', 'settings.trayPopover.usageHint'],
  ['recent', 'settings.trayPopover.recent', 'settings.trayPopover.recentHint']
] as const satisfies readonly (readonly [PopoverBlock, MessageKey, MessageKey])[]

/** Settings → Notifications → Menu bar panel: which blocks the popover shows, and how many meetings. */
export function TrayPopoverRows({ config, editable, run }: RowsProps) {
  const { t } = useI18n()
  const current = appOptions(config).trayPopover
  const save = (patch: Partial<TrayPopoverOptions>) => void run(() => window.hub.config.saveOptions({ trayPopover: { ...current, ...patch } }))
  return (
    <>
      {TRAY_POPOVER_BLOCKS.map(([block, label, hint]) => (
        <Fragment key={block}>
          <SwitchRow label={t(label)} hint={t(hint)}>
            <Switch checked={current[block]} disabled={!editable} onChange={(on) => save({ [block]: on })} />
          </SwitchRow>
          {block === 'meetings' && current.meetings && (
            <SettingRow label={t('settings.trayPopover.meetingCount')}>
              <Select
                aria-label={t('settings.trayPopover.meetingCount')}
                value={String(current.meetingCount)}
                disabled={!editable}
                onChange={(v) => save({ meetingCount: Number(v) as TrayPopoverOptions['meetingCount'] })}
                options={TRAY_POPOVER_MEETING_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </SettingRow>
          )}
        </Fragment>
      ))}
    </>
  )
}
