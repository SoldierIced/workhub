import { ExternalLink, Flag, Inbox, Link2, Pencil, Unlink } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { inboxSettings, INBOX_KINDS, parseTicketKey, plannerSettings, trackedState, type InboxItem, type InboxKind, type PlanEditor, type PlanLink, type Profile, type TrackedTicket } from '@workhub/core'
import type { PlanItemKind } from '@shared/plan-item-window'
import type { MilestoneView, PlannerView } from '@shared/planner-api'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { EmptyState, Field, Markdown, useToast } from '../../components/molecules'
import { UnsavedPrompt } from '../../components/organisms/UnsavedChanges'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { isDirty } from '../../lib/unsavedChanges'
import { formToMilestone, INBOX_KIND_LABEL, INBOX_SOURCE_LABEL, INBOX_STATUS_LABEL, linksToRows, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, milestoneToForm, PIECE_STATE_LABEL, PIECE_STATE_TONE, rowsToLinks, type LinkRow, type MilestoneForm } from '../../lib/planner'
import { relativeTime } from '../../lib/pullRequests'
import { usePlanner } from '../../plannerStore'
import { PeoplePicker } from './InboxTab'
import { LinksEditor } from './LinksEditor'
import { PiecesList } from './MilestonePieces'
import { MilestoneBar, MilestoneEditor } from './MilestonesTab'

export interface PlanItemDetailProps {
  profile: Profile
  kind: PlanItemKind
  id: string
  /**
   * Opens the edit form when it changes to a number above 0 (the window was opened to edit the
   * item, or asked to again); the form goes back to the details once saved or cancelled.
   */
  editRequest?: number
}

/** A local `YYYY-MM-DD` as a date. */
const dayDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

const UPDATED_BY: Record<PlanEditor, MessageKey> = { user: 'planner.detail.updatedByUser', agent: 'planner.detail.updatedByAgent', tracker: 'planner.detail.updatedByTracker' }

/**
 * One inbox item or milestone in full: its facts, its body as Markdown, its links and a short
 * history, with an edit form for what the user owns. The item's own window shows this; it reads
 * the shared planner store, so a change from the Plan screen or an agent shows up at once.
 */
export function PlanItemDetail({ profile, kind, id, editRequest = 0 }: PlanItemDetailProps) {
  const { t } = useI18n()
  const { view } = usePlanner(profile.id, true)
  if (!view)
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted" role="status">
        <Spinner /> {t('plan.loading')}
      </p>
    )
  const item = kind === 'inbox' ? view.inbox.find((i) => i.id === id) : undefined
  const row = kind === 'milestone' ? view.milestones.find((r) => r.milestone.id === id) : undefined
  if (!item && !row)
    return (
      <div className="p-4">
        <EmptyState compact icon={kind === 'inbox' ? <Inbox className="size-5" aria-hidden /> : <Flag className="size-5" aria-hidden />} title={t('planner.detail.missing')} description={t('planner.detail.missingHint')} />
      </div>
    )
  return item ? <InboxDetail key={item.id} profile={profile} item={item} ticketState={view.itemTickets[item.id]} editRequest={editRequest} /> : <MilestoneDetail key={row!.milestone.id} profile={profile} row={row!} view={view} editRequest={editRequest} />
}

