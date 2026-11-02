import { Button } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { Dialog } from './Dialog'

export interface ConfirmDeleteDialogProps {
  /** What is about to go ("Delete {name}?"). */
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs after the dialog closes; the caller performs the deletion. */
  onConfirm: () => void
  /** A title naming what goes ("Delete milestone “Beta”?"); "Delete {name}?" by default. */
  title?: string
  /** What happens next; "This cannot be undone." by default. */
  description?: string
  /** The confirm button ("Discard"); "Delete" by default. */
  confirmLabel?: string
}

/** "Delete X? This cannot be undone." with Cancel and a focused Delete (or the caller's own words); the only way to destroy something from a list. */
export function ConfirmDeleteDialog({ name, open, onOpenChange, onConfirm, title, description, confirmLabel }: ConfirmDeleteDialogProps) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t('unsaved.confirmDeleteTitle', { name })}
      description={description ?? t('unsaved.confirmDeleteBody')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            autoFocus
            data-testid="form-delete-confirm"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {confirmLabel ?? t('common.delete')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
