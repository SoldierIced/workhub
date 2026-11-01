import { ExternalLink, Flag, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Connection } from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, Field, RefreshButton, useToast } from '../../components/molecules'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { formToMilestone, milestoneFormProblem, milestoneId, milestoneToForm, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, type MilestoneForm } from '../../lib/planner'
import { relativeTime } from '../../lib/pullRequests'
import { usePlanner } from '../../plannerStore'
import type { PlanTabContext } from './planTabs'

/** A local `YYYY-MM-DD` as a date. */
const dayDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** Progress bar with a marker at the share of time gone. */
export function MilestoneBar({ row, label }: { row: Pick<MilestoneView, 'progress' | 'elapsed' | 'status'>; label: string }) {
  const fill = row.status === 'late' ? 'bg-danger' : row.status === 'atRisk' ? 'bg-warning' : row.status === 'done' ? 'bg-info' : 'bg-success'
  return (
    <div className="relative h-2 w-full rounded-full bg-surface-hover" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress} aria-label={label}>
      <div className={`h-2 rounded-full ${fill}`} style={{ width: `${row.progress}%` }} />
      <div className="absolute -top-0.5 h-3 w-0.5 rounded bg-text/70" style={{ left: `calc(${row.elapsed}% - 1px)` }} aria-hidden />
    </div>
  )
}

function MilestoneEditor({ initial, takenIds, trackers, canSearch, onSave, onCancel }: { initial: MilestoneForm; takenIds: string[]; trackers: Connection[]; canSearch: boolean; onSave: (form: MilestoneForm, id: string) => Promise<boolean>; onCancel: () => void }) {
  const { t } = useI18n()
  const [form, setForm] = useState(initial)
  const [problem, setProblem] = useState<MessageKey | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<MilestoneForm>) => setForm((f) => ({ ...f, ...patch }))
  const save = async () => {
    const gap = milestoneFormProblem(form)
    if (gap) return setProblem(gap)
    setProblem(null)
    setSaving(true)
    try {
      await onSave(form, form.id ?? milestoneId(form.name, takenIds))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/40 p-3" data-testid="milestone-editor">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('planner.milestone.name')} className="col-span-2">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('planner.milestone.namePlaceholder')} />
        </Field>
        <Field label={t('planner.milestone.start')}>
          <Input type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label={t('planner.milestone.end')}>
          <Input type="date" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
        <Field label={t('planner.milestone.source')}>
          <Select
            value={form.kind}
            onChange={(v) => set({ kind: v === 'tracker' ? 'tracker' : 'manual' })}
            options={[
              { value: 'manual', label: t('planner.milestone.source.manual') },
              ...(canSearch || form.kind === 'tracker' ? [{ value: 'tracker', label: t('planner.milestone.source.tracker') }] : [])
            ]}
          />
        </Field>
        {form.kind === 'manual' ? (
          <Field label={t('planner.milestone.progress')}>
            <Input type="number" min={0} max={100} value={form.progress} onChange={(e) => set({ progress: e.target.value })} />
          </Field>
        ) : (
          <Field label={t('planner.milestone.connection')}>
            <Select value={form.connectionId} onChange={(v) => set({ connectionId: v })} options={[{ value: '', label: t('planner.milestone.connectionDefault') }, ...trackers.map((c) => ({ value: c.id, label: c.name || c.id }))]} />
          </Field>
        )}
        {form.kind === 'tracker' && (
          <Field label={t('planner.milestone.query')} hint={t('planner.milestone.queryHint')} className="col-span-2">
            <Input value={form.query} onChange={(e) => set({ query: e.target.value })} placeholder='project = PAY AND fixVersion = "2.4"' spellCheck={false} className="font-mono" />
          </Field>
        )}
        <Field label={t('planner.milestone.link')} className="col-span-2">
          <Input value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://" spellCheck={false} />
        </Field>
        <Field label={t('planner.milestone.notes')} className="col-span-2">
          <Textarea rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {t(problem)}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {t('planner.milestone.save')}
        </Button>
      </div>
    </div>
  )
}