/** Opens the form on mount when asked to, and again on each later request, unless it is open already. */
function useEditRequest(editRequest: number, open: () => void, editing: boolean) {
  useEffect(() => {
    if (editRequest > 0 && !editing) open()
    // Only a new request opens the form; closing it must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold text-muted">{title}</h3>
      {children}
    </section>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The item's links: the single `link` first (named by its host), then the labelled ones. */
function LinksList({ link, links, profileId }: { link?: string; links?: PlanLink[]; profileId: string }) {
  const { t } = useI18n()
  const all = [...(link ? [{ label: hostOf(link), url: link }] : []), ...(links ?? []).filter((l) => l.url !== link)]
  if (all.length === 0) return <p className="text-sm text-muted">{t('planner.links.none')}</p>
  return (
    <ul className="flex flex-col gap-1">
      {all.map((l) => (
        <li key={l.url} className="min-w-0">
          <a
            href={l.url}
            title={l.url}
            className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={(e) => {
              e.preventDefault()
              window.hub.openExternal(l.url, profileId)
            }}
          >
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{l.label}</span>
            {l.label !== l.url && l.label !== hostOf(l.url) && <span className="truncate text-xs text-subtle">{hostOf(l.url)}</span>}
          </a>
        </li>
      ))}
    </ul>
  )
}

/** Created, last changed (by whom) and closed. */
function History({ createdAt, updatedAt, updatedBy, closedAt }: { createdAt?: number; updatedAt?: number; updatedBy?: PlanEditor; closedAt?: number }) {
  const { t, locale, formatDate } = useI18n()
  const when = (ms: number) => ({ time: relativeTime(ms, Date.now(), locale) })
  const full = (ms: number) => formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' })
  const entries: [MessageKey, number][] = [
    ...(createdAt !== undefined ? [['planner.detail.created', createdAt] as [MessageKey, number]] : []),
    ...(updatedAt !== undefined && updatedAt !== createdAt ? [[updatedBy ? UPDATED_BY[updatedBy] : 'planner.detail.updated', updatedAt] as [MessageKey, number]] : []),
    ...(closedAt !== undefined ? [['planner.detail.closed', closedAt] as [MessageKey, number]] : [])
  ]
  if (entries.length === 0) return null
  return (
    <Section title={t('planner.detail.history')}>
      <ul className="flex flex-col gap-0.5 text-sm text-muted">
        {entries.map(([key, ms]) => (
          <li key={key}>
            <time dateTime={new Date(ms).toISOString()} title={full(ms)}>
              {t(key, when(ms))}
            </time>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Header({ badges, title, actions }: { badges: ReactNode; title: string; actions: ReactNode }) {
  return (
    <header className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5">{badges}</p>
        <h1 className="mt-1.5 break-words text-lg font-semibold">
          {title}
        </h1>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </header>
  )
}

/** A notice that the item changed (an agent, another window) while the user was editing it. */
function ChangedNotice({ since, now }: { since: number | undefined; now: number | undefined }) {
  const { t } = useI18n()
  if (since === now) return null
  return (
    <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
      {t('planner.detail.changedWhileEditing')}
    </p>
  )
}

// Inbox item

interface InboxForm {
  kind: InboxKind
  title: string
  detail: string
  area: string
  criticality: string
  due: string
  people: string[]
  links: LinkRow[]
}

const toInboxForm = (item: InboxItem): InboxForm => ({ kind: item.kind, title: item.title, detail: item.detail, area: item.area ?? '', criticality: item.criticality ?? '', due: item.due ?? '', people: item.people ?? [], links: linksToRows(item.links) })

/** An item's ticket: its key (opens it), its live state, and Unlink; or, on a local task or bug without one, "Link ticket" with a key field. */
function TicketFact({ profile, item, state }: { profile: Profile; item: InboxItem; state: TrackedTicket | undefined }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const [linking, setLinking] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const send = async (ticket: { key: string } | null) => {
    setBusy(true)
    try {
      const r = await window.hub.planner.linkTicket(profile.id, item.id, ticket)
      if (!r.ok) return toast(r.error, 'danger')
      setLinking(null)
      setProblem(null)
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(false)
    }
  }
  const canLink = item.status === 'local' && item.kind !== 'decision'
  if (!item.ticket) {
    if (!canLink) return null
    if (linking === null)
      return (
        <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" aria-hidden />} onClick={() => setLinking('')}>
          {t('planner.detail.linkTicket')}
        </Button>
      )
    const submit = () => {
      const key = parseTicketKey(linking)
      if (!key) return setProblem(t('planner.pieces.badKey'))
      void send({ key })
    }
    return (
      <div className="flex flex-col gap-1.5" data-testid="link-ticket">
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={linking}
            onChange={(e) => setLinking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setLinking(null)
              }
            }}
            placeholder="ABC-12"
            aria-label={t('planner.pieces.ticketKey')}
            spellCheck={false}
            className="w-36 font-mono"
          />
          <Button size="sm" variant="primary" disabled={busy || !linking.trim()} onClick={submit}>
            {t('planner.detail.linkSave')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLinking(null)}>
            {t('common.cancel')}
          </Button>
        </div>
        <p className={problem ? 'text-xs text-danger' : 'text-xs text-muted'} role={problem ? 'alert' : undefined}>
          {problem ?? t('planner.detail.linkTicketHint')}
        </p>
      </div>
    )
  }
  const url = item.ticket.url ?? state?.url
  const live = trackedState(state)
  return (
    <span className="flex flex-wrap items-center gap-2">
      {url ? (
        <a
          href={url}
          className="font-mono text-accent hover:underline"
          onClick={(e) => {
            e.preventDefault()
            window.hub.openExternal(url, profile.id)
          }}
        >
          {item.ticket.key}
        </a>
      ) : (
        <span className="font-mono">{item.ticket.key}</span>
      )}
      {state?.title && <span className="text-muted">{state.title}</span>}
      <Badge tone={PIECE_STATE_TONE[live]} title={state?.status}>
        {state?.status && live !== 'unknown' ? state.status : t(PIECE_STATE_LABEL[live])}
      </Badge>
      {state && <span className="text-xs text-subtle">{state.error ? t('planner.pieces.readFailed', { message: state.error }) : state.missing ? t('planner.pieces.missingTicket') : state.unsupported ? t('planner.pieces.unsupported') : t('planner.pieces.checked', { time: relativeTime(state.checkedAt, Date.now(), locale) })}</span>}
      {(item.status === 'local' || item.status === 'ticket') && (
        <Button size="sm" variant="ghost" icon={<Unlink className="size-3.5" aria-hidden />} disabled={busy} title={t('planner.detail.unlinkTicketHint')} onClick={() => void send(null)}>
          {t('planner.detail.unlinkTicket')}
        </Button>
      )}
    </span>
  )
}

function InboxDetail({ profile, item, ticketState, editRequest }: { profile: Profile; item: InboxItem; ticketState: TrackedTicket | undefined; editRequest: number }) {
  const { t, formatDate } = useI18n()
  const [editing, setEditing] = useState<{ form: InboxForm; since: number | undefined } | null>(null)
  useEditRequest(editRequest, () => setEditing({ form: toInboxForm(item), since: item.updatedAt }), editing !== null)
  const people = plannerSettings(profile).people
  const names = (item.people ?? []).map((pid) => people.find((p) => p.id === pid)?.name ?? pid)
  const source = item.source.label ? `${t(INBOX_SOURCE_LABEL[item.source.type])}: ${item.source.label}` : t(INBOX_SOURCE_LABEL[item.source.type])
  const facts: [string, ReactNode][] = [
    [t('planner.inbox.status'), t(INBOX_STATUS_LABEL[item.status])],
    [t('planner.detail.source'), source],
    ...(item.area ? [[t('planner.inbox.area'), item.area] as [string, ReactNode]] : []),
    ...(item.criticality ? [[t('planner.inbox.criticality'), <span className="font-medium">{item.criticality}</span>] as [string, ReactNode]] : []),
    ...(item.due ? [[t('planner.inbox.dueLabel'), formatDate(dayDate(item.due), { day: 'numeric', month: 'short', year: 'numeric' })] as [string, ReactNode]] : []),
    ...(names.length > 0 ? [[t('planner.inbox.people'), names.join(', ')] as [string, ReactNode]] : []),
    ...(item.ticket || (item.status === 'local' && item.kind !== 'decision') ? [[t('planner.detail.ticket'), <TicketFact profile={profile} item={item} state={ticketState} />] as [string, ReactNode]] : [])
  ]
  const editButton = !editing && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing({ form: toInboxForm(item), since: item.updatedAt })}>{t('planner.detail.edit')}</Button>
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="plan-item-detail">
      <Header
        title={item.title}
        actions={editButton}
        badges={
          <>
            <Badge tone={item.kind === 'bug' ? 'danger' : item.kind === 'decision' ? 'info' : 'neutral'}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
            <Badge tone={item.status === 'pending' ? 'warning' : 'neutral'}>{t(INBOX_STATUS_LABEL[item.status])}</Badge>
          </>
        }
      />
      {editing ? (
        <>
          <ChangedNotice since={editing.since} now={item.updatedAt} />
          <InboxEditor profile={profile} item={item} initial={editing.form} onDone={() => setEditing(null)} />
        </>
      ) : (
        <>
          <Facts rows={facts} />
          <Section title={t('planner.inbox.detail')}>{item.detail ? <Markdown text={item.detail} profileId={profile.id} breaks className="text-sm leading-relaxed" /> : <p className="text-sm text-muted">{t('planner.detail.noBody')}</p>}</Section>
          <Section title={t('planner.links.title')}>
            <LinksList link={item.link} links={item.links} profileId={profile.id} />
          </Section>
          <History createdAt={item.createdAt} updatedAt={item.updatedAt} updatedBy={item.updatedBy} closedAt={item.closedAt} />
        </>
      )}
    </div>
  )
}

function InboxEditor({ profile, item, initial, onDone }: { profile: Profile; item: InboxItem; initial: InboxForm; onDone: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [form, setForm] = useState(initial)
  const [problem, setProblem] = useState<MessageKey | null>(null)
  const [saving, setSaving] = useState(false)
  // Esc with edits asks first ("Save your changes?"), like the other editors.
  const [asking, setAsking] = useState(false)
  const dirty = isDirty(initial, form)
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const set = (patch: Partial<InboxForm>) => setForm((f) => ({ ...f, ...patch }))
  // The item's own values stay choosable even when Settings no longer lists them.
  const areas = [...new Set([...settings.areas, ...(item.area ? [item.area] : [])])]
  const levels = [...new Set([...settings.criticalities.map((c) => c.name), ...(item.criticality ? [item.criticality] : [])])]
  const save = async () => {
    const title = form.title.replace(/\s+/g, ' ').trim()
    if (!title) return setProblem('planner.inbox.titleRequired')
    const links = rowsToLinks(form.links)
    if (!links) return setProblem('planner.links.problem')
    setProblem(null)
    setSaving(true)
    try {
      const r = await window.hub.planner.editItem(profile.id, item.id, { kind: form.kind, title, detail: form.detail.trim(), area: form.area || null, criticality: form.criticality || null, due: form.due || null, people: form.people, links })
      if (!r.ok) return toast(r.error, 'danger')
      onDone()
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="plan-item-editor"
      onKeyDown={(e) => {
        // Esc leaves the form and goes back to the details; with edits it asks first.
        if (e.key !== 'Escape' || e.defaultPrevented || asking) return
        e.preventDefault()
        if (dirty) setAsking(true)
        else onDone()
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('planner.inbox.kind')}>
          <Select value={form.kind} onChange={(v) => set({ kind: v as InboxKind })} options={INBOX_KINDS.map((k) => ({ value: k, label: t(INBOX_KIND_LABEL[k]) }))} />
        </Field>
        <Field label={t('planner.inbox.dueLabel')}>
          <Input type="date" value={form.due} onChange={(e) => set({ due: e.target.value })} />
        </Field>
        <Field label={t('planner.inbox.title')} className="col-span-2">
          <Input value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={300} />
        </Field>
        <Field label={t('planner.inbox.detail')} hint={t('planner.detail.markdownHint')} className="col-span-2">
          <Textarea rows={8} value={form.detail} onChange={(e) => set({ detail: e.target.value })} maxLength={5000} />
        </Field>
        <Field label={t('planner.inbox.area')}>
          <Select value={form.area} onChange={(v) => set({ area: v })} options={[{ value: '', label: t('planner.inbox.none') }, ...areas.map((a) => ({ value: a, label: a }))]} />
        </Field>
        <Field label={t('planner.inbox.criticality')}>
          <Select value={form.criticality} onChange={(v) => set({ criticality: v })} options={[{ value: '', label: t('planner.inbox.none') }, ...levels.map((c) => ({ value: c, label: c }))]} />
        </Field>
        {people.length > 0 && (
          <Field label={t('planner.inbox.people')} className="col-span-2">
            <PeoplePicker people={people} value={form.people} onChange={(ids) => set({ people: ids })} />
          </Field>
        )}
        <div className="col-span-2 flex flex-col gap-1.5">
          <span className="text-sm font-medium text-muted">{t('planner.links.title')}</span>
          <LinksEditor rows={form.links} onChange={(links) => set({ links })} />
        </div>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {t(problem)}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {t('planner.detail.save')}
        </Button>
      </div>
      <UnsavedPrompt
        open={asking}
        saving={saving}
        onAnswer={(choice) => {
          setAsking(false)
          if (choice === 'discard') onDone()
          else if (choice === 'save') void save()
        }}
      />
    </div>
  )
}

// Milestone

function MilestoneDetail({ profile, row, view, editRequest }: { profile: Profile; row: MilestoneView; view: PlannerView; editRequest: number }) {
  const { t, locale, formatDate } = useI18n()
  const toast = useToast()
  const snap = useConfig()
  const [editing, setEditing] = useState<{ form: MilestoneForm; since: number | undefined } | null>(null)
  const m = row.milestone
  useEditRequest(editRequest, () => setEditing({ form: milestoneToForm(m, view.today), since: m.updatedAt }), editing !== null)
  const trackers = (snap?.config.connections ?? []).filter((c) => c.kind === 'tracker')
  const day = (d: string) => formatDate(dayDate(d), { day: 'numeric', month: 'short', year: 'numeric' })
  const proposed = view.proposals.some((p) => p.milestoneId === m.id)
  const toggleLink = async (index: number, done: boolean) => {
    if (m.source.kind !== 'items') return
    const items = m.source.items.map((p, i) => (i === index && p.kind === 'link' ? { ...p, done } : p))
    const { createdAt: _c, updatedAt: _u, updatedBy: _b, ...rest } = m
    try {
      const r = await window.hub.planner.saveMilestone(profile.id, { ...rest, source: { kind: 'items', items } })
      if (!r.ok) toast(r.error, 'danger')
    } catch (e) {
      toast(errorText(e), 'danger')
    }
  }
  const save = async (form: MilestoneForm) => {
    try {
      const r = await window.hub.planner.saveMilestone(profile.id, formToMilestone(form, m.id))
      if (!r.ok) {
        toast(r.error, 'danger')
        return false
      }
      setEditing(null)
      return true
    } catch (e) {
      toast(errorText(e), 'danger')
      return false
    }
  }
  const facts: [string, ReactNode][] = [
    [t('planner.detail.dates'), <span className="tabular-nums">{t('planner.milestone.dates', { start: day(m.start), end: day(m.end) })}</span>],
    [t('planner.detail.progress'), <span className="tabular-nums">{t('planner.milestone.progressOf', { progress: row.progress, elapsed: row.elapsed })}</span>],
    m.source.kind === 'tracker'
      ? [t('planner.milestone.query'), <code className="font-mono text-xs break-all">{m.source.query}</code>]
      : [t('planner.detail.countedBy'), m.source.kind === 'manual' ? t('planner.milestone.source.manual') : t('planner.milestone.source.items')],
    ...(row.counts
      ? [
          [
            t('planner.detail.counts'),
            <span className="tabular-nums">
              {t('planner.detail.countsValue', { done: row.counts.done, inProgress: row.counts.inProgress, todo: row.counts.todo, total: row.counts.total })}
              <span className="text-subtle"> · {t('planner.milestone.counted', { time: relativeTime(row.counts.at, Date.now(), locale) })}</span>
            </span>
          ] as [string, ReactNode]
        ]
      : m.source.kind === 'tracker' && !row.error
        ? [[t('planner.detail.counts'), t('planner.milestone.notCounted')] as [string, ReactNode]]
        : [])
  ]
  const editButton = !editing && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing({ form: milestoneToForm(m, view.today), since: m.updatedAt })}>{t('planner.detail.edit')}</Button>
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="plan-item-detail">
      <Header title={m.name} actions={editButton} badges={<Badge tone={MILESTONE_STATUS_TONE[row.status]}>{t(MILESTONE_STATUS_LABEL[row.status])}</Badge>} />
      {proposed && (
        <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-info">
          {t('planner.detail.proposalPending')}
        </p>
      )}
      {editing ? (
        <>
          <ChangedNotice since={editing.since} now={m.updatedAt} />
          <MilestoneEditor profileId={profile.id} inbox={view.inbox} initial={editing.form} takenIds={[]} trackers={trackers} canSearch={view.tracker.search} onSave={save} onCancel={() => setEditing(null)} />
        </>
      ) : (
        <>
          <MilestoneBar row={row} label={t('planner.milestone.barLabel', { name: m.name, progress: row.progress, elapsed: row.elapsed })} />
          <Facts rows={facts} />
          {row.error && (
            <p role="status" className="text-sm text-danger">
              {t('planner.milestone.countFailed', { message: row.error })}
            </p>
          )}
          {row.pieces && (
            <Section title={t('planner.pieces.title')}>
              <PiecesList pieces={row.pieces} profileId={profile.id} onOpenTask={(itemId) => window.hub.planner.openWindow({ profileId: profile.id, kind: 'inbox', id: itemId })} onToggleLink={(i, done) => void toggleLink(i, done)} />
            </Section>
          )}
          <Section title={t('planner.detail.notes')}>{m.notes ? <Markdown text={m.notes} profileId={profile.id} breaks className="text-sm leading-relaxed" /> : <p className="text-sm text-muted">{t('planner.detail.noBody')}</p>}</Section>
          <Section title={t('planner.links.title')}>
            <LinksList link={m.link} links={m.links} profileId={profile.id} />
          </Section>
          <History createdAt={m.createdAt} updatedAt={m.updatedAt} updatedBy={m.updatedBy} />
        </>
      )}
    </div>
  )
}
