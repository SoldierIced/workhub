import { ExternalLink, Inbox, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { availableInboxActions, filterInbox, groupInbox, inboxSettings, INBOX_KINDS, INBOX_STATUSES, plannerSettings, type InboxAction, type InboxItem, type InboxKind, type Person } from '@workhub/core'
import { Badge, Button, Input, Select, Spinner, Textarea } from '../../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { EMPTY_ITEM_FORM, formToProposal, inboxActionLabel, INBOX_KIND_LABEL, INBOX_SOURCE_LABEL, INBOX_STATUS_LABEL, type InboxItemForm } from '../../lib/planner'
import { usePlanner } from '../../plannerStore'
import type { PlanTabContext } from './planTabs'

type Filters = { kind: InboxKind | 'all'; area: string; status: InboxItem['status'] | 'all'; text: string }
const NO_FILTERS: Filters = { kind: 'all', area: 'all', status: 'all', text: '' }

/** Toggle chips for the people an item involves. */
function PeoplePicker({ people, value, onChange }: { people: Person[]; value: string[]; onChange: (ids: string[]) => void }) {
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
export function InboxRow({ item, people, selected, onSelect, busy, canCreate, onAction, profileId }: { item: InboxItem; people: Person[]; selected?: boolean; onSelect?: (on: boolean) => void; busy: boolean; canCreate: boolean; onAction?: (action: InboxAction) => void; profileId: string }) {
  const { t, formatDate } = useI18n()
  const names = (item.people ?? []).map((id) => people.find((p) => p.id === id)?.name).filter(Boolean)
  const due = item.due ? formatDate(new Date(`${item.due}T00:00:00`), { day: 'numeric', month: 'short' }) : null
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0" data-testid="inbox-item">
      {onSelect && <input type="checkbox" className="mt-1 size-4 accent-[var(--color-accent)]" checked={selected ?? false} onChange={(e) => onSelect(e.target.checked)} aria-label={t('planner.inbox.select', { title: item.title })} />}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={item.kind === 'bug' ? 'danger' : item.kind === 'decision' ? 'info' : 'neutral'}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
          <span className="min-w-0 break-words font-semibold">{item.title}</span>
        </p>
        {item.detail && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm text-muted">{item.detail}</p>}
        <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-subtle">
          <span>{item.source.label ? `${t(INBOX_SOURCE_LABEL[item.source.type])}: ${item.source.label}` : t(INBOX_SOURCE_LABEL[item.source.type])}</span>
          {item.area && <span>{item.area}</span>}
          {item.criticality && <span className="font-medium text-text">{item.criticality}</span>}
          {due && <span>{t('planner.inbox.due', { date: due })}</span>}
          {names.length > 0 && <span>{names.join(', ')}</span>}
          {item.status !== 'pending' && item.status !== 'local' && <span>{t(INBOX_STATUS_LABEL[item.status])}</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {item.link && <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} aria-label={t('planner.inbox.openLink')} title={t('planner.inbox.openLink')} onClick={() => window.hub.openExternal(item.link!, profileId)} />}
        {item.ticket && (
          <Button size="sm" variant="ghost" onClick={() => item.ticket?.url && window.hub.openExternal(item.ticket.url, profileId)} disabled={!item.ticket.url}>
            {item.ticket.key}
          </Button>
        )}
        {onAction &&
          availableInboxActions(item).map((action) => {
            const needsTracker = action === 'approve' && item.kind !== 'decision'
            return (
              <Button key={action} size="sm" variant={action === 'approve' ? 'primary' : 'ghost'} disabled={busy || (needsTracker && !canCreate)} title={needsTracker && !canCreate ? t('planner.inbox.noCreate') : undefined} onClick={() => onAction(action)}>
                {busy && action === 'approve' ? <Spinner /> : t(inboxActionLabel(action, item.kind))}
              </Button>
            )
          })}
      </div>
    </li>
  )
}

/** Inbox: pending approval, my local tasks, decisions and what closed lately; filters and bulk edit. */
export function InboxTab({ profile, openSettings }: PlanTabContext) {
  const { t } = useI18n()
  const toast = useToast()
  const { view } = usePlanner(profile.id, true)
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [adding, setAdding] = useState<InboxItemForm | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [bulk, setBulk] = useState<{ area: string; criticality: string; due: string }>({ area: '', criticality: '', due: '' })
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
  const applyBulk = async () => {
    const patch = { ...(bulk.area ? { area: bulk.area === '-' ? null : bulk.area } : {}), ...(bulk.criticality ? { criticality: bulk.criticality === '-' ? null : bulk.criticality } : {}), ...(bulk.due ? { due: bulk.due } : {}) }
    const r = await window.hub.planner.bulkEdit(profile.id, selected, patch)
    if (!r.ok) return toast(r.error, 'danger')
    setSelected([])
    setBulk({ area: '', criticality: '', due: '' })
  }
  const select = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  const row = (item: InboxItem, actions = true) => <InboxRow key={item.id} item={item} people={people} selected={selected.includes(item.id)} onSelect={item.status === 'pending' || item.status === 'local' ? (on) => select(item.id, on) : undefined} busy={busy === item.id} canCreate={canCreate} onAction={actions ? (a) => void act(item, a) : undefined} profileId={profile.id} />
  const section = (title: string, list: InboxItem[], empty?: string, testId?: string) =>
    list.length === 0 && !empty ? null : (
      <section className="flex flex-col gap-2" data-testid={testId}>
        <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
          {title} <span className="text-sm font-normal text-subtle">{list.length}</span>
        </h2>
        {list.length === 0 ? <p className="px-1 text-sm text-muted">{empty}</p> : <ul className="rounded-lg border border-border bg-surface shadow-sm">{list.map((i) => row(i))}</ul>}
      </section>
    )
  const tasks = groups.tasks.due.length + groups.tasks.urgent.length + groups.tasks.rest.length
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
            <Field label={t('planner.inbox.detail')} className="col-span-2">
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
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2" role="group" aria-label={t('planner.inbox.bulk')}>
          <span className="text-sm font-medium">{t('planner.inbox.selected', { count: selected.length })}</span>
          <div className="w-40 shrink-0"><Select value={bulk.area} aria-label={t('planner.inbox.area')} placeholder={t('planner.inbox.area')} onChange={(v) => setBulk((b) => ({ ...b, area: v }))} options={[{ value: '-', label: t('planner.inbox.clear') }, ...areas.map((a) => ({ value: a, label: a }))]} /></div>
          <div className="w-40 shrink-0"><Select value={bulk.criticality} aria-label={t('planner.inbox.criticality')} placeholder={t('planner.inbox.criticality')} onChange={(v) => setBulk((b) => ({ ...b, criticality: v }))} options={[{ value: '-', label: t('planner.inbox.clear') }, ...settings.criticalities.map((c) => ({ value: c.name, label: c.name }))]} /></div>
          <Input type="date" value={bulk.due} aria-label={t('planner.inbox.dueLabel')} onChange={(e) => setBulk((b) => ({ ...b, due: e.target.value }))} className="w-40" />
          <Button size="sm" variant="primary" disabled={!bulk.area && !bulk.criticality && !bulk.due} onClick={() => void applyBulk()}>
            {t('planner.inbox.apply')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            {t('planner.inbox.clearSelection')}
          </Button>
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
                ['planner.inbox.tasks.rest', groups.tasks.rest]
              ] as const
            ).map(([label, list]) =>
              list.length === 0 ? null : (
                <div key={label} className="flex flex-col gap-1">
                  <h3 className="px-1 text-sm font-medium text-muted">{t(label)}</h3>
                  <ul className="rounded-lg border border-border bg-surface shadow-sm">{list.map((i) => row(i))}</ul>
                </div>
              )
            )}
          </section>
          {section(t('planner.inbox.decisions'), groups.decisions, t('planner.inbox.decisionsEmpty'), 'inbox-decisions')}
          {section(t('planner.inbox.closed'), groups.closed)}
        </>
      )}
    </div>
  )
}
