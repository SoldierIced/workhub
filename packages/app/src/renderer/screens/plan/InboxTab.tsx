import { ExternalLink, Inbox, Plus, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { availableInboxActions, filterInbox, inboxSettings, INBOX_KINDS, plannerSettings, trackedState, type CriticalityLevel, type InboxAction, type InboxItem, type InboxKind, type Person, type TrackedTicket } from '@workhub/core'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Card, CardBody, CardHeader, ConfirmDeleteDialog, Dialog, EmptyState, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { BULK_CLEAR, BULK_KEEP, bulkChangeCount, createsTicket, bulkFormToPatch, EMPTY_BULK_FORM, EMPTY_ITEM_FORM, formToProposal, inboxActionLabel, INBOX_KIND_LABEL, INBOX_SOURCE_LABEL, INBOX_STATUS_LABEL, PIECE_STATE_LABEL, PIECE_STATE_TONE, plainPreview, selectedShown, type BulkForm, type InboxItemForm } from '../../lib/planner'
import { ItemMilestones } from './ItemMilestones'
import { requestPlanTab, usePlanner } from '../../plannerStore'
import type { PlanTabContext } from './planTabs'

export type InboxFilters = { kind: InboxKind | 'all'; area: string; text: string }
export const NO_FILTERS: InboxFilters = { kind: 'all', area: 'all', text: '' }
const hasFilters = (f: InboxFilters) => f.kind !== 'all' || f.area !== 'all' || f.text !== ''

/** The items that pass the filters (kind, area and words in the title or detail). */
export function applyFilters(items: readonly InboxItem[], f: InboxFilters): InboxItem[] {
  return filterInbox(items, { ...f, status: 'all' })
}

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
export function InboxRow({ item, people, selected, onSelect, busy, canCreate, onAction, profileId, onOpen, ticketState, milestones }: { item: InboxItem; people: Person[]; selected?: boolean; onSelect?: (on: boolean) => void; busy: boolean; canCreate: boolean; onAction?: (action: InboxAction) => void; profileId: string; onOpen?: () => void; ticketState?: TrackedTicket; milestones?: ReactNode }) {
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        {milestones}
        <span>{item.source.label ? `${t(INBOX_SOURCE_LABEL[item.source.type])}: ${item.source.label}` : t(INBOX_SOURCE_LABEL[item.source.type])}</span>
        {item.area && <span>{item.area}</span>}
        {item.criticality && <span className="font-medium text-text">{item.criticality}</span>}
        {due && <span>{t('planner.inbox.due', { date: due })}</span>}
        {names.length > 0 && <span>{names.join(', ')}</span>}
        {(item.links?.length ?? 0) > 0 && <span>{tn('planner.links.count', item.links!.length)}</span>}
        {item.status !== 'pending' && item.status !== 'local' && item.status !== 'ticket' && <span>{t(INBOX_STATUS_LABEL[item.status])}</span>}
      </div>
    </li>
  )
}

/** Kind, area and text filters of the Inbox and Tasks tabs. */
export function InboxFilterBar({ filters, onChange, areas }: { filters: InboxFilters; onChange: (f: InboxFilters) => void; areas: string[] }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('planner.inbox.filters')}>
      <div className="w-40 shrink-0"><Select value={filters.kind} aria-label={t('planner.inbox.kind')} onChange={(v) => onChange({ ...filters, kind: v as InboxFilters['kind'] })} options={[{ value: 'all', label: t('planner.inbox.allKinds') }, ...INBOX_KINDS.map((k) => ({ value: k, label: t(INBOX_KIND_LABEL[k]) }))]} /></div>
      <div className="w-40 shrink-0"><Select value={filters.area} aria-label={t('planner.inbox.area')} onChange={(v) => onChange({ ...filters, area: v })} options={[{ value: 'all', label: t('planner.inbox.allAreas') }, ...areas.map((a) => ({ value: a, label: a }))]} /></div>
      <Input value={filters.text} onChange={(e) => onChange({ ...filters, text: e.target.value })} placeholder={t('planner.inbox.search')} aria-label={t('planner.inbox.search')} className="w-56" />
      {hasFilters(filters) && (
        <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => onChange(NO_FILTERS)}>
          {t('planner.inbox.clearFilters')}
        </Button>
      )}
    </div>
  )
}

