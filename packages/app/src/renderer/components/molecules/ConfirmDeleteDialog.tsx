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
}

/** "Delete X? This cannot be undone." with Cancel and a focused Delete; the only way to destroy something from a list. */
export function ConfirmDeleteDialog({ name, open, onOpenChange, onConfirm }: ConfirmDeleteDialogProps) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('unsaved.confirmDeleteTitle', { name })}
      description={t('unsaved.confirmDeleteBody')}
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
            {t('common.delete')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}
