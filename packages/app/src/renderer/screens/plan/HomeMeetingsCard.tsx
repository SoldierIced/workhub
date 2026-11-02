import { ArrowRight, Video } from 'lucide-react'
import { nextMeetings, type Profile } from '@workhub/core'
import { Button } from '../../components/atoms'
import { HOME_INSET_ROW, HomeCard, HomeNote } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { CALENDAR_FAILURE_KEY, eventTimes, isOngoing } from '../../lib/plan'
import { useNow } from '../../lib/usage'
import { usePlan } from '../../planStore'

/** Home's "Next meetings": the next three meetings of today, with their call link. Shown while Plan is on. */
export function HomeMeetingsCard({ profile, onOpenPlan, onOpenSettings }: { profile: Profile | undefined; onOpenPlan: () => void; onOpenSettings: (tab?: string) => void }) {
  const { t, tn, formatDate } = useI18n()
  const { view } = usePlan(profile?.id, Boolean(profile))
  const now = useNow()
  const live = view?.state === 'ready' || view?.state === 'demo'
  const next = live ? nextMeetings(view.events, now, 3) : []
  const time = (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' })
  return (
    <HomeCard
      title={t('plan.home.title')}
      detail={live && next.length ? tn('plan.home.count', nextMeetings(view.events, now, 50).length) : undefined}
      trailing={
        <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpenPlan}>
          {t('plan.home.open')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      }
      data-testid="home-meetings"
    >
      {!view ? (
        <HomeNote text={t('plan.loading')} />
      ) : view.state === 'noConnection' || view.state === 'moduleOff' ? (
        <HomeNote text={t('plan.home.noCalendar')} actionLabel={t('plan.openSettings')} onAction={() => onOpenSettings('plan')} />
      ) : view.state === 'error' ? (
        <HomeNote text={t(CALENDAR_FAILURE_KEY[view.calendars[0]?.failure ?? 'unreachable'])} actionLabel={t('plan.openSettings')} onAction={() => onOpenSettings('plan')} />
      ) : next.length === 0 ? (
        <HomeNote text={t('plan.home.none')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {next.map((e) => (
            <li key={e.id} className={`${HOME_INSET_ROW} flex items-center gap-2`}>
              <span className="w-28 shrink-0 text-sm tabular-nums text-muted">{isOngoing(e, now) ? t('plan.now') : eventTimes(e, time)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{e.title || t('plan.untitled')}</span>
                {e.attendees.length > 0 && <span className="block truncate text-xs text-muted">{tn('plan.attendees', e.attendees.length)}</span>}
              </span>
              {e.meetingUrl && (
                <Button size="sm" variant="ghost" icon={<Video className="size-3.5" aria-hidden />} onClick={() => window.hub.openExternal(e.meetingUrl!, profile?.id ?? null)}>
                  {t('plan.join')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </HomeCard>
  )
}
