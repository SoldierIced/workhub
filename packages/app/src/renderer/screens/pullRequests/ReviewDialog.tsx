import { useEffect, useState } from 'react'
import type { ReviewAction } from '@workhub/core'
import { Button, Textarea } from '../../components/atoms'
import { Dialog } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'

const TITLE: Record<ReviewAction, MessageKey> = {
  approve: 'pr.action.approve',
  requestChanges: 'pr.action.requestChanges',
  comment: 'pr.action.comment'
}

export interface ReviewDialogProps {
  action: ReviewAction | null
  /** `repo#number title`, shown under the dialog title. */
  subject: string
  onClose: () => void
  /** Returns an error text, or null when the review was sent. */
  onSubmit: (action: ReviewAction, body: string) => Promise<string | null>
}

/** Approve / Request changes / Comment with an optional or required body (Workhub 1's review sheet). */
export function ReviewDialog({ action, subject, onClose, onSubmit }: ReviewDialogProps) {
  const { t } = useI18n()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (action) {
      setBody('')
      setError(null)
    }
  }, [action])
  if (!action) return null
  const needsBody = action !== 'approve'
  const submit = async () => {
    setBusy(true)
    const failure = await onSubmit(action, body)
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t(TITLE[action])}
      description={subject}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant={action === 'requestChanges' ? 'danger' : 'primary'} disabled={busy || (needsBody && body.trim() === '')} onClick={() => void submit()}>
            {busy ? t('pr.action.submitting') : t(TITLE[action])}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('pr.action.bodyLabel')} className="font-sans" autoFocus />
        <p className="text-sm text-muted">{needsBody ? t('pr.action.requiredBody') : t('pr.action.optionalBody')}</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {t('pr.action.failed', { message: error })}
          </p>
        )}
      </div>
    </Dialog>
  )
}
