import { useEffect, useState } from 'react'
import type { Result, WorkhubConfig } from '@workhub/core'
import type { UpdateStatus } from '@shared/updates-api'
import { Button, Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'

/** The "check for updates" switch and the result of the last check (P8). */
export function UpdatesSettings({
  enabled,
  editable,
  run
}: {
  enabled: boolean
  editable: boolean
  run: (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.hub.updates.status().then(setStatus)
    return window.hub.updates.onChanged(setStatus)
  }, [])

  const line = !status
    ? ''
    : status.state === 'checking'
      ? t('updates.checking')
      : status.state === 'none'
        ? t('updates.none', { version: status.currentVersion })
        : status.state === 'available'
          ? t('updates.available', { version: status.version ?? '' })
          : status.state === 'downloading'
            ? t('updates.downloading', { version: status.version ?? '' })
            : status.state === 'error'
              ? t('updates.error', { message: status.message ?? '' })
              : status.state === 'unsupported'
                ? t('updates.unsupported')
                : t('updates.version', { version: status.currentVersion })

  return (
    <>
      <SwitchRow label={t('updates.check')} hint={t('updates.checkHint')}>
        <Switch checked={enabled} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ checkForUpdates: on }))} />
      </SwitchRow>
      <div className="flex items-center justify-between gap-4 py-3">
        <span className="text-sm text-muted" data-testid="update-status">
          {line}
        </span>
        <div className="flex gap-2">
          {status?.state === 'available' && (
            <Button onClick={() => void window.hub.updates.install()}>{status.canInstall ? t('updates.install') : t('updates.download')}</Button>
          )}
          <Button disabled={!status || status.state === 'unsupported' || status.state === 'checking' || status.state === 'downloading'} onClick={() => void window.hub.updates.check()}>
            {t('updates.checkNow')}
          </Button>
        </div>
      </div>
    </>
  )
}
