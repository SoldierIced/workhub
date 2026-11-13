import { Check, ChevronRight, Plus, RefreshCw, Users, Video } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { agendaDays, groupInbox, startOfLocalDayAt, type CalendarEvent, type InboxAction, type InboxItem, type MilestoneProposal } from '@workhub/core'
import type { PlanBrief, PlanView } from '../../shared/plan-api'
import type { MilestoneView, PlannerView } from '../../shared/planner-api'
import { Badge, Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { briefLabel, eventTimes, isOngoing, PLAN_STATE_COPY } from '../../renderer/lib/plan'
import { createsTicket, INBOX_KIND_LABEL, inboxActionLabel, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, plainPreview } from '../../renderer/lib/planner'
import { navigate, useClientStatus, useConfig, useProfileId } from '../app-context'
import { openLink, profileOf, useCriticalities, usePlan, usePlanner } from '../plan-data'
import { PLAN_TABS, type PlanTab } from '../routes'
import { Body, Empty, Header, InlineConfirm, Screen, SectionTitle } from '../ui'
import { ProfilePicker } from './ProfilePicker'

const TAB_LABEL = { today: 'plan.tab.today', inbox: 'planner.tab.inbox', tasks: 'planner.tab.tasks', milestones: 'planner.tab.milestones' } as const

/** Plan on the phone: today's meetings, the inbox waiting for a decision, the tasks taken on, and the milestones. */
export function PlanScreen({ tab }: { tab: PlanTab }) {
  const { t } = useI18n()
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  const planner = usePlanner(profileId)
  const view = planner.data
  const pending = view?.inbox.filter((i) => i.status === 'pending').length ?? 0
  const waiting = pending + (view?.proposals.length ?? 0)
  return (
    <Screen>
      <Header
        title={t('web.plan.title')}
        right={
          <div className="flex items-center gap-1">
            <ProfilePicker config={config} value={profileId} onChange={setProfileId} />
            {tab !== 'today' && tab !== 'milestones' && (
              <button type="button" aria-label={t('planner.inbox.add')} onClick={() => navigate({ screen: 'newItem' })} className="flex size-10 items-center justify-center rounded-lg text-accent active:bg-surface-hover">
                <Plus className="size-6" aria-hidden />
              </button>
            )}
          </div>
        }
      />
      <div role="tablist" className="flex shrink-0 gap-1 border-b border-border bg-sidebar px-2 pb-2">
        {PLAN_TABS.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={id === tab} onClick={() => navigate({ screen: 'plan', tab: id }, true)} className={cn('flex h-9 flex-1 items-center justify-center gap-1 rounded-lg text-sm font-medium', id === tab ? 'bg-accent-soft text-accent' : 'text-muted active:bg-surface-hover')}>
            {t(TAB_LABEL[id])}
            {id === 'inbox' && waiting > 0 && <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-accent-fg">{waiting}</span>}
          </button>
        ))}
      </div>
      <Body>
        {tab === 'today' ? (
          <TodayTab profileId={profileId} />
        ) : !view && planner.loading ? (
          <Spinner className="mx-auto mt-16 size-6" />
        ) : planner.error && !view ? (
          <p className="px-4 pt-4 text-sm text-danger">{planner.error}</p>
        ) : view && !view.enabled ? (
          <Empty title={t('web.plan.disabled')} />
        ) : view && profileId ? (
          tab === 'inbox' ? (
            <InboxTab profileId={profileId} view={view} reload={planner.reload} />
          ) : tab === 'tasks' ? (
            <TasksTab profileId={profileId} view={view} reload={planner.reload} />
          ) : (
            <MilestonesTab profileId={profileId} view={view} reload={planner.reload} />
          )
        ) : null}
      </Body>
    </Screen>
  )
}

// ---- Today -------------------------------------------------------------------------------------

