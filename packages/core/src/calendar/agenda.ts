import type { CalendarEvent, Person } from './types'

const DAY_MS = 86_400_000

/** What is read from a calendar: from a day ago (meetings in progress, yesterday's for a stand-up) to two weeks ahead. */
export function calendarWindow(now: number): { from: number; to: number } {
  return { from: now - DAY_MS, to: now + 14 * DAY_MS }
}

/** Local midnight of the day `ms` falls on, `days` days later. */
export function startOfLocalDayAt(ms: number, days = 0): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime()
}

const byStart = (a: CalendarEvent, b: CalendarEvent) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title)

/** Several calendars' events as one list: an event in two calendars (same instance id) once, sorted by start. */
export function mergeCalendars(lists: readonly (readonly CalendarEvent[])[]): CalendarEvent[] {
  const seen = new Map<string, CalendarEvent>()
  for (const list of lists) for (const e of list) if (!seen.has(e.id)) seen.set(e.id, e)
  return [...seen.values()].sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
}

/** The events of one local day (all-day ones first), from its midnight to the next. */
export function eventsOnDay(events: readonly CalendarEvent[], dayStart: number): CalendarEvent[] {
  const dayEnd = startOfLocalDayAt(dayStart, 1)
  return events.filter((e) => e.start < dayEnd && (e.end > dayStart || (e.end === e.start && e.start >= dayStart))).sort(byStart)
}

/** Today's and tomorrow's agenda. */
export function agendaDays(events: readonly CalendarEvent[], now: number): { today: CalendarEvent[]; tomorrow: CalendarEvent[] } {
  return { today: eventsOnDay(events, startOfLocalDayAt(now)), tomorrow: eventsOnDay(events, startOfLocalDayAt(now, 1)) }
}

/** The next timed events of today that have not ended (Home's "Next meetings"). */
export function nextMeetings(events: readonly CalendarEvent[], now: number, limit = 3): CalendarEvent[] {
  const tomorrow = startOfLocalDayAt(now, 1)
  return events
    .filter((e) => !e.allDay && e.end > now && e.start < tomorrow)
    .sort((a, b) => a.start - b.start)
    .slice(0, limit)
}

const emailsOf = (person: Pick<Person, 'emails'>) => new Set(person.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))

/** Whether the person is among the event's attendees or is its organizer. */
export function involves(event: CalendarEvent, person: Pick<Person, 'emails'>): boolean {
  const emails = emailsOf(person)
  return event.attendees.some((a) => emails.has(a.email)) || (event.organizer !== undefined && emails.has(event.organizer.email))
}

/** The person's meetings that have not ended, soonest first. */
export function meetingsWith(person: Pick<Person, 'emails'>, events: readonly CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((e) => !e.allDay && e.end > now && involves(e, person)).sort((a, b) => a.start - b.start)
}

/** The people (from the profile's list) among an event's attendees and organizer, matched by email. */
export function peopleAt(event: CalendarEvent, people: readonly Person[]): Person[] {
  return people.filter((p) => involves(event, p))
}
