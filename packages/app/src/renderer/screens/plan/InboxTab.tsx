import { ExternalLink, Inbox, Plus, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { availableInboxActions, filterInbox, groupInbox, inboxSettings, INBOX_KINDS, INBOX_STATUSES, plannerSettings, trackedState, type InboxAction, type InboxItem, type InboxKind, type Person, type TrackedTicket } from '@workhub/core'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Card, CardBody, CardHeader, ConfirmDeleteDialog, EmptyState, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { BULK_CLEAR, BULK_KEEP, bulkChangeCount, bulkFormToPatch, EMPTY_BULK_FORM, EMPTY_ITEM_FORM, formToProposal, inboxActionLabel, INBOX_KIND_LABEL, INBOX_SOURCE_LABEL, INBOX_STATUS_LABEL, PIECE_STATE_LABEL, PIECE_STATE_TONE, plainPreview, type BulkForm, type InboxItemForm } from '../../lib/planner'
import { usePlanner } from '../../plannerStore'
import type { PlanTabContext } from './planTabs'

type Filters = { kind: InboxKind | 'all'; area: string; status: InboxItem['status'] | 'all'; text: string }
const NO_FILTERS: Filters = { kind: 'all', area: 'all', status: 'all', text: '' }

/** Toggle chips for the people an item involves. */
export function PeoplePicker({ people, value, onChange }: { people: Person[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (people.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.map((p) => {
        const on = value.includes(p.id)
        return (
          <button key={p.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} className={cn('rounded-full border px-2 py-0.5 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:bg-surface-hover')}>
            {p.name}
          </button>
        )
      })}
    </div>
  )
}

/** One inbox item with its facts and the actions it offers. */
export function InboxRow({ item, people, selected, onSelect, busy, canCreate, onAction, profileId, onOpen, ticketState }: { item: InboxItem; people: Person[]; selected?: boolean; onSelect?: (on: boolean) => void; busy: boolean; canCreate: boolean; onAction?: (action: InboxAction) => void; profileId: string; onOpen?: () => void; ticketState?: TrackedTicket }) {
  const { t, tn, formatDate } = useI18n()
  const names = (item.people ?? []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean)
  const due = item.due ? formatDate(new Date(`${item.due}T00:00:00`), { day: 'numeric', month: 'short' }) : null
  const ticketUrl = item.ticket?.url ?? ticketState?.url
  return (
    <li className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-b-0" data-testid="inbox-item">
      {/* Header: selection, kind and title on the left, the actions on the right (they wrap under the title when the row is narrow). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {onSelect && <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={selected ?? false} onChange={(e) => onSelect(e.target.checked)} aria-label={t('planner.inbox.select', { title: item.title })} />}
        <p className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2">
          <Badge tone={item.kind === 'bug' ? 'danger' : item.kind === 'decision' ? 'info' : 'neutral'}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
          {onOpen ? (
            <button type="button" className="min-w-0 break-words rounded-sm text-left font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={t('planner.detail.open')} onClick={onOpen}>
              {item.title}
            </button>
          ) : (
            <span className="min-w-0 break-words font-semibold">{item.title}</span>
          )}
        </p>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {item.link && <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} aria-label={t('planner.inbox.openLink')} title={t('planner.inbox.openLink')} onClick={() => window.hub.openExternal(item.link!, profileId)} />}
          {item.ticket && (
            <Button size="sm" variant="ghost" onClick={() => ticketUrl && window.hub.openExternal(ticketUrl, profileId)} disabled={!ticketUrl}>
              {item.ticket.key}
            </Button>
          )}
          {item.ticket && (item.status === 'local' || item.status === 'ticket') && (
            <Badge tone={PIECE_STATE_TONE[trackedState(ticketState)]} title={ticketState?.status}>
              {ticketState?.status && trackedState(ticketState) !== 'unknown' ? ticketState.status : t(PIECE_STATE_LABEL[trackedState(ticketState)])}
            </Badge>
          )}
          {onAction &&
            availableInboxActions(item).map((action) => {
              const needsTracker = action === 'approve' && item.kind !== 'decision'
              if (action === 'discard') return <Button key={action} size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} aria-label={t('planner.inbox.action.discard')} title={t('planner.inbox.action.discard')} disabled={busy} onClick={() => onAction(action)} />
              return (
                <Button key={action} size="sm" variant={action === 'approve' ? 'primary' : action === 'keep' ? 'secondary' : 'ghost'} disabled={busy || (needsTracker && !canCreate)} title={needsTracker && !canCreate ? t('planner.inbox.noCreate') : undefined} onClick={() => onAction(action)}>
                  {busy && action === 'approve' ? <Spinner /> : t(inboxActionLabel(action, item.kind))}
                </Button>
              )
            })}
        </div>
      </div>
      {/* The body takes the whole width of the card. */}
      {item.detail && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{plainPreview(item.detail)}</p>}
      <p className="flex flex-wrap gap-x-3 text-xs text-subtle">
        <span>{item.source.label ? `${t(INBOX_SOURCE_LABEL[item.source.type])}: ${item.source.label}` : t(INBOX_SOURCE_LABEL[item.source.type])}</span>
        {item.area && <span>{item.area}</span>}
        {item.criticality && <span className="font-medium text-text">{item.criticality}</span>}
        {due && <span>{t('planner.inbox.due', { date: due })}</span>}
        {names.length > 0 && <span>{names.join(', ')}</span>}
        {(item.links?.length ?? 0) > 0 && <span>{tn('planner.links.count', item.links!.length)}</span>}
        {item.status !== 'pending' && item.status !== 'local' && item.status !== 'ticket' && <span>{t(INBOX_STATUS_LABEL[item.status])}</span>}
      </p>
    </li>
  )
}

/** Inbox: pending approval, my local tasks, decisions and what closed lately; filters and bulk edit. */
export function InboxTab({ profile, openSettings, openItem }: PlanTabContext) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const { view } = usePlanner(profile.id, true)
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [adding, setAdding] = useState<InboxItemForm | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [bulk, setBulk] = useState<BulkForm>(EMPTY_BULK_FORM)
  // The item whose Discard waits for the user's confirmation.
  const [discarding, setDiscarding] = useState<InboxItem | null>(null)
  const bulkTitleId = useId()
  const items = view?.inbox ?? []
  const shown = useMemo(() => filterInbox(items, filters), [items, filters])
  const groups = groupInbox(shown, view?.today ?? '', settings.criticalities)
  const canCreate = view?.tracker.create ?? false
  const areas = [...new Set([...settings.areas, ...items.map((i) => i.area).filter((a): a is string => Boolean(a))])]

  const act = async (item: InboxItem, action: InboxAction) => {
    setBusy(item.id)
    try {
      const r = await window.hub.planner.act(profile.id, item.id, action)
      if (!r.ok) return toast(r.error, 'danger')
      if (r.ticket) toast(t('planner.inbox.ticketCreated', { key: r.ticket.key }))
      setSelected((s) => s.filter((x) => x !== item.id))
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(null)
    }
  }
  const add = async (force = false) => {
    if (!adding) return
    const proposal = formToProposal(adding)
    if (!proposal.title) return toast(t('planner.inbox.titleRequired'), 'danger')
    const r = await window.hub.planner.addItem(profile.id, proposal, force)
    if (r.ok) {
      setDuplicate(false)
      return setAdding(null)
    }
    if (r.duplicateOf) return setDuplicate(true)
    toast(r.error, 'danger')
  }
  const bulkPatch = bulkFormToPatch(bulk)
  const bulkChanges = bulkChangeCount(items.filter((i) => selected.includes(i.id)), bulkPatch)
  const applyBulk = async () => {
    if (bulkChanges === 0) return
    const r = await window.hub.planner.bulkEdit(profile.id, selected, bulkPatch)
    if (!r.ok) return toast(r.error, 'danger')
    setSelected([])
    setBulk(EMPTY_BULK_FORM)
  }
  const clearSelection = () => {
    setSelected([])
    setBulk(EMPTY_BULK_FORM)
  }
  const select = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  const row = (item: InboxItem, actions = true) => <InboxRow key={item.id} item={item} people={people} selected={selected.includes(item.id)} onSelect={item.status === 'pending' || item.status === 'local' ? (on) => select(item.id, on) : undefined} busy={busy === item.id} canCreate={canCreate} onAction={actions ? (a) => (a === 'discard' ? setDiscarding(item) : void act(item, a)) : undefined} profileId={profile.id} onOpen={() => openItem('inbox', item.id)} ticketState={view?.itemTickets[item.id]} />
  const section = (title: string, list: InboxItem[], empty?: string, testId?: string) =>
    list.length === 0 && !empty ? null : (
      <section className="flex flex-col gap-2" data-testid={testId}>
        <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
          {title} <span className="text-sm font-normal text-subtle">{list.length}</span>
        </h2>
        {list.length === 0 ? <p className="px-1 text-sm text-muted">{empty}</p> : <ul className="rounded-lg border border-border bg-surface shadow-sm">{list.map((i) => row(i))}</ul>}
      </section>
    )
  const tasks = groups.tasks.due.length + groups.tasks.urgent.length + groups.tasks.rest.length + groups.tasks.tracker.length
  const levelOptions = [{ value: '', label: t('planner.inbox.none') }, ...settings.criticalities.map((c) => ({ value: c.name, label: c.name }))]
  const areaOptions = [{ value: '', label: t('planner.inbox.none') }, ...areas.map((a) => ({ value: a, label: a }))]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-muted">{t('planner.inbox.intro')}</p>
        {!canCreate && view?.tracker.error && (
          <Button size="sm" variant="ghost" onClick={() => openSettings('plan')}>
            {t('planner.inbox.setupTracker')}
          </Button>
        )}
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setAdding(EMPTY_ITEM_FORM)}>
          {t('planner.inbox.add')}
        </Button>
      </div>

      {adding && (
        <Card>
          <CardHeader title={t('planner.inbox.addTitle')} />
          <CardBody className="grid grid-cols-2 gap-3">
            <Field label={t('planner.inbox.kind')}>
              <Select value={adding.kind} onChange={(v) => setAdding({ ...adding, kind: v as InboxKind })} options={INBOX_KINDS.map((k) => ({ value: k, label: t(INBOX_KIND_LABEL[k]) }))} />
            </Field>
            <Field label={t('planner.inbox.dueLabel')}>
              <Input type="date" value={adding.due} onChange={(e) => setAdding({ ...adding, due: e.target.value })} />
            </Field>
            <Field label={t('planner.inbox.title')} className="col-span-2">
              <Input
                value={adding.title}
                onChange={(e) => {
                  setAdding({ ...adding, title: e.target.value })
                  setDuplicate(false)
                }}
                maxLength={300}
              />
            </Field>
            <Field label={t('planner.inbox.detail')} hint={t('planner.detail.markdownHint')} className="col-span-2">
              <Textarea rows={3} value={adding.detail} onChange={(e) => setAdding({ ...adding, detail: e.target.value })} />
            </Field>
            <Field label={t('planner.inbox.area')}>
              <Select value={adding.area} onChange={(v) => setAdding({ ...adding, area: v })} options={areaOptions} />
            </Field>
            <Field label={t('planner.inbox.criticality')}>
              <Select value={adding.criticality} onChange={(v) => setAdding({ ...adding, criticality: v })} options={levelOptions} />
            </Field>
            {people.length > 0 && (
              <Field label={t('planner.inbox.people')} className="col-span-2">
                <PeoplePicker people={people} value={adding.people} onChange={(ids) => setAdding({ ...adding, people: ids })} />
              </Field>
            )}
            {duplicate && (
              <p role="alert" className="col-span-2 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                <span className="flex-1">{t('planner.inbox.duplicate')}</span>
                <Button size="sm" variant="ghost" onClick={() => void add(true)}>
                  {t('planner.inbox.addAnyway')}
                </Button>
              </p>
            )}
            <div className="col-span-2 flex justify-end gap-2 border-t border-border pt-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setAdding(null)
                  setDuplicate(false)
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void add()}>
                {t('planner.inbox.addSave')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('planner.inbox.filters')}>
        <div className="w-40 shrink-0"><Select value={filters.kind} aria-label={t('planner.inbox.kind')} onChange={(v) => setFilters((f) => ({ ...f, kind: v as Filters['kind'] }))} options={[{ value: 'all', label: t('planner.inbox.allKinds') }, ...INBOX_KINDS.map((k) => ({ value: k, label: t(INBOX_KIND_LABEL[k]) }))]} /></div>
        <div className="w-40 shrink-0"><Select value={filters.area} aria-label={t('planner.inbox.area')} onChange={(v) => setFilters((f) => ({ ...f, area: v }))} options={[{ value: 'all', label: t('planner.inbox.allAreas') }, ...areas.map((a) => ({ value: a, label: a }))]} /></div>
        <div className="w-40 shrink-0"><Select value={filters.status} aria-label={t('planner.inbox.status')} onChange={(v) => setFilters((f) => ({ ...f, status: v as Filters['status'] }))} options={[{ value: 'all', label: t('planner.inbox.allStatuses') }, ...INBOX_STATUSES.map((s) => ({ value: s, label: t(INBOX_STATUS_LABEL[s]) }))]} /></div>
        <Input value={filters.text} onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))} placeholder={t('planner.inbox.search')} aria-label={t('planner.inbox.search')} className="w-56" />
        {(filters.kind !== 'all' || filters.area !== 'all' || filters.status !== 'all' || filters.text) && (
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => setFilters(NO_FILTERS)}>
            {t('planner.inbox.clearFilters')}
          </Button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2.5" role="group" aria-labelledby={bulkTitleId} data-testid="inbox-bulk">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={bulkTitleId} className="text-sm font-semibold">
              {tn('planner.inbox.bulkTitle', selected.length)}
            </h2>
            <p className="flex-1 text-xs text-muted">{t('planner.inbox.bulkHint')}</p>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              {t('planner.inbox.clearSelection')}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('planner.inbox.area')} className="w-44 shrink-0">
              <Select value={bulk.area} onChange={(v) => setBulk((b) => ({ ...b, area: v }))} options={[{ value: BULK_KEEP, label: t('planner.inbox.bulkKeep') }, { value: BULK_CLEAR, label: t('planner.inbox.bulkClearArea') }, ...areas.map((a) => ({ value: a, label: a }))]} />
            </Field>
            <Field label={t('planner.inbox.criticality')} className="w-44 shrink-0">
              <Select value={bulk.criticality} onChange={(v) => setBulk((b) => ({ ...b, criticality: v }))} options={[{ value: BULK_KEEP, label: t('planner.inbox.bulkKeep') }, { value: BULK_CLEAR, label: t('planner.inbox.bulkClearCriticality') }, ...settings.criticalities.map((c) => ({ value: c.name, label: c.name }))]} />
            </Field>
            <Field label={t('planner.inbox.dueLabel')} className="w-44 shrink-0">
              <Select
                value={bulk.due === 'keep' ? '' : bulk.due}
                onChange={(v) => setBulk((b) => ({ ...b, due: v === 'set' || v === 'clear' ? v : 'keep' }))}
                options={[
                  { value: '', label: t('planner.inbox.bulkKeep') },
                  { value: 'set', label: t('planner.inbox.bulkSetDue') },
                  { value: 'clear', label: t('planner.inbox.bulkClearDue') }
                ]}
              />
            </Field>
            {bulk.due === 'set' && (
              <Field label={t('planner.inbox.bulkNewDue')} className="w-44 shrink-0">
                <Input type="date" value={bulk.dueDate} onChange={(e) => setBulk((b) => ({ ...b, dueDate: e.target.value }))} />
              </Field>
            )}
            <Button variant="primary" disabled={bulkChanges === 0} title={bulkChanges === 0 ? t('planner.inbox.bulkNothing') : undefined} onClick={() => void applyBulk()}>
              {bulkChanges === 0 ? t('planner.inbox.apply') : tn('planner.inbox.applyTo', bulkChanges)}
            </Button>
          </div>
        </div>
      )}

      {!view ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner /> {t('plan.loading')}
        </p>
      ) : items.length === 0 && !adding ? (
        <EmptyState compact icon={<Inbox className="size-5" aria-hidden />} title={t('planner.inbox.empty')} description={t('planner.inbox.emptyHint')} />
      ) : (
        <>
          {section(t('planner.inbox.pending'), groups.pending, t('planner.inbox.pendingEmpty'), 'inbox-pending')}
          <section className="flex flex-col gap-2" data-testid="inbox-tasks">
            <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
              {t('planner.inbox.tasks')} <span className="text-sm font-normal text-subtle">{tasks}</span>
            </h2>
            {tasks === 0 && <p className="px-1 text-sm text-muted">{t('planner.inbox.tasksEmpty')}</p>}
            {(
              [
                ['planner.inbox.tasks.due', groups.tasks.due],
                ['planner.inbox.tasks.urgent', groups.tasks.urgent],
                ['planner.inbox.tasks.rest', groups.tasks.rest],
                ['planner.inbox.tasks.tracker', groups.tasks.tracker]
              ] as const
            ).map(([label, list]) =>
              list.length === 0 ? null : (
                <div key={label} className="flex flex-col gap-1" data-testid={label === 'planner.inbox.tasks.tracker' ? 'inbox-tracker' : undefined}>
                  <h3 className="px-1 text-sm font-medium text-muted">{t(label)}</h3>
                  {label === 'planner.inbox.tasks.tracker' && <p className="px-1 text-xs text-subtle">{t('planner.inbox.tasks.trackerHint')}</p>}
                  <ul className="rounded-lg border border-border bg-surface shadow-sm">{list.map((i) => row(i))}</ul>
                </div>
              )
            )}
          </section>
          {section(t('planner.inbox.decisions'), groups.decisions, t('planner.inbox.decisionsEmpty'), 'inbox-decisions')}
          {section(t('planner.inbox.closed'), groups.closed)}
        </>
      )}

      <ConfirmDeleteDialog
        name={discarding?.title ?? ''}
        open={discarding !== null}
        onOpenChange={(open) => !open && setDiscarding(null)}
        title={t('planner.inbox.confirmDiscard', { title: discarding?.title ?? '' })}
        description={t('planner.inbox.confirmDiscardBody')}
        confirmLabel={t('planner.inbox.action.discard')}
        onConfirm={() => {
          if (discarding) void act(discarding, 'discard')
        }}
      />
    </div>
  )
}