function TodayTab({ profileId }: { profileId: string | null }) {
  const { t, formatDate } = useI18n()
  const status = useClientStatus()
  const plan = usePlan(profileId)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const view = plan.data
  const now = Date.now()
  if (!view) return plan.loading ? <Spinner className="mx-auto mt-16 size-6" /> : plan.error ? <p className="px-4 pt-4 text-sm text-danger">{plan.error}</p> : null
  const copy = PLAN_STATE_COPY[view.state]
  if (copy) return <Empty title={t(copy.title)} hint={t(copy.hint)} />
  const { today, tomorrow } = agendaDays(view.events, now)
  const canOpenSession = status.desktop?.capabilities.includes('sessions') ?? false

  const brief = async (event: CalendarEvent) => {
    if (!profileId) return
    setBusy(event.id)
    setError(null)
    try {
      const r = await window.hub.plan.brief(profileId, event.id)
      if (!r.ok) setError(r.error)
      else if (canOpenSession) navigate({ screen: 'session', id: r.sessionId })
      plan.reload()
    } finally {
      setBusy(null)
    }
  }
  const day = (label: string, dayStart: number, events: CalendarEvent[]) => (
    <section aria-label={label}>
      <SectionTitle right={formatDate(dayStart, { weekday: 'long', day: 'numeric', month: 'long' })}>{label}</SectionTitle>
      {events.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">{t('plan.noMeetings')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((e) => (
            <EventRow key={e.id} event={e} brief={view.briefs[e.id]} now={now} busy={busy === e.id} canOpenSession={canOpenSession} onBrief={() => void brief(e)} />
          ))}
        </ul>
      )}
    </section>
  )
  return (
    <div className="pb-6">
      {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
      {day(t('plan.today'), startOfLocalDayAt(now), today)}
      {day(t('plan.tomorrow'), startOfLocalDayAt(now, 1), tomorrow)}
    </div>
  )
}

