import { FolderCog } from 'lucide-react'
import { appOptions } from '@workhub/core'
import type { Workhub1Preview } from '@shared/api'
import { Switch } from '../../components/atoms'
import { SwitchRow } from '../../components/molecules'
import { Workhub1Import } from '../../components/organisms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { showWorkhub1Tokens } from '../../lib/workhub1'
import { SetupEntryGroup } from '../SetupEntryGroup'
import { UpdatesSettings } from '../UpdatesSettings'
import { VoiceSettingsGroup } from '../VoiceSettings'
import { LanguageAppearanceGroup } from './AppearanceGroup'
import { SettingsGroup } from './SettingsLayout'
import type { SectionProps } from './shared'

/** "Keep running in the menu bar" says where the icon stays on each platform. */
const KEEP_LABEL: Record<string, MessageKey> = { mac: 'settingsV2.general.keepInTray', windows: 'settingsV2.general.keepInTrayWindows', linux: 'settingsV2.general.keepInTrayLinux' }

/** Settings → General: language and appearance, opening and closing, voice, and updates. */
export function GeneralSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  const keepLabel = t(KEEP_LABEL[window.hub.platform] ?? 'settingsV2.general.keepInTray')
  return (
    <div className="flex flex-col gap-6" data-testid="settings-general">
      <LanguageAppearanceGroup />
      <SettingsGroup
        anchor="openClose"
        title={t('settingsV2.general.openClose')}
        help={t('help.general.sessions')}
        footnote={window.hub.platform === 'linux' ? t('settings.keepInTrayLinuxNote') : undefined}
      >
        <SwitchRow label={t('settingsV2.general.reopenSessions')} hint={t('settingsV2.general.reopenSessionsHint')}>
          <Switch checked={options.reopenSessions} disabled={!editable} aria-label={t('settingsV2.general.reopenSessions')} onChange={(on) => void run(() => window.hub.config.saveOptions({ reopenSessions: on }))} />
        </SwitchRow>
        <SwitchRow label={t('settingsV2.general.startSessionsAtLaunch')} hint={t('settingsV2.general.startSessionsAtLaunchHint')}>
          <Switch
            checked={options.startSessionsAtLaunch}
            disabled={!editable || !options.reopenSessions}
            aria-label={t('settingsV2.general.startSessionsAtLaunch')}
            onChange={(on) => void run(() => window.hub.config.saveOptions({ startSessionsAtLaunch: on }))}
          />
        </SwitchRow>
        <SwitchRow label={keepLabel} hint={t('settingsV2.general.keepInTrayHint')} help={t('help.general.menuBar')}>
          <Switch checked={options.keepInTray} disabled={!editable} aria-label={keepLabel} onChange={(on) => void run(() => window.hub.config.saveOptions({ keepInTray: on }))} />
        </SwitchRow>
      </SettingsGroup>
      <VoiceSettingsGroup config={snap.config} editable={editable} run={run} />
      <SettingsGroup anchor="updates" title={t('updates.group')} help={t('help.general.updates')} footnote={window.hub.platform === 'mac' ? t('updates.macNote') : undefined}>
        <UpdatesSettings enabled={options.checkForUpdates} editable={editable} run={run} />
      </SettingsGroup>
    </div>
  )
}

/** Settings → Advanced: diagnostics and help, then the data (where it is kept, and the Workhub 1 import while it applies). */
export function AdvancedSection({ snap, run, workhub1, importVisible }: SectionProps & { workhub1: Workhub1Preview | null; importVisible: boolean }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-6" data-testid="settings-advanced">
      <SetupEntryGroup />
      <SettingsGroup anchor="data" title={t('settingsV2.advanced.data')} help={t('help.general.storage')}>
        <div className="flex items-center gap-3 py-3" data-settings-row>
          <FolderCog className="size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <span className="block text-base">{t('settingsV2.advanced.dataDir')}</span>
            <p className="text-xs text-subtle">{t('settingsV2.advanced.dataDirHint')}</p>
          </div>
          <code className="max-w-80 truncate text-sm text-muted" title={snap.dataDir}>
            {snap.dataDir}
          </code>
        </div>
        {importVisible && (
          <div className="flex flex-col gap-1 py-3" data-settings-row data-testid="workhub1-migration">
            <span className="text-base">{t('import.migrate')}</span>
            <p className="text-xs text-subtle">{t('import.migrateHint')}</p>
            <Workhub1Import run={run} showTokens={showWorkhub1Tokens(window.hub.platform, workhub1)} />
          </div>
        )}
      </SettingsGroup>
    </div>
  )
}
