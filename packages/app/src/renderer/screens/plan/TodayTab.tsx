import { agendaDays, startOfLocalDayAt, type CalendarEvent } from '@workhub/core'
import { EmptyState } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { EventRow } from './EventRow'
import type { PlanTabContext } from './planTabs'

/** Today and tomorrow: every meeting with its time, attendees, call link and brief. */
export function TodayTab({ view, now, busy, brief, openLink }: PlanTabContext) {
  const { t, formatDate } = useI18n()
  const { today, tomorrow } = agendaDays(view.events, now)
  const day = (label: string, dayStart: number, events: CalendarEvent[]) => (
    <section className="flex flex-col gap-2" aria-label={label}>
      <h2 className="flex items-baseline gap-2 px-1 text-md font-semibold">
        {label}
        <span className="text-sm font-normal text-muted first-letter:uppercase">{formatDate(dayStart, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </h2>
      {events.length === 0 ? (
        <EmptyState compact title={t('plan.noMeetings')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((e) => (
            <EventRow key={e.id} event={e} brief={view.briefs[e.id]} now={now} busy={busy === `event:${e.id}`} onBrief={() => brief(e.id)} onJoin={openLink} />
          ))}
        </ul>
      )}
    </section>
  )
  return (
    <div className="flex flex-col gap-6">
      {day(t('plan.today'), startOfLocalDayAt(now), today)}
      {day(t('plan.tomorrow'), startOfLocalDayAt(now, 1), tomorrow)}
    </div>
  )
}
