import { useEffect, useState } from 'react'
import { appOptions, DEFAULT_PROTECTED_BRANCHES, parseBranchList, type Result, type WorkhubConfig } from '@workhub/core'
import { Button, Input } from '../components/atoms'
import { useI18n } from '../i18n/I18nProvider'
import { SettingRow } from './settings/SettingsLayout'

/** Settings → Pull requests: the branches Close PR never deletes (empty field: the default list). */
export function ProtectedBranchesRows({
  config,
  editable,
  run
}: {
  config: WorkhubConfig
  editable: boolean
  run: (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>
}) {
  const { t } = useI18n()
  const stored = appOptions(config).protectedBranches
  const shown = (stored ?? DEFAULT_PROTECTED_BRANCHES).join(', ')
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    const list = parseBranchList(text)
    if ((list.length ? list : [...DEFAULT_PROTECTED_BRANCHES]).join(', ') === shown) return
    void run(() => window.hub.config.saveOptions({ protectedBranches: list.length ? list : undefined }))
  }
  return (
    <SettingRow label={t('settings.protectedBranches')} hint={t('settings.protectedBranchesHint')}>
      <div className="flex flex-col items-stretch gap-1.5">
        <Input
          aria-label={t('settings.protectedBranches')}
          value={text}
          disabled={!editable}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {stored && (
          <Button size="sm" variant="ghost" disabled={!editable} onClick={() => void run(() => window.hub.config.saveOptions({ protectedBranches: undefined }))}>
            {t('settings.protectedBranchesReset')}
          </Button>
        )}
      </div>
    </SettingRow>
  )
}