/**
 * Area, criticality or due date for the selected items at once. `selected` holds only rows still on
 * screen (see `selectedShown`); the form starts over whenever the selection empties.
 */
export function BulkBar({ profileId, items, selected, onDone, areas, criticalities }: { profileId: string; items: readonly InboxItem[]; selected: string[]; onDone: () => void; areas: string[]; criticalities: readonly CriticalityLevel[] }) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const [bulk, setBulk] = useState<BulkForm>(EMPTY_BULK_FORM)
  const titleId = useId()
  const patch = bulkFormToPatch(bulk)
  const changes = bulkChangeCount(items.filter((i) => selected.includes(i.id)), patch)
  const none = selected.length === 0
  useEffect(() => {
    if (none) setBulk(EMPTY_BULK_FORM)
  }, [none])
  const done = () => {
    setBulk(EMPTY_BULK_FORM)
    onDone()
  }
  const apply = async () => {
    if (changes === 0 || none) return
    const r = await window.hub.planner.bulkEdit(profileId, selected, patch)
    if (!r.ok) return toast(r.error, 'danger')
    done()
  }
  if (selected.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2.5" role="group" aria-labelledby={titleId} data-testid="inbox-bulk">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={titleId} className="text-sm font-semibold">
          {tn('planner.inbox.bulkTitle', selected.length)}
        </h2>
        <p className="flex-1 text-xs text-muted">{t('planner.inbox.bulkHint')}</p>
        <Button size="sm" variant="ghost" onClick={done}>
          {t('planner.inbox.clearSelection')}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('planner.inbox.area')} className="w-44 shrink-0">
          <Select value={bulk.area} onChange={(v) => setBulk((b) => ({ ...b, area: v }))} options={[{ value: BULK_KEEP, label: t('planner.inbox.bulkKeep') }, { value: BULK_CLEAR, label: t('planner.inbox.bulkClearArea') }, ...areas.map((a) => ({ value: a, label: a }))]} />
        </Field>
        <Field label={t('planner.inbox.criticality')} className="w-44 shrink-0">
          <Select value={bulk.criticality} onChange={(v) => setBulk((b) => ({ ...b, criticality: v }))} options={[{ value: BULK_KEEP, label: t('planner.inbox.bulkKeep') }, { value: BULK_CLEAR, label: t('planner.inbox.bulkClearCriticality') }, ...criticalities.map((c) => ({ value: c.name, label: c.name }))]} />
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
        <Button variant="primary" disabled={changes === 0} title={changes === 0 ? t('planner.inbox.bulkNothing') : undefined} onClick={() => void apply()}>
          {changes === 0 ? t('planner.inbox.apply') : tn('planner.inbox.applyTo', changes)}
        </Button>
      </div>
    </div>
  )
}

/**
 * What an inbox action does from a tab: runs it, says so when a ticket was made, and confirms a
 * discard, and the creation of a tracker issue, first. `dialog` holds those confirmations; `project`
 * is where the issue goes (Settings → Plan → Inbox), named in the question.
 */
