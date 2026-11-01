import { FileText, Users, Video } from 'lucide-react'
import type { CalendarEvent } from '@workhub/core'
import type { PlanBrief } from '@shared/plan-api'
import { Badge, Button, Spinner } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { briefLabel, eventTimes, isOngoing } from '../../lib/plan'

export interface EventRowProps {
  event: CalendarEvent
  brief?: PlanBrief
  now: number
  /** The brief of this event is being started or opened. */
  busy?: boolean
  onBrief?: () => void
  onJoin?: (url: string) => void
  /** Shows the day too (lists that span several days). */
  withDay?: boolean
}

/** One meeting: its time, title, attendees and place, a call link and its brief. */
export function EventRow({ event, brief, now, busy, onBrief, onJoin, withDay }: EventRowProps) {
  const { t, tn, formatDate } = useI18n()
  const time = (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' })
  const times = eventTimes(event, time)
  const ongoing = isOngoing(event, now)
  const past = !event.allDay && event.end <= now
  const ready = brief?.phase === 'ready'
  return (
    <li className={cn('flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2', ongoing && 'border-accent/50 bg-accent-soft/40', past && 'opacity-60')} data-testid="plan-event">
      <div className="w-32 shrink-0 text-sm tabular-nums text-muted">
        {withDay && <span className="block text-xs text-subtle first-letter:uppercase">{formatDate(event.start, { weekday: 'short', day: 'numeric', month: 'short' })}</span>}
        {times ?? t('plan.allDay')}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate font-medium">
          <span className="truncate">{event.title || t('plan.untitled')}</span>
          {ongoing && <Badge tone="accent">{t('plan.now')}</Badge>}
          {event.recurring && <span className="shrink-0 text-xs text-subtle">{t('plan.recurring')}</span>}
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted">
          {event.attendees.length > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1" title={event.attendees.map((a) => a.name ?? a.email).join(', ')}>
              <Users className="size-3" aria-hidden />
              {tn('plan.attendees', event.attendees.length)}
            </span>
          )}
          {event.location && <span className="truncate">· {event.location}</span>}
        </p>
      </div>
      {event.meetingUrl && onJoin && !past && (
        <Button size="sm" variant="ghost" icon={<Video className="size-3.5" aria-hidden />} onClick={() => onJoin(event.meetingUrl!)}>
          {t('plan.join')}
        </Button>
      )}
      {onBrief && !event.allDay && (
        <Button
          size="sm"
          variant={ready ? 'primary' : 'secondary'}
          icon={busy || brief?.phase === 'preparing' ? <Spinner /> : <FileText className="size-3.5" aria-hidden />}
          disabled={busy}
          title={brief?.error}
          onClick={onBrief}
        >
          {t(briefLabel(brief))}
        </Button>
      )}
    </li>
  )
}
