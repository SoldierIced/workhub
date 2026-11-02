import { CalendarDays, RotateCcw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { moduleScreens, type Profile } from '@workhub/core'
import type { BriefResult } from '@shared/plan-api'
import { Badge, Button, Spinner } from '../../components/atoms'
import { EmptyState, RefreshButton, Tabs, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'
import { CALENDAR_FAILURE_KEY, PLAN_STATE_COPY } from '../../lib/plan'
import { relativeTime } from '../../lib/pullRequests'
import { useNow } from '../../lib/usage'
import { usePlan } from '../../planStore'
import { usePlanner, usePlanTabRequests } from '../../plannerStore'
import { PLAN_TABS, type PlanTabContext } from './planTabs'

export interface PlanScreenProps {
  profile: Profile | undefined
  onOpenSession: (sessionId: string) => void
  onOpenSettings: (tab?: string) => void
}

/** Plan (⌘9): the active profile's agenda, its meeting briefs and the people it meets, one tab each (`PLAN_TABS`). */
export function PlanScreen({ profile, onOpenSession, onOpenSettings }: PlanScreenProps) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const enabled = Boolean(profile && moduleScreens(profile.modules).includes('planner'))
  const { view, loading, error, refresh } = usePlan(profile?.id, enabled)
  const now = useNow()
  const [tab, setTab] = useState(PLAN_TABS[0]!.id)
  const [busy, setBusy] = useState<string | null>(null)
  usePlanTabRequests(setTab)
  const { view: work, loading: workLoading, reload: reloadWork } = usePlanner(profile?.id, enabled)
  const pending = work?.inbox.filter((i) => i.status === 'pending').length ?? 0

  const run = async (key: string, call: () => Promise<BriefResult>) => {
    if (busy) return
    setBusy(key)
    try {
      const r = await call()
      if (!r.ok) return toast(t('plan.brief.failed', { message: r.error }), 'danger')
      if (!r.existing) toast(t('plan.brief.started'))
      onOpenSession(r.sessionId)
    } catch (e) {
      toast(t('plan.brief.failed', { message: errorText(e) }), 'danger')
    } finally {
      setBusy(null)
    }
  }

  const copy = enabled ? (view ? PLAN_STATE_COPY[view.state] : undefined) : PLAN_STATE_COPY.moduleOff
  const failing = (view?.calendars ?? []).filter((c) => !c.ok)
  const live = enabled && profile && view && (view.state === 'ready' || view.state === 'demo')
  // Milestones, the inbox and people work without a calendar; only the agenda needs one.
  const context: PlanTabContext | null =
    enabled && profile && view
    ? {
        profile,
        view,
        now,
        busy,
        brief: (eventId) => void run(`event:${eventId}`, () => window.hub.plan.brief(profile.id, eventId)),
        oneOnOne: (personId) => void run(`person:${personId}`, () => window.hub.plan.oneOnOne(profile.id, personId)),
        openLink: (url) => window.hub.openExternal(url, profile.id),
        openSettings: onOpenSettings,
        openItem: (kind, id) => window.hub.planner.openWindow({ profileId: profile.id, kind, id })
      }
    : null

  return (
    <div className="@container">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-7">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{profile?.name ? `${profile.name} · ${t('nav.plan')}` : t('nav.plan')}</h1>
            <p className="mt-0.5 max-w-2xl text-base text-muted">{t('plan.subtitle')}</p>
          </div>
          {view?.state === 'demo' && <Badge tone="info">{t('plan.demo')}</Badge>}
          {live && view.updatedAt !== undefined && <span className="mt-1.5 text-sm text-subtle">{t('plan.updated', { time: relativeTime(view.updatedAt, Date.now(), locale) })}</span>}
          {/* Always there: an agent may have added to the inbox or the milestones, which need no calendar. */}
          {context && <RefreshButton variant="button" label={t('plan.refresh')} loading={loading || workLoading} onRefresh={() => Promise.all([refresh(), reloadWork()])} />}
        </header>

        {error && (
          <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
            <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('plan.loadFailed', { message: error })}</p>
            <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
              {t('plan.retry')}
            </Button>
          </div>
        )}

        {enabled && !view && !error && (
          <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
            <Spinner /> {t('plan.loading')}
          </p>
        )}

        {!enabled && copy && (
          <EmptyState
            icon={<CalendarDays className="size-6" aria-hidden />}
            title={t(copy.title)}
            description={t(copy.hint)}
            action={
              <Button variant="primary" onClick={() => onOpenSettings('plan')}>
                {t('plan.openSettings')}
              </Button>
            }
          />
        )}

        {live && failing.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <ul className="min-w-0 flex-1">
              {failing.map((c) => (
                <li key={c.id}>{t('plan.calendarFailed', { name: c.name, reason: t(CALENDAR_FAILURE_KEY[c.failure ?? 'unreachable']) })}</li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" onClick={() => onOpenSettings('plan')}>
              {t('plan.openSettings')}
            </Button>
          </div>
        )}

        {context && (
          <Tabs
            label={t('nav.plan')}
            value={tab}
            onChange={setTab}
            items={PLAN_TABS.map((item) => ({
              value: item.id,
              label: item.id === 'inbox' && pending > 0 ? `${t(item.label)} (${pending})` : t(item.label),
              icon: <item.icon className="size-4" aria-hidden />,
              content: (
                <div className="pt-4">
                  {item.needsCalendar && !live && copy ? (
                    <EmptyState
                      icon={<CalendarDays className="size-6" aria-hidden />}
                      title={t(copy.title)}
                      description={t(copy.hint)}
                      action={
                        <Button variant="primary" onClick={() => onOpenSettings('plan')}>
                          {t('plan.openSettings')}
                        </Button>
                      }
                    />
                  ) : (
                    item.render(context)
                  )}
                </div>
              )
            }))}
          />
        )}
      </div>
    </div>
  )
}
