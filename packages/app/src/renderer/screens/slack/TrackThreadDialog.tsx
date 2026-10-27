import { useEffect, useState } from 'react'
import { Button, Input, Select, Switch } from '../../components/atoms'
import { Dialog, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { trackInput, type TrackForm } from '../../lib/slackLinks'

export interface TrackThreadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefilled fields (the PR window fills the PR and its ticket). */
  initial?: Partial<TrackForm>
  /** Sessions the thread can be linked to (view id and label); none hides the session and wake fields. */
  sessions?: { id: string; label: string }[]
  /** After the thread is followed. */
  onTracked?: () => void
}

const EMPTY: TrackForm = { permalink: '', title: '', prUrl: '', ticketKey: '', sessionId: '', wake: false }

/** Track a Slack link (Workhub 1's TrackThreadSheet): the permalink plus an optional title, PR, ticket and session to wake. */
export function TrackThreadDialog({ open, onOpenChange, initial, sessions, onTracked }: TrackThreadDialogProps) {
  const { t } = useI18n()
  const notify = useToast()
  const [form, setForm] = useState<TrackForm>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setForm({ ...EMPTY, ...initial })
    setError(null)
    // Only on opening: the prefill must not overwrite what the user types.
  }, [open])
  const set = (patch: Partial<TrackForm>) => setForm((f) => ({ ...f, ...patch }))
  const submit = async () => {
    setBusy(true)
    const r = await window.hub.slack.track(trackInput(form))
    setBusy(false)
    if (!r.ok) {
      setError(t(`slack.trackError.${r.error}`))
      return
    }
    notify(t('slack.followed'))
    onTracked?.()
    onOpenChange(false)
  }
  const hasSessions = Boolean(sessions && sessions.length > 0)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={t('slack.trackSheet.heading')}
      description={t('slack.trackSheet.hint')}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="track-thread-form" disabled={busy || form.permalink.trim() === ''}>
            {t('slack.trackSheet.submit')}
          </Button>
        </>
      }
    >
      <form
        id="track-thread-form"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (form.permalink.trim()) void submit()
        }}
      >
        <Field label={t('slack.trackSheet.link')} error={error ?? undefined}>
          <Input autoFocus value={form.permalink} onChange={(e) => set({ permalink: e.target.value })} placeholder="https://workspace.slack.com/archives/C…/p…" />
        </Field>
        <Field label={t('slack.trackSheet.name')}>
          <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder={t('slack.trackSheet.namePlaceholder')} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-3">
          <Field label={t('slack.trackSheet.pr')}>
            <Input value={form.prUrl} onChange={(e) => set({ prUrl: e.target.value })} placeholder="https://github.com/owner/repo/pull/1" />
          </Field>
          <Field label={t('slack.trackSheet.ticket')}>
            <Input value={form.ticketKey} onChange={(e) => set({ ticketKey: e.target.value })} placeholder="ABC-123" className="font-mono" />
          </Field>
        </div>
        {hasSessions && (
          <Field label={t('slack.trackSheet.session')}>
            <Select
              value={form.sessionId}
              onChange={(sessionId) => set({ sessionId, wake: sessionId ? form.wake : false })}
              options={[{ value: '', label: t('slack.trackSheet.noSession') }, ...sessions!.map((s) => ({ value: s.id, label: s.label }))]}
            />
          </Field>
        )}
        {hasSessions && (
          <label className="flex items-start gap-2.5 text-base">
            <Switch checked={form.wake} disabled={!form.sessionId} onChange={(wake) => set({ wake })} aria-label={t('slack.trackSheet.wake')} />
            <span>
              <span className="block">{t('slack.trackSheet.wake')}</span>
              <span className="block text-xs text-subtle">{form.sessionId ? t('slack.trackSheet.wakeHint') : t('slack.trackSheet.wakeNeedsSession')}</span>
            </span>
          </label>
        )}
      </form>
    </Dialog>
  )
}