export function useInboxActions(profileId: string, onActed: (id: string) => void, project = '') {
  const { t } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState<InboxItem | null>(null)
  const [creating, setCreating] = useState<InboxItem | null>(null)
  const act = async (item: InboxItem, action: InboxAction) => {
    setBusy(item.id)
    try {
      const r = await window.hub.planner.act(profileId, item.id, action)
      if (!r.ok) return toast(r.error, 'danger')
      if (r.ticket) toast(t('planner.inbox.ticketCreated', { key: r.ticket.key }))
      onActed(item.id)
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(null)
    }
  }
  const onAction = (item: InboxItem) => (a: InboxAction) => (a === 'discard' ? setDiscarding(item) : createsTicket(item, a) ? setCreating(item) : void act(item, a))
  const dialog = (
    <>
    <Dialog
      open={creating !== null}
      onOpenChange={(open) => !open && setCreating(null)}
      title={t('planner.inbox.confirmCreate', { title: creating?.title ?? '' })}
      description={project ? t('planner.inbox.confirmCreateBody', { project }) : t('planner.inbox.confirmCreateBodyNoProject')}
      footer={
        <>
          <Button variant="ghost" onClick={() => setCreating(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid="confirm-create-ticket"
            onClick={() => {
              const item = creating
              setCreating(null)
              if (item) void act(item, 'approve')
            }}
          >
            {t('planner.inbox.action.approve')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
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
    </>
  )
  return { busy, onAction, dialog }
}

/** Inbox: what came in and waits for you to say what it is and which milestone it is for. The work itself is on the Tasks tab. */
export function InboxTab({ profile, openSettings, openItem }: PlanTabContext) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const { view } = usePlanner(profile.id, true)
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS)
  const [adding, setAdding] = useState<InboxItemForm | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const { busy, onAction, dialog } = useInboxActions(profile.id, (id) => setSelected((s) => s.filter((x) => x !== id)), settings.project)
  const items = view?.inbox ?? []
  const milestones = view?.milestones ?? []
  const pending = useMemo(() => items.filter((i) => i.status === 'pending').sort((a, b) => b.createdAt - a.createdAt), [items])
  const shown = applyFilters(pending, filters)
  // Only what is still listed counts: a row a refresh removed never gets the bulk edit.
  const picked = selectedShown(selected, shown)
  // Another filter shows other rows: the selection (and its pending edit) starts over.
  useEffect(() => setSelected([]), [filters])
  const working = items.filter((i) => i.status === 'local' || i.status === 'ticket').length
  const canCreate = view?.tracker.create ?? false
  const areas = [...new Set([...settings.areas, ...items.map((i) => i.area).filter((a): a is string => Boolean(a))])]

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
  const select = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
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

      {pending.length > 0 && <InboxFilterBar filters={filters} onChange={setFilters} areas={areas} />}
      <BulkBar profileId={profile.id} items={items} selected={picked} onDone={() => setSelected([])} areas={areas} criticalities={settings.criticalities} />

      {!view ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner /> {t('plan.loading')}
        </p>
      ) : pending.length === 0 && !adding ? (
        <EmptyState compact icon={<Inbox className="size-5" aria-hidden />} title={t('planner.inbox.empty')} description={t('planner.inbox.emptyHint')} />
      ) : (
        <section className="flex flex-col gap-2" data-testid="inbox-pending">
          <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
            {t('planner.inbox.pending')} <span className="text-sm font-normal text-subtle">{shown.length}</span>
          </h2>
          {shown.length === 0 ? (
            <p className="px-1 text-sm text-muted">{t('planner.inbox.noMatch')}</p>
          ) : (
            <ul className="rounded-lg border border-border bg-surface shadow-sm">
              {shown.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  people={people}
                  selected={selected.includes(item.id)}
                  onSelect={(on) => select(item.id, on)}
                  busy={busy === item.id}
                  canCreate={canCreate}
                  onAction={onAction(item)}
                  profileId={profile.id}
                  onOpen={() => openItem('inbox', item.id)}
                  ticketState={view.itemTickets[item.id]}
                  milestones={<ItemMilestones item={item} milestones={milestones} profileId={profile.id} onOpen={(id) => openItem('milestone', id)} />}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {view && working > 0 && (
        <p className="px-1 text-sm text-muted">
          {tn('planner.inbox.workingHint', working)}{' '}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => requestPlanTab('tasks')}>
            {t('planner.inbox.openTasks')}
          </button>
        </p>
      )}

      {dialog}
    </div>
  )
}
