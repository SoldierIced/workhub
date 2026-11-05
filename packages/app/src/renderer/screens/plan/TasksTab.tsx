import { Flag, ListTodo } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { groupByMilestone, groupInbox, inboxSettings, milestoneHasItem, plannerSettings, type InboxItem } from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import { Badge, Spinner } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, selectedShown } from '../../lib/planner'
import { requestPlanTab, usePlanner } from '../../plannerStore'
import { ItemMilestones } from './ItemMilestones'
import { applyFilters, BulkBar, InboxFilterBar, InboxRow, NO_FILTERS, useInboxActions, type InboxFilters } from './InboxTab'
import { MilestoneBar } from './MilestonesTab'
import type { PlanTabContext } from './planTabs'

/** Open work in the order of the inbox's "My tasks": overdue or due today, then urgent, then the rest, then those the tracker decides on. */
function inWorkOrder(items: readonly InboxItem[], today: string, levels: Parameters<typeof groupInbox>[2]): InboxItem[] {
  const g = groupInbox(items, today, levels).tasks
  return [...g.due, ...g.urgent, ...g.rest, ...g.tracker]
}

/**
 * Tasks: the work you took on (local tasks and bugs, and those that follow a ticket), grouped by the
 * milestone they move forward, then the ones in no milestone; decisions and what closed this week
 * below. What still waits for review stays on the Inbox tab.
 */
export function TasksTab({ profile, openItem }: PlanTabContext) {
  const { t, tn, formatDate } = useI18n()
  const { view } = usePlanner(profile.id, true)
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS)
  const [selected, setSelected] = useState<string[]>([])
  const { busy, onAction, dialog } = useInboxActions(profile.id, (id) => setSelected((s) => s.filter((x) => x !== id)))
  const items = view?.inbox ?? []
  const milestones = view?.milestones ?? []
  const today = view?.today ?? ''
  const shown = useMemo(() => applyFilters(items, filters), [items, filters])
  // Only what is still listed counts: a row a refresh removed never gets the bulk edit.
  const picked = useMemo(() => selectedShown(selected, shown), [selected, shown])
  // Another filter shows other rows: the selection (and its pending edit) starts over.
  useEffect(() => setSelected([]), [filters])
  const all = groupInbox(shown, today, settings.criticalities)
  const open = [...all.tasks.due, ...all.tasks.urgent, ...all.tasks.rest, ...all.tasks.tracker]
  const byMilestone = groupByMilestone(open, milestones, (m) => m.milestone)
  const pendingOf = (m: MilestoneView) => items.filter((i) => i.status === 'pending' && milestoneHasItem(m.milestone, i)).length
  const canCreate = view?.tracker.create ?? false
  const areas = [...new Set([...settings.areas, ...items.map((i) => i.area).filter((a): a is string => Boolean(a))])]
  const select = (id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
  const day = (d: string) => formatDate(new Date(`${d}T00:00:00`), { day: 'numeric', month: 'short' })

  const row = (item: InboxItem, under?: string, actions = true) => (
    <InboxRow
      key={item.id}
      item={item}
      people={people}
      selected={selected.includes(item.id)}
      onSelect={item.status === 'local' ? (on) => select(item.id, on) : undefined}
      busy={busy === item.id}
      canCreate={canCreate}
      onAction={actions ? onAction(item) : undefined}
      profileId={profile.id}
      onOpen={() => openItem('inbox', item.id)}
      ticketState={view?.itemTickets[item.id]}
      milestones={item.kind === 'decision' ? undefined : <ItemMilestones item={item} milestones={milestones} profileId={profile.id} hide={under} onOpen={(id) => openItem('milestone', id)} />}
    />
  )

  const section = (title: string, list: InboxItem[], testId: string) =>
    list.length === 0 ? null : (
      <section className="flex flex-col gap-2" data-testid={testId}>
        <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
          {title} <span className="text-sm font-normal text-subtle">{list.length}</span>
        </h2>
        <ul className="rounded-lg border border-border bg-surface shadow-sm">{list.map((i) => row(i))}</ul>
      </section>
    )

  if (!view) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
        <Spinner /> {t('plan.loading')}
      </p>
    )
  }

  const nothing = open.length === 0 && all.decisions.length === 0 && all.closed.length === 0
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('planner.tasks.intro')}</p>
      {items.some((i) => i.status !== 'pending') && <InboxFilterBar filters={filters} onChange={setFilters} areas={areas} />}
      <BulkBar profileId={profile.id} items={items} selected={picked} onDone={() => setSelected([])} areas={areas} criticalities={settings.criticalities} />

      {nothing ? (
        <EmptyState compact icon={<ListTodo className="size-5" aria-hidden />} title={t('planner.tasks.empty')} description={t('planner.tasks.emptyHint')} />
      ) : (
        <>
          {byMilestone.groups.map(({ milestone: m, items: list }) => {
            const waiting = pendingOf(m)
            return (
              <section key={m.milestone.id} className="flex flex-col gap-2" data-testid="tasks-milestone">
                <div className="flex flex-col gap-1.5 px-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Flag className="size-4 shrink-0 text-subtle" aria-hidden />
                    <button type="button" className="min-w-0 break-words text-left text-md font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={t('planner.detail.open')} onClick={() => openItem('milestone', m.milestone.id)}>
                      {m.milestone.name}
                    </button>
                    <Badge tone={MILESTONE_STATUS_TONE[m.status]}>{t(MILESTONE_STATUS_LABEL[m.status])}</Badge>
                    <span className="text-sm text-subtle">{t('planner.tasks.milestoneFacts', { progress: m.progress, end: day(m.milestone.end), count: list.length })}</span>
                  </div>
                  <MilestoneBar row={m} label={t('planner.tasks.progressOf', { name: m.milestone.name })} />
                </div>
                <ul className="rounded-lg border border-border bg-surface shadow-sm">{inWorkOrder(list, today, settings.criticalities).map((i) => row(i, m.milestone.id))}</ul>
                {waiting > 0 && (
                  <button type="button" className="self-start px-1 text-sm text-accent hover:underline" onClick={() => requestPlanTab('inbox')}>
                    {tn('planner.tasks.waitingInInbox', waiting)}
                  </button>
                )}
              </section>
            )
          })}

          {byMilestone.loose.length > 0 && (
            <section className="flex flex-col gap-2" data-testid="tasks-loose">
              <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
                {byMilestone.groups.length > 0 ? t('planner.tasks.noMilestone') : t('planner.inbox.tasks')} <span className="text-sm font-normal text-subtle">{byMilestone.loose.length}</span>
              </h2>
              {byMilestone.groups.length > 0 && <p className="px-1 text-xs text-subtle">{t('planner.tasks.noMilestoneHint')}</p>}
              <ul className="rounded-lg border border-border bg-surface shadow-sm">{byMilestone.loose.map((i) => row(i))}</ul>
            </section>
          )}

          {section(t('planner.inbox.decisions'), all.decisions, 'tasks-decisions')}
          {section(t('planner.inbox.closed'), all.closed, 'tasks-closed')}
        </>
      )}
      {dialog}
    </div>
  )
}
