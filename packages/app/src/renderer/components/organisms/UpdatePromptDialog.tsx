import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updates-api'
import { useI18n } from '../../i18n/I18nProvider'
import { Button } from '../atoms/Button'
import { Dialog } from '../molecules/Dialog'
import { errorText } from '../../lib/errorText'

/** What the dialog shows when the install call itself failed: the error state, with its message. */
export function failedInstall(status: UpdateStatus, error: unknown): UpdateStatus {
  return { ...status, state: 'error', message: errorText(error) }
}

/**
 * "A new version is available": main asks for it after an automatic check (at most once a day).
 * Update installs it (or opens the release page where the app cannot replace itself), then offers
 * a restart; Later asks again tomorrow; Skip this version never asks for it again.
 */
export function UpdatePromptDialog() {
  const { t } = useI18n()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [installing, setInstalling] = useState(false)
  useEffect(() => {
    const offPrompt = window.hub.updates.onPrompt((s) => {
      setStatus(s)
      setOpen(true)
    })
    const offChanged = window.hub.updates.onChanged((s) => setStatus((prev) => (prev ? s : prev)))
    return () => {
      offPrompt()
      offChanged()
    }
  }, [])
  if (!open || !status) return null

  const version = status.version ?? ''
  const close = () => setOpen(false)
  const install = async () => {
    if (installing) return
    setInstalling(true)
    try {
      const next = await window.hub.updates.install()
      // Without self-install the release page opened: nothing more to wait for here.
      if (!status.canInstall) close()
      else setStatus(next)
    } catch (e) {
      setStatus(failedInstall(status, e))
    } finally {
      setInstalling(false)
    }
  }

  const ready = status.state === 'ready'
  const downloading = status.state === 'downloading'
  const description = ready
    ? t('updates.readyBody', { version })
    : downloading
      ? t('updates.downloading', { version })
      : status.state === 'error'
        ? t('updates.error', { message: status.message ?? '' })
        : t('updates.promptBody', { version, current: status.currentVersion })

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={ready ? t('updates.readyTitle') : t('updates.promptTitle')}
      description={description}
      footer={
        ready ? (
          <>
            <Button variant="ghost" onClick={close}>
              {t('updates.later')}
            </Button>
            <Button variant="primary" onClick={() => void window.hub.updates.restart()}>
              {t('updates.restartNow')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={downloading}
              data-testid="update-skip"
              onClick={() => {
                void window.hub.updates.skip(version)
                close()
              }}
            >
              {t('updates.skipVersion')}
            </Button>
            <Button variant="ghost" disabled={downloading} onClick={close}>
              {t('updates.later')}
            </Button>
            <Button variant="primary" disabled={installing || downloading || status.state !== 'available'} data-testid="update-now" onClick={() => void install()}>
              {status.canInstall ? t('updates.updateNow') : t('updates.download')}
            </Button>
          </>
        )
      }
    >
      {null}
    </Dialog>
  )
}
