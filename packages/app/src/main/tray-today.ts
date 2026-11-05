import { localDay, nextMeetings, type CalendarEvent, type InboxItem, type TrayCalendarEvent, type TrayPlanItem } from '@workhub/core'
import type { CalendarRead } from './calendar-service'

/** The most meetings the popover may list (Settings offers 1 to 3). */
export const TRAY_CALENDAR_LIMIT = 3
/** The most Plan tasks handed to the popover (it lists two). */
export const TRAY_PLAN_LIMIT = 5
/** A slow calendar read does not hold the menu bar back: the last answer is used meanwhile. */
const READ_TIMEOUT_MS = 2_500

/** Today's timed meetings that have not ended, soonest first, as the popover lists them. */
export function trayCalendar(events: readonly CalendarEvent[], now: number, limit = TRAY_CALENDAR_LIMIT): TrayCalendarEvent[] {
  return nextMeetings(events, now, limit).map((e) => {
    const out: TrayCalendarEvent = { id: e.id, title: e.title, startsAt: e.start, endsAt: e.end }
    if (e.location?.trim()) out.location = e.location.trim()
    if (e.meetingUrl) out.joinUrl = e.meetingUrl
    return out
  })
}

/** Inbox tasks due today or before (already filtered and sorted by `inboxDueBy`), flagged when overdue. */
export function trayPlanItems(items: readonly InboxItem[], today: string, limit = TRAY_PLAN_LIMIT): TrayPlanItem[] {
  return items.slice(0, limit).map((i) => ({ id: i.id, title: i.title, ...(i.due && i.due < today ? { overdue: true } : {}) }))
}

export interface TrayTodayDeps {
  /** The profile's calendars, read when due (CalendarService). */
  readCalendar: (profileId: string | null) => Promise<CalendarRead | null>
  /** The profile's open tasks due today or overdue (PlannerService). */
  dueToday: (profileId: string) => Promise<InboxItem[]>
  now?: () => number
}

const within = <T,>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())])

/**
 * The popover's "Today" data for the active profile: the next meetings and the Plan tasks due.
 * It remembers the meetings it handed out, so a click on one opens its call link without the
 * renderer ever sending a URL to open.
 */
export class TrayToday {
  private meetings = new Map<string, string | undefined>()
  private last: { profileId: string | null; calendar: TrayCalendarEvent[] } = { profileId: null, calendar: [] }

  constructor(private readonly deps: TrayTodayDeps) {}

  async read(profileId: string | null): Promise<{ calendar: TrayCalendarEvent[]; planDueToday: TrayPlanItem[] }> {
    const now = (this.deps.now ?? Date.now)()
    const previous = this.last.profileId === profileId ? this.last.calendar : []
    const [calendar, due] = await Promise.all([
      within(
        this.deps.readCalendar(profileId).then((r) => (r && (r.state === 'ready' || r.state === 'demo') ? trayCalendar(r.events, now) : [])),
        READ_TIMEOUT_MS,
        previous.filter((e) => (e.endsAt ?? e.startsAt) > now)
      ),
      profileId ? this.deps.dueToday(profileId).catch(() => []) : Promise.resolve([])
    ])
    this.last = { profileId, calendar }
    this.meetings = new Map(calendar.map((e) => [e.id, e.joinUrl]))
    return { calendar, planDueToday: trayPlanItems(due, localDay(now)) }
  }

  /** The call link of a meeting the popover listed; null when it has none (or is not listed). */
  joinUrl(id: string): string | null {
    return this.meetings.get(id) ?? null
  }
}
