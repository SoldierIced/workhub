import { Check, Trash2 } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Kbd } from '../atoms'
import { ConfirmDeleteDialog, Dialog } from '../molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { createUnsavedChanges, draftKey, type SaveOutcome, type UnsavedChanges, type UnsavedSnapshot } from '../../lib/unsavedChanges'

const UnsavedContext = createContext<UnsavedChanges | null>(null)

/** ⌘S / Ctrl+S: saves the open form. */
export const SAVE_SHORTCUT = { key: 's' }

/** Gives the forms below one shared unsaved-changes store (Settings creates one per modal). */
export function UnsavedChangesProvider({ store, children }: { store: UnsavedChanges; children: ReactNode }) {
  return <UnsavedContext.Provider value={store}>{children}</UnsavedContext.Provider>
}

/** The store of the nearest provider; outside one, a private store so a form still works alone. */
export function useUnsavedChanges(): UnsavedChanges {
  const outer = useContext(UnsavedContext)
  const [own] = useState(createUnsavedChanges)
  return outer ?? own
}

export function useUnsavedSnapshot(store: UnsavedChanges): UnsavedSnapshot {
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/**
 * Registers a form's draft with the nearest store: the save bar shows while `dirty`, and its Save
 * and Discard (and the leave prompt) call `save` and `discard`. The latest callbacks are always used.
 */
export function useUnsavedForm(form: {
  dirty: boolean
  save: () => Promise<SaveOutcome>
  discard: () => void
  /** The draft itself: editing it after a refused save clears the bar's problem. */
  draft?: unknown
}): UnsavedChanges {
  const store = useUnsavedChanges()
  const id = useId()
  const latest = useRef(form)
  latest.current = form
  useEffect(
    () =>
      store.register(id, {
        get dirty() {
          return latest.current.dirty
        },
        save: () => latest.current.save(),
        discard: () => latest.current.discard()
      }),
    [store, id]
  )
  useEffect(() => store.refresh(), [store, form.dirty])
  const key = form.draft === undefined ? '' : draftKey(form.draft)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else store.clearFailure()
  }, [store, key])
  return store
}

/**
 * Pinned at the bottom of the Settings modal: "Unsaved changes" with Discard and Save while a form
 * has a draft, what to fix when a save was refused, and a brief "Saved" after a save went through.
 */
export function SaveBar({ store }: { store: UnsavedChanges }) {
  const { t } = useI18n()
  const s = useUnsavedSnapshot(store)
  const [showSaved, setShowSaved] = useState(false)
  useEffect(() => {
    if (!s.savedAt) return
    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [s.savedAt])

  if (!s.dirty && !s.saving) {
    if (!showSaved) return null
    return (
      <div role="status" data-testid="save-bar-saved" className="flex shrink-0 items-center justify-end gap-1.5 border-t border-border bg-surface px-8 py-2.5 text-sm text-success">
        <Check className="size-4" aria-hidden />
        {t('unsaved.saved')}
      </div>
    )
  }
  const problem = s.failed ? (s.problem ? t('unsaved.fixField', { problem: s.problem }) : (s.serverProblem ?? t('unsaved.couldNotSave'))) : null
  return (
    <div data-testid="save-bar" className="flex shrink-0 items-center gap-3 border-t border-border bg-surface-raised px-8 py-2.5 shadow-[0_-4px_12px_-8px_rgb(0_0_0/0.25)]">
      <span role={problem ? 'alert' : 'status'} className={problem ? 'min-w-0 flex-1 text-sm text-danger' : 'min-w-0 flex-1 text-sm font-medium text-text'}>
        {problem ?? t('unsaved.changes')}
      </span>
      <Button variant="ghost" disabled={s.saving} onClick={() => store.discardAll()} data-testid="save-bar-discard">
        {t('unsaved.discard')}
      </Button>
      <Button variant="primary" disabled={s.saving} onClick={() => void store.saveAll()} data-testid="save-bar-save">
        {s.saving ? t('unsaved.saving') : t('unsaved.save')}
        <Kbd shortcut={SAVE_SHORTCUT} className="text-accent-fg/75" />
      </Button>
    </div>
  )
}

/** "Save your changes?" before a close, tab or item switch would throw a draft away. */
export function UnsavedPrompt({
  open,
  saving,
  onAnswer,
  onCloseAutoFocus
}: {
  open: boolean
  saving?: boolean
  onAnswer: (choice: 'save' | 'discard' | 'cancel') => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onCloseAutoFocus={onCloseAutoFocus}
      onOpenChange={(o) => !o && onAnswer('cancel')}
      title={t('unsaved.promptTitle')}
      description={t('unsaved.promptBody')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAnswer('cancel')} data-testid="unsaved-cancel">
            {t('unsaved.keepEditing')}
          </Button>
          <Button variant="danger" onClick={() => onAnswer('discard')} data-testid="unsaved-discard">
            {t('unsaved.discard')}
          </Button>
          <Button variant="primary" autoFocus disabled={saving} onClick={() => onAnswer('save')} data-testid="unsaved-save">
            {t('unsaved.save')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  )
}

/** The prompt of a store, answered through it. */
export function StoreUnsavedPrompt({ store, restoreFocus }: { store: UnsavedChanges; restoreFocus?: () => void }) {
  const s = useUnsavedSnapshot(store)
  return (
    <UnsavedPrompt
      open={s.prompting}
      saving={s.saving}
      onAnswer={(c) => void store.answer(c)}
      onCloseAutoFocus={
        restoreFocus
          ? (e) => {
              // Keep focus inside the dialog that asked, so its shortcuts (⌘S) keep working.
              e.preventDefault()
              restoreFocus()
            }
          : undefined
      }
    />
  )
}

/** A small danger button for a form header that asks before deleting. */
export function DeleteButton({ name, onDelete }: { name: string; onDelete: () => void }) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)
  return (
    <>
      <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setAsking(true)} data-testid="form-delete">
        {t('common.delete')}
      </Button>
      <ConfirmDeleteDialog name={name} open={asking} onOpenChange={setAsking} onConfirm={onDelete} />
    </>
  )
}
