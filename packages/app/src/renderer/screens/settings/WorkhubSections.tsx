import { FolderCog } from 'lucide-react'
import { appOptions } from '@workhub/core'
import type { Workhub1Preview } from '@shared/api'
import { Select, Switch } from '../../components/atoms'
import { Card, SwitchRow } from '../../components/molecules'
import { Workhub1Import } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { showWorkhub1Tokens } from '../../lib/workhub1'
import { AppBadgeRows, MenuBarRows, OtherNotificationRows, TrayPopoverRows } from '../NotificationExtraSettings'
import { NotificationMasterRows } from '../NotificationMasterRow'
import { ProtectedBranchesRows } from '../ProtectedBranchesRows'
import { PullRequestNotificationRows } from '../PullRequestNotificationSettings'
import { UpdatesSettings } from '../UpdatesSettings'
import { VoiceSettingsGroup } from '../VoiceSettings'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import type { SectionProps } from './shared'

/** Settings → General: language, reopening sessions, updates and reading aloud. */
export function GeneralSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const { language } = usePrefs()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t('settings.interface')} help={t('help.general.interface')} footnote={t('settings.languageHint')}>
        <SettingRow label={t('settings.language')}>
          <Select
            aria-label={t('settings.language')}
            value={language}
            onChange={(v) => setPrefs({ language: v as typeof language })}
            options={[
              { value: 'system', label: t('settings.system') },
              { value: 'en', label: 'English' },
              { value: 'es', label: 'Español' }
            ]}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title={t('settings.sessionsGroup')} help={t('help.general.sessions')}>
        <SwitchRow label={t('settings.reopenSessions')} hint={t('settings.reopenSessionsHint')}>
          <Switch checked={options.reopenSessions} disabled={!editable} aria-label={t('settings.reopenSessions')} onChange={(on) => void run(() => window.hub.config.saveOptions({ reopenSessions: on }))} />
        </SwitchRow>
      </SettingsGroup>
      <SettingsGroup anchor="updates" title={t('updates.group')} help={t('help.general.updates')} footnote={window.hub.platform === 'mac' ? t('updates.macNote') : undefined}>
        <UpdatesSettings enabled={options.checkForUpdates} editable={editable} run={run} />
      </SettingsGroup>
      <VoiceSettingsGroup config={snap.config} editable={editable} run={run} />
    </div>
  )
}

/** Settings → Notifications: the master switch, each kind, pull request events, the pause, the badge and the menu bar icon. */
export function NotificationsSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  return (
    <div className="flex flex-col gap-6" data-testid="settings-notifications">
      <SettingsGroup title={t('settings.notifications')} help={t('help.general.notifications')} footnote={t('settings.notificationsNote')}>
        <NotificationMasterRows config={snap.config} editable={editable} run={run} />
        {(
          [
            ['notifyReplied', 'settings.notifyReplied', 'settings.notifyRepliedHint'],
            ['notifyNeedsAnswer', 'settings.notifyNeedsAnswer', 'settings.notifyNeedsAnswerHint'],
            ['notifyError', 'settings.notifyError', 'settings.notifyErrorHint']
          ] as const
        ).map(([option, label, hint]) => (
          <SwitchRow key={option} label={t(label)} hint={t(hint)}>
            <Switch checked={options[option]} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ [option]: on }))} />
          </SwitchRow>
        ))}
      </SettingsGroup>
      <SettingsGroup title={t('settings.otherNotifications')} help={t('help.general.otherNotifications')} footnote={t('settings.otherNotificationsNote')}>
        <OtherNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('prevent.settings.title')} help={t('help.general.prEvents')} footnote={t('prevent.settings.note')}>
        <PullRequestNotificationRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.pullRequests')}>
        <ProtectedBranchesRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      <SettingsGroup title={t('settings.menuBar')} help={t('help.general.menuBar')} footnote={window.hub.platform === 'linux' ? t('settings.keepInTrayLinuxNote') : undefined}>
        <MenuBarRows config={snap.config} editable={editable} run={run} />
        <AppBadgeRows config={snap.config} editable={editable} run={run} />
      </SettingsGroup>
      {window.hub.platform !== 'linux' && (
        <SettingsGroup title={t('settings.trayPopover')} footnote={t('settings.trayPopoverNote')}>
          <TrayPopoverRows config={snap.config} editable={editable} run={run} />
        </SettingsGroup>
      )}
    </div>
  )
}

/** Settings → Storage and data: the folder with `config.json` and `secrets.json`. */
export function StorageSection({ snap }: Pick<SectionProps, 'snap'>) {
  const { t } = useI18n()
  return (
    <SettingsGroup title={t('settings.storage')} help={t('help.general.storage')}>
      <div className="flex items-center gap-3 py-3" data-settings-row>
        <FolderCog className="size-4 text-muted" aria-hidden />
        <span className="flex-1 text-base">{t('settings.dataDir')}</span>
        <code className="truncate text-sm text-muted" title={snap.dataDir}>
          {snap.dataDir}
        </code>
      </div>
    </SettingsGroup>
  )
}

/** Settings → Import from Workhub 1 (macOS, while Workhub 1 is on this Mac). */
export function ImportSection({ run, workhub1 }: Pick<SectionProps, 'run'> & { workhub1: Workhub1Preview | null }) {
  const { t } = useI18n()
  return (
    <Card className="px-4" data-testid="workhub1-migration">
      <h2 className="pt-3 text-md font-semibold">{t('import.migrate')}</h2>
      <p className="text-sm text-subtle">{t('import.migrateHint')}</p>
      <Workhub1Import run={run} showTokens={showWorkhub1Tokens(window.hub.platform, workhub1)} />
    </Card>
  )
}