/** Milestones: periods of work with their progress against time, worst first. */
export function MilestonesTab({ profile }: PlanTabContext) {
  const { t, formatDate, locale } = useI18n()
  const toast = useToast()
  const snap = useConfig()
  const { view, loading, refresh, reload } = usePlanner(profile.id, true)
  const [editing, setEditing] = useState<MilestoneForm | null>(null)
  const trackers = (snap?.config.connections ?? []).filter((c) => c.kind === 'tracker')
  const rows = view?.milestones ?? []
  const today = view?.today ?? ''
  const short = (day: string) => formatDate(dayDate(day), { day: 'numeric', month: 'short' })

  const save = async (form: MilestoneForm, id: string) => {
    try {
      const r = await window.hub.planner.saveMilestone(profile.id, formToMilestone(form, id))
      if (!r.ok) {
        toast(r.error, 'danger')
        return false
      }
      setEditing(null)
      await reload()
      return true
    } catch (e) {
      toast(errorText(e), 'danger')
      return false
    }
  }
  const remove = async (id: string) => {
    const r = await window.hub.planner.deleteMilestone(profile.id, id)
    if (!r.ok) toast(r.error, 'danger')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('planner.milestones.intro')}</p>
        {rows.some((r) => r.milestone.source.kind === 'tracker') && <RefreshButton variant="button" label={t('planner.milestones.refresh')} loading={loading} onRefresh={refresh} />}
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setEditing(milestoneToForm(undefined, today))}>
          {t('planner.milestones.add')}
        </Button>
      </div>
      {editing && (
        <Card>
          <CardHeader title={editing.id ? t('planner.milestone.editTitle') : t('planner.milestone.newTitle')} />
          <CardBody>
            <MilestoneEditor key={editing.id ?? 'new'} initial={editing} takenIds={rows.map((r) => r.milestone.id)} trackers={trackers} canSearch={view?.tracker.search ?? false} onSave={save} onCancel={() => setEditing(null)} />
          </CardBody>
        </Card>
      )}
      {!view ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner /> {t('plan.loading')}
        </p>
      ) : rows.length === 0 && !editing ? (
        <EmptyState compact icon={<Flag className="size-5" aria-hidden />} title={t('planner.milestones.empty')} description={t('planner.milestones.emptyHint')} />
      ) : (
        <ul className="rounded-lg border border-border bg-surface shadow-sm" data-testid="milestones">
          {rows.map((row) => {
            const m = row.milestone
            return (
              <li key={m.id} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0" data-testid="milestone">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone={MILESTONE_STATUS_TONE[row.status]}>{t(MILESTONE_STATUS_LABEL[row.status])}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold">{m.name}</p>
                    <p className="flex flex-wrap gap-x-2 text-xs text-muted">
                      <span className="tabular-nums">{t('planner.milestone.dates', { start: short(m.start), end: short(m.end) })}</span>
                      <span className="tabular-nums">{t('planner.milestone.progressOf', { progress: row.progress, elapsed: row.elapsed })}</span>
                      {row.counts && <span className="tabular-nums">{t('planner.milestone.counts', { done: row.counts.done, total: row.counts.total, inProgress: row.counts.inProgress })}</span>}
                      {row.counts && <span>{t('planner.milestone.counted', { time: relativeTime(row.counts.at, Date.now(), locale) })}</span>}
                      {m.source.kind === 'tracker' && !row.counts && !row.error && <span>{t('planner.milestone.notCounted')}</span>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {m.link && <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} aria-label={t('planner.milestone.openLink')} title={t('planner.milestone.openLink')} onClick={() => window.hub.openExternal(m.link!, profile.id)} />}
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} aria-label={t('planner.milestone.edit', { name: m.name })} onClick={() => setEditing(milestoneToForm(m, today))} />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} aria-label={t('planner.milestone.remove', { name: m.name })} onClick={() => void remove(m.id)} />
                  </div>
                </div>
                <MilestoneBar row={row} label={t('planner.milestone.barLabel', { name: m.name, progress: row.progress, elapsed: row.elapsed })} />
                {row.error && (
                  <p role="status" className="text-xs text-danger">
                    {t('planner.milestone.countFailed', { message: row.error })}
                  </p>
                )}
                {m.notes && <p className="whitespace-pre-wrap text-sm text-muted">{m.notes}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
