import { useState } from 'react'
import type { WorktreeStatus } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'
import { offersWorktreeRemoval } from '../../lib/closeSession'
import { useConfig } from '../../configStore'
import type { SessionData } from '../../store'
import { Button } from '../atoms/Button'
import { Dialog } from '../molecules/Dialog'

export interface CloseSessionDialogProps {
  session: SessionData
  /** A turn runs or waits on an answer: closing stops it. */
  working: boolean
  onDone: () => void
  /** Closing failed (the session stays open). */
  onError?: (message: string) => void
}

/**
 * Confirms closing a session: a working one stops its turn, and a session in a worktree Workhub
 * created offers to keep the worktree (the default) or remove it. Removing a worktree with
 * uncommitted changes or unpushed commits asks once more.
 */
export function CloseSessionDialog({ session, working, onDone, onError }: CloseSessionDialogProps) {
  const { t, tn } = useI18n()
  const profiles = useConfig()?.config.profiles ?? []
  const { view } = session
  const worktree = offersWorktreeRemoval(view, profiles) ? view.worktree : undefined
  const [blocked, setBlocked] = useState<WorktreeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const name = view.name || view.agentName

  const fail = (e: unknown) => {
    onError?.(t('sessions.closeFailed', { message: errorText(e) }))
    onDone()
  }
  const keep = () => {
    void window.hub.sessions.close(view.id).catch(fail)
    onDone()
  }
  const remove = async (force: boolean) => {
    setBusy(true)
    try {
      const r = await window.hub.sessions.closeRemovingWorktree(view.id, force)
      if (!r.ok) return setBlocked(r.blocked)
      onDone()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const description = blocked
    ? [blocked.dirty ? t('sessions.worktreeDirty') : '', blocked.unpushed > 0 ? tn('sessions.worktreeUnpushed', blocked.unpushed) : '', t('sessions.worktreeRemoveAnyway')].filter(Boolean).join(' ')
    : [working ? t('sessions.closeBody') : '', worktree ? t('sessions.worktreeBody', { branch: worktree.branch, path: worktree.path }) : ''].filter(Boolean).join(' ')

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onDone()}
      title={t('sessions.closeTitle', { name })}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          {blocked ? (
            <Button variant="danger" disabled={busy} data-testid="confirm-remove-worktree" onClick={() => void remove(true)}>
              {t('sessions.worktreeRemoveForce')}
            </Button>
          ) : worktree ? (
            <>
              <Button variant="ghost" disabled={busy} data-testid="close-remove-worktree" onClick={() => void remove(false)}>
                {t('sessions.worktreeRemove')}
              </Button>
              <Button variant={working ? 'danger' : 'primary'} disabled={busy} data-testid="confirm-close-session" onClick={keep}>
                {t('sessions.worktreeKeep')}
              </Button>
            </>
          ) : (
            <Button variant="danger" data-testid="confirm-close-session" onClick={keep}>
              {t('sessions.closeConfirm')}
            </Button>
          )}
        </>
      }
    >
      {null}
    </Dialog>
  )
}
