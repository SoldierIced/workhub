import { Button } from '../components/atoms'
import { useI18n } from '../i18n/I18nProvider'
import type { SetupPage } from '@shared/setup-api'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'

const ENTRIES: readonly (readonly [SetupPage, 'check' | 'welcome' | 'help'])[] = [
  ['check', 'check'],
  ['welcome', 'welcome'],
  ['help', 'help']
]

/** Settings → Advanced › Diagnostics and help: the way back to the setup check, the welcome tour and "How Workhub works". */
export function SetupEntryGroup() {
  const { t } = useI18n()
  return (
    <SettingsGroup anchor="diagnostics" title={t('settingsV2.advanced.diagnostics')}>
      {ENTRIES.map(([page, key]) => (
        <SettingRow key={page} label={t(`setup.entry.${key}`)} hint={t(`setup.entry.${key}Hint`)}>
          <Button size="sm" onClick={() => window.hub.setup.openWindow(page)}>
            {t('setup.entry.open')}
          </Button>
        </SettingRow>
      ))}
    </SettingsGroup>
  )
}
