import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isLongLivedBranch, prName, type PullRequest } from '@workhub/core'
import { Button, Switch, Textarea } from '../../components/atoms'
import { Dialog, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'

export interface ClosePullRequestDialogProps {
  profileId: string | null
  /** The PR to close; null keeps the dialog shut. */
  pr: Pick<PullRequest, 'url' | 'title' | 'branch' | 'repo' | 'number' | 'provider' | 'owner'> | null
  onClose: () => void
  /** After the host closed it. */
  onClosed?: () => void
}

/** "Close PR…" (Workhub 1's close sheet): an optional closing comment and "Delete the branch", locked for long-lived branches. */
export function ClosePullRequestDialog({ profileId, pr, onClose, onClosed }: ClosePullRequestDialogProps) {
  const { t } = useI18n()
  const notify = useToast()
  const [comment, setComment] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setComment('')
    setDeleteBranch(false)
    setError(null)
  }, [pr?.url])
  if (!pr) return null
  const locked = isLongLivedBranch(pr.branch)
  const submit = async () => {
    setBusy(true)
    const r = await window.hub.codeHost.close(profileId, pr.url, comment, deleteBranch && !locked)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    notify(t('pr.close.done', { name: prName(pr, pr.provider) }))
    onClosed?.()
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t('pr.close.title', { name: prName(pr, pr.provider) })}
      description={pr.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? t('pr.close.closing') : t('pr.close.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('pr.close.comment')} aria-label={t('pr.close.comment')} className="font-sans" autoFocus />
        {locked ? (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t('pr.close.protected', { branch: pr.branch })}
          </p>
        ) : (
          <label className="flex items-center gap-2.5 text-base">
            <Switch checked={deleteBranch} onChange={setDeleteBranch} aria-label={t('pr.close.deleteBranch', { branch: pr.branch })} />
            <span>{t('pr.close.deleteBranch', { branch: pr.branch })}</span>
          </label>
        )}
        <p className="text-xs text-subtle">{t('pr.close.hint')}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {t('pr.action.failed', { message: error })}
          </p>
        )}
      </div>
    </Dialog>
  )
}
