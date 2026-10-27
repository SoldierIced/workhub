import { useState } from 'react'
import type { SessionView } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'
import { Button } from '../atoms/Button'
import { Input } from '../atoms/Input'
import { Dialog } from '../molecules/Dialog'
import { Field } from '../molecules/Field'
import { useToast } from '../molecules/Toast'

/** Longest name the field takes (main keeps at most this many characters too). */
const MAX_NAME = 120

/** Names a session; an empty name shows its agent's name again. */
export function RenameSessionDialog({ session, onClose }: { session: SessionView | null; onClose: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [name, setName] = useState('')
  const [seen, setSeen] = useState<SessionView | null>(null)
  // Fill the field with the current name when the dialog opens for a session.
  if (session !== seen) {
    setSeen(session)
    setName(session?.name ?? '')
  }
  if (!session) return null
  const save = () => {
    void window.hub.sessions.rename(session.id, name.trim() || null).catch((e: unknown) => toast(t('session.renameFailed', { message: errorText(e) }), 'danger'))
    onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('session.renameTitle')}
      description={t('session.renameHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" data-testid="save-session-name" onClick={save}>
            {t('session.renameSave')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Field label={t('session.renameLabel')}>
          <Input autoFocus value={name} maxLength={MAX_NAME} placeholder={session.agentName} data-testid="session-name" onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}