function EventRow({ event, brief, now, busy, canOpenSession, onBrief }: { event: CalendarEvent; brief: PlanBrief | undefined; now: number; busy: boolean; canOpenSession: boolean; onBrief: () => void }) {
  const { t, tn, formatDate } = useI18n()
  const past = !event.allDay && event.end <= now
  const times = eventTimes(event, (ms) => formatDate(ms, { hour: '2-digit', minute: '2-digit' }))
  const ready = brief?.phase === 'ready' || brief?.phase === 'closed'
  return (
    <li className={cn('flex flex-col gap-2 px-4 py-3', past && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <div className="w-14 shrink-0 text-xs text-muted">
          {event.allDay ? t('plan.allDay') : times}
          {isOngoing(event, now) && <div className="font-semibold text-accent">{t('plan.now')}</div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-md font-medium">{event.title || t('plan.untitled')}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            {event.attendees.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" aria-hidden />
                {tn('plan.attendees', event.attendees.length)}
              </span>
            )}
            {event.location && <span className="truncate">{event.location}</span>}
          </div>
        </div>
      </div>
      {!past && (
        <div className="flex flex-wrap gap-2 pl-[4.25rem]">
          {event.meetingUrl && (
            <button type="button" onClick={() => openLink(event.meetingUrl!)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg">
              <Video className="size-4" aria-hidden />
              {t('plan.join')}
            </button>
          )}
          <button
            type="button"
            disabled={busy || brief?.phase === 'preparing' || (ready && !canOpenSession)}
            onClick={() => (ready && brief?.sessionId ? navigate({ screen: 'session', id: brief.sessionId }) : onBrief())}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm disabled:opacity-50"
          >
            {busy || brief?.phase === 'preparing' ? <Spinner className="size-3.5" /> : null}
            {ready ? t('web.plan.openBrief') : t(briefLabel(brief))}
          </button>
        </div>
      )}
    </li>
  )
}

// ---- Shared item rows ----------------------------------------------------------------------------

/** What `act` may do to an item in its state; `approve` of a task or bug needs a tracker that creates issues. */
export function itemActions(item: InboxItem, canCreate: boolean): InboxAction[] {
  if (item.status === 'pending') return [...(canCreate || item.kind === 'decision' ? (['approve'] as const) : []), 'keep', 'discard']
  if (item.status === 'local') return item.kind === 'decision' ? ['discard'] : ['done', 'discard']
  if (item.status === 'ticket') return []
  return ['reopen']
}

export function useItemActions(profileId: string, reload: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = async (item: InboxItem, action: InboxAction) => {
    setBusy(item.id)
    setError(null)
    try {
      const r = await window.hub.planner.act(profileId, item.id, action)
      if (!r.ok) setError(r.error)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, act }
}

export function KindBadge({ item }: { item: InboxItem }) {
  const { t } = useI18n()
  return <Badge tone={item.kind === 'bug' ? 'danger' : item.kind === 'decision' ? 'info' : 'neutral'}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
}

function ItemRow({ item, today, right }: { item: InboxItem; today: string; right?: ReactNode }) {
  const { t } = useI18n()
  const overdue = item.due && item.due < today && item.status !== 'done' && item.status !== 'discarded'
  const preview = plainPreview(item.detail)
  return (
    <li className="flex items-center gap-2 px-4 py-3">
      <button type="button" onClick={() => navigate({ screen: 'planItem', id: item.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <KindBadge item={item} />
            <span className="truncate text-md font-medium">{item.title}</span>
          </div>
          {preview && <div className="mt-0.5 line-clamp-1 text-xs text-muted">{preview}</div>}
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
            {item.due && (
              <span className={cn(overdue && 'font-semibold text-danger')}>
                {t('planner.inbox.dueLabel')}: {item.due}
              </span>
            )}
            {item.criticality && <span>{item.criticality}</span>}
            {item.area && <span>{item.area}</span>}
            {item.ticket && <span className="font-mono">{item.ticket.key}</span>}
          </div>
        </div>
        {!right && <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden />}
      </button>
      {right}
    </li>
  )
}

function QuickAction({ label, busy, primary, onClick }: { label: string; busy: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={onClick} className={cn('inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-3 text-sm disabled:opacity-50', primary ? 'bg-accent font-medium text-accent-fg' : 'border border-border-strong')}>
      {busy ? <Spinner className="size-3.5" /> : primary ? <Check className="size-4" aria-hidden /> : null}
      {label}
    </button>
  )
}

// ---- Inbox ---------------------------------------------------------------------------------------

function InboxTab({ profileId, view, reload }: { profileId: string; view: PlannerView; reload: () => void }) {
  const { t } = useI18n()
  const { config } = useConfig()
  const levels = useCriticalities(profileOf(config, profileId))
  const groups = groupInbox(view.inbox, view.today, levels)
  const { busy, error, act } = useItemActions(profileId, reload)
  // Discarding an item and creating a tracker issue are asked first.
  const [confirming, setConfirming] = useState<{ item: InboxItem; action: 'discard' | 'approve' } | null>(null)
  const empty = groups.pending.length === 0 && view.proposals.length === 0
  return (
    <div className="pb-6">
      {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
      {view.proposals.length > 0 && (
        <>
          <SectionTitle>{t('planner.proposals.title')}</SectionTitle>
          <ul className="divide-y divide-border">
            {view.proposals.map((p) => (
              <ProposalRow key={p.id} profileId={profileId} proposal={p} reload={reload} />
            ))}
          </ul>
        </>
      )}
      {empty ? (
        <Empty title={t('planner.inbox.pendingEmpty')} hint={t('web.plan.inboxHint')} />
      ) : (
        <>
          <SectionTitle>{t('planner.inbox.pending')}</SectionTitle>
          <ul className="divide-y divide-border">
            {groups.pending.map((item) => (
              <li key={item.id} className="flex flex-col">
                <ItemRow item={item} today={view.today} right={<span />} />
                {confirming?.item.id === item.id ? (
                  <div className="px-4 pb-3">
                    {confirming.action === 'discard' ? (
                      <InlineConfirm question={t('planner.inbox.confirmDiscard', { title: item.title })} yes={t('planner.inbox.action.discard')} danger onNo={() => setConfirming(null)} onYes={() => (setConfirming(null), void act(item, 'discard'))} />
                    ) : (
                      <InlineConfirm question={t('planner.inbox.confirmCreate', { title: item.title })} yes={t('planner.inbox.action.approve')} onNo={() => setConfirming(null)} onYes={() => (setConfirming(null), void act(item, 'approve'))} />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 px-4 pb-3">
                    {itemActions(item, view.tracker.create).map((action) => (
                      <QuickAction key={action} label={t(inboxActionLabel(action, item.kind))} busy={busy === item.id} primary={action === 'approve'} onClick={() => (action === 'discard' || createsTicket(item, action) ? setConfirming({ item, action: action === 'discard' ? 'discard' : 'approve' }) : void act(item, action))} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ProposalRow({ profileId, proposal, reload }: { profileId: string; proposal: MilestoneProposal; reload: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const resolve = async (accept: boolean) => {
    setBusy(true)
    try {
      await window.hub.planner.resolveProposal(profileId, proposal.id, accept)
      reload()
    } finally {
      setBusy(false)
    }
  }
  const name = proposal.milestone?.name ?? proposal.before?.name ?? proposal.milestoneId
  const label = proposal.action === 'create' ? 'planner.proposal.create' : proposal.action === 'update' ? 'planner.proposal.update' : 'planner.proposal.delete'
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="text-md font-medium">{t(label, { name })}</div>
      {proposal.source.label && <div className="text-xs text-muted">{proposal.source.label}</div>}
      <div className="flex gap-2">
        <QuickAction label={t('planner.proposals.apply')} busy={busy} primary onClick={() => void resolve(true)} />
        <QuickAction label={t('planner.proposals.reject')} busy={busy} onClick={() => void resolve(false)} />
      </div>
    </li>
  )
}

// ---- Tasks ---------------------------------------------------------------------------------------

function TasksTab({ profileId, view, reload }: { profileId: string; view: PlannerView; reload: () => void }) {
  const { t, tn } = useI18n()
  const { config } = useConfig()
  const levels = useCriticalities(profileOf(config, profileId))
  const groups = groupInbox(view.inbox, view.today, levels)
  const { busy, error, act } = useItemActions(profileId, reload)
  const open = groups.tasks.due.length + groups.tasks.urgent.length + groups.tasks.rest.length + groups.tasks.tracker.length
  const section = (title: string, items: InboxItem[], action?: InboxAction) =>
    items.length > 0 && (
      <>
        <SectionTitle>{title}</SectionTitle>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} today={view.today} right={action ? <QuickAction label={t(inboxActionLabel(action, item.kind))} busy={busy === item.id} primary={action === 'done'} onClick={() => void act(item, action)} /> : undefined} />
          ))}
        </ul>
      </>
    )
  return (
    <div className="pb-6">
      {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
      {open === 0 && <Empty title={t('planner.tasks.empty')} hint={t('planner.tasks.emptyHint')} />}
      {groups.pending.length > 0 && (
        <button type="button" onClick={() => navigate({ screen: 'plan', tab: 'inbox' }, true)} className="mx-4 mt-3 w-[calc(100%-2rem)] rounded-lg bg-accent-soft px-3 py-2 text-left text-sm text-accent">
          {tn('web.plan.waitingInInbox', groups.pending.length)}
        </button>
      )}
      {section(t('planner.inbox.tasks.due'), groups.tasks.due, 'done')}
      {section(t('planner.inbox.tasks.urgent'), groups.tasks.urgent, 'done')}
      {section(t('planner.inbox.tasks.rest'), groups.tasks.rest, 'done')}
      {section(t('planner.inbox.tasks.tracker'), groups.tasks.tracker)}
      {section(t('planner.inbox.decisions'), groups.decisions)}
      {section(t('planner.inbox.closed'), groups.closed, 'reopen')}
    </div>
  )
}

// ---- Milestones ----------------------------------------------------------------------------------

export function ProgressBar({ name, progress, elapsed, status }: { name: string; progress: number; elapsed: number; status: MilestoneView['status'] }) {
  const { t } = useI18n()
  const tone = status === 'late' ? 'bg-danger' : status === 'atRisk' ? 'bg-warning' : status === 'done' ? 'bg-info' : 'bg-success'
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={t('planner.milestone.barLabel', { name, progress, elapsed })}>
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${progress}%` }} />
      <div className="absolute top-0 h-full w-px bg-text/60" style={{ left: `${elapsed}%` }} aria-hidden />
    </div>
  )
}

function MilestonesTab({ profileId, view, reload }: { profileId: string; view: PlannerView; reload: () => void }) {
  const { t } = useI18n()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    setRefreshing(true)
    try {
      await window.hub.planner.refreshMilestones(profileId)
      reload()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <div className="pb-6">
      <SectionTitle
        right={
          <button type="button" disabled={refreshing} onClick={() => void refresh()} className="inline-flex items-center gap-1 text-xs text-accent disabled:opacity-50">
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} aria-hidden />
            {t('planner.milestones.refresh')}
          </button>
        }
      >
        {t('planner.tab.milestones')}
      </SectionTitle>
      {view.milestones.length === 0 ? (
        <Empty title={t('planner.milestones.empty')} hint={t('planner.milestones.emptyHint')} />
      ) : (
        <ul className="divide-y divide-border">
          {view.milestones.map((m) => (
            <li key={m.milestone.id}>
              <button type="button" onClick={() => navigate({ screen: 'milestone', id: m.milestone.id })} className="flex w-full flex-col gap-2 px-4 py-3 text-left active:bg-surface-hover">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-md font-medium">{m.milestone.name}</span>
                  <Badge tone={MILESTONE_STATUS_TONE[m.status]}>{t(MILESTONE_STATUS_LABEL[m.status])}</Badge>
                </div>
                <ProgressBar name={m.milestone.name} progress={m.progress} elapsed={m.elapsed} status={m.status} />
                <div className="flex justify-between text-xs text-muted">
                  <span>{t('planner.milestone.progressOf', { progress: m.progress, elapsed: m.elapsed })}</span>
                  <span>
                    {m.milestone.start} → {m.milestone.end}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
