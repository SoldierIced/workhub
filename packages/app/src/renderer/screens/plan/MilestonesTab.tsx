import { Bot, Check, ExternalLink, Flag, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Connection, InboxItem, Milestone, MilestoneProposal } from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Card, CardBody, CardHeader, ConfirmDeleteDialog, EmptyState, Field, RefreshButton, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { milestoneFormProblem, milestoneId, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, plainPreview, type MilestoneForm } from '../../lib/planner'
import { relativeTime } from '../../lib/pullRequests'
import { usePlanner } from '../../plannerStore'
import { LinksEditor } from './LinksEditor'
import { PiecesEditor, PiecesList } from './MilestonePieces'
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

/** Pieces shown on a milestone's row of the Milestones tab; the rest are counted, and listed in its window. */
const ROW_PIECES = 5

export function MilestoneEditor({ profileId, inbox, initial, takenIds, trackers, canSearch, onSave, onCancel }: { profileId: string; inbox: readonly InboxItem[]; initial: MilestoneForm; takenIds: string[]; trackers: Connection[]; canSearch: boolean; onSave: (form: MilestoneForm, id: string) => Promise<boolean>; onCancel: () => void }) {
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
    <div
      className="flex flex-col gap-3 rounded-md border border-accent/40 p-3"
      data-testid="milestone-editor"
      onKeyDown={(e) => {
        // Esc cancels the form (in an edit window it goes back to the details; a new milestone's window closes).
        if (e.key !== 'Escape' || e.defaultPrevented) return
        e.preventDefault()
        onCancel()
      }}
    >
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
            onChange={(v) => set({ kind: v === 'tracker' ? 'tracker' : v === 'items' ? 'items' : 'manual' })}
            options={[
              { value: 'manual', label: t('planner.milestone.source.manual') },
              ...(canSearch || form.kind === 'tracker' ? [{ value: 'tracker', label: t('planner.milestone.source.tracker') }] : []),
              { value: 'items', label: t('planner.milestone.source.items') }
            ]}
          />
        </Field>
        {form.kind === 'manual' ? (
          <Field label={t('planner.milestone.progress')}>
            <Input type="number" min={0} max={100} value={form.progress} onChange={(e) => set({ progress: e.target.value })} />
          </Field>
        ) : form.kind === 'tracker' ? (
          <Field label={t('planner.milestone.connection')}>
            <Select value={form.connectionId} onChange={(v) => set({ connectionId: v })} options={[{ value: '', label: t('planner.milestone.connectionDefault') }, ...trackers.map((c) => ({ value: c.id, label: c.name || c.id }))]} />
          </Field>
        ) : (
          <div />
        )}
        {form.kind === 'items' && (
          <div className="col-span-2 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">{t('planner.pieces.title')}</span>
            <PiecesEditor profileId={profileId} pieces={form.pieces} onChange={(pieces) => set({ pieces })} inbox={inbox} trackers={trackers} />
          </div>
        )}
        {form.kind === 'tracker' && (
          <Field label={t('planner.milestone.query')} hint={t('planner.milestone.queryHint')} className="col-span-2">
            <Input value={form.query} onChange={(e) => set({ query: e.target.value })} placeholder='project = PAY AND fixVersion = "2.4"' spellCheck={false} className="font-mono" />
          </Field>
        )}
        <Field label={t('planner.milestone.link')} className="col-span-2">
          <Input value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://" spellCheck={false} />
        </Field>
        <div className="col-span-2 flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted">{t('planner.links.title')}</span>
          <LinksEditor rows={form.links} onChange={(links) => set({ links })} />
        </div>
        <Field label={t('planner.milestone.notes')} hint={t('planner.detail.markdownHint')} className="col-span-2">
          <Textarea rows={5} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
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

/** One line of what a milestone is: its dates and its progress (typed, counted or made of pieces). */
function milestoneLine(m: Milestone, short: (day: string) => string, t: ReturnType<typeof useI18n>['t'], tn: ReturnType<typeof useI18n>['tn']): string {
  const progress = m.source.kind === 'manual' ? t('planner.proposal.progress', { progress: m.source.progress }) : m.source.kind === 'tracker' ? t('planner.proposal.query', { query: m.source.query }) : tn('planner.proposal.pieces', m.source.items.length)
  return `${t('planner.milestone.dates', { start: short(m.start), end: short(m.end) })} · ${progress}`
}

const PROPOSAL_TITLE: Record<MilestoneProposal['action'], MessageKey> = {
  create: 'planner.proposal.create',
  update: 'planner.proposal.update',
  delete: 'planner.proposal.delete'
}

/** Milestone changes agents asked for, waiting for the user to apply or reject them. */
function ProposalsCard({ profileId, proposals, short }: { profileId: string; proposals: MilestoneProposal[]; short: (day: string) => string }) {
  const { t, tn, locale } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const resolve = async (id: string, accept: boolean) => {
    setBusy(id)
    try {
      const r = await window.hub.planner.resolveProposal(profileId, id, accept)
      if (!r.ok) toast(r.error, 'danger')
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card data-testid="milestone-proposals">
      <CardHeader title={t('planner.proposals.title', { count: proposals.length })} />
      <CardBody>
        <p className="mb-2 text-sm text-muted">{t('planner.proposals.hint')}</p>
        <ul className="flex flex-col gap-2">
          {proposals.map((p) => {
            const name = p.milestone?.name ?? p.before?.name ?? p.milestoneId
            return (
              <li key={p.id} className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-2" data-testid="milestone-proposal">
                <Bot className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{t(PROPOSAL_TITLE[p.action], { name })}</p>
                  {p.before && p.action === 'update' && <p className="text-xs text-subtle line-through">{milestoneLine(p.before, short, t, tn)}</p>}
                  {p.milestone && <p className="text-xs text-muted">{milestoneLine(p.milestone, short, t, tn)}</p>}
                  <p className="text-xs text-subtle">
                    {p.source.label ? `${p.source.label} · ` : ''}
                    {relativeTime(p.createdAt, Date.now(), locale)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="primary" icon={<Check className="size-3.5" aria-hidden />} disabled={busy === p.id} onClick={() => void resolve(p.id, true)}>
                    {t('planner.proposals.apply')}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} disabled={busy === p.id} onClick={() => void resolve(p.id, false)}>
                    {t('planner.proposals.reject')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </CardBody>
    </Card>
  )
}

/** Milestones: periods of work with their progress against time, worst first. Details and the editor open in windows of their own. */
export function MilestonesTab({ profile, openItem }: PlanTabContext) {
  const { t, formatDate, locale } = useI18n()
  const toast = useToast()
  const { view, loading, refresh } = usePlanner(profile.id, true)
  // The milestone whose Delete waits for the user's confirmation.
  const [deleting, setDeleting] = useState<Milestone | null>(null)
  const rows = view?.milestones ?? []
  const short = (day: string) => formatDate(dayDate(day), { day: 'numeric', month: 'short' })

  const remove = async (id: string) => {
    try {
      const r = await window.hub.planner.deleteMilestone(profile.id, id)
      if (!r.ok) toast(r.error, 'danger')
    } catch (e) {
      toast(errorText(e), 'danger')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('planner.milestones.intro')}</p>
        {rows.some((r) => r.milestone.source.kind === 'tracker' || (r.milestone.source.kind === 'items' && r.milestone.source.items.some((p) => p.kind === 'ticket'))) && <RefreshButton variant="button" label={t('planner.milestones.refresh')} loading={loading} onRefresh={refresh} />}
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => window.hub.planner.openWindow({ profileId: profile.id, kind: 'milestone', new: true })}>
          {t('planner.milestones.add')}
        </Button>
      </div>
      {(view?.proposals.length ?? 0) > 0 && <ProposalsCard profileId={profile.id} proposals={view!.proposals} short={short} />}
      {!view ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner /> {t('plan.loading')}
        </p>
      ) : rows.length === 0 ? (
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
                    <button type="button" className="block max-w-full truncate rounded-sm text-left text-base font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={t('planner.detail.open')} onClick={() => openItem('milestone', m.id)}>
                      {m.name}
                    </button>
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
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} aria-label={t('planner.milestone.edit', { name: m.name })} title={t('planner.milestone.edit', { name: m.name })} onClick={() => window.hub.planner.openWindow({ profileId: profile.id, kind: 'milestone', id: m.id, edit: true })} />
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} aria-label={t('planner.milestone.remove', { name: m.name })} title={t('planner.milestone.remove', { name: m.name })} onClick={() => setDeleting(m)} />
                  </div>
                </div>
                <MilestoneBar row={row} label={t('planner.milestone.barLabel', { name: m.name, progress: row.progress, elapsed: row.elapsed })} />
                {row.error && (
                  <p role="status" className="text-xs text-danger">
                    {t('planner.milestone.countFailed', { message: row.error })}
                  </p>
                )}
                {row.pieces && <PiecesList pieces={row.pieces} profileId={profile.id} compact limit={ROW_PIECES} />}
                {m.notes && <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted">{plainPreview(m.notes)}</p>}
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDeleteDialog
        name={deleting?.name ?? ''}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('planner.milestone.confirmDelete', { name: deleting?.name ?? '' })}
        onConfirm={() => {
          if (deleting) void remove(deleting.id)
        }}
      />
    </div>
  )
}
