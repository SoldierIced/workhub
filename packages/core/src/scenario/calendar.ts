import { startOfLocalDayAt } from '../calendar/agenda'
import type { CalendarAttendee, CalendarEvent } from '../calendar/types'
import { PRODUCT_CALENDAR_ID, PRODUCT_ME, PRODUCT_PEOPLE } from './profile'

const MINUTE = 60_000
const person = (id: string): CalendarAttendee => {
  const p = PRODUCT_PEOPLE.find((x) => x.id === id)!
  return { name: p.name, email: p.emails[0]!, status: 'accepted' }
}
const me: CalendarAttendee = { ...PRODUCT_ME, status: 'accepted' }

/**
 * A team lead's day, placed around `now`: the next meeting starts about ten minutes from now
 * (so a reminder and the 1:1 brief rule show up quickly) and the rest of today follows from there;
 * tomorrow has fixed hours. Attendees come from `PRODUCT_PEOPLE`; the calls use made-up links.
 */
export function productCalendarEvents(now: number, calendarId = PRODUCT_CALENDAR_ID): CalendarEvent[] {
  const today = startOfLocalDayAt(now)
  const tomorrow = startOfLocalDayAt(now, 1)
  const at = (dayStart: number, h: number, m = 0) => new Date(new Date(dayStart).setHours(h, m, 0, 0)).getTime()
  // The next meeting: a quarter of an hour ahead at most, on a 5-minute mark, never less than 8 minutes away.
  const soon = Math.ceil((now + 8 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE
  const make = (uid: string, title: string, start: number, minutes: number, who: string[], extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: `${uid}|${start}`,
    uid,
    title,
    start,
    end: start + minutes * MINUTE,
    allDay: false,
    attendees: [me, ...who.map(person)],
    organizer: who.length > 0 ? person(who[0]!) : me,
    calendarId,
    recurring: false,
    ...extra
  })
  const standup = (day: number) =>
    make('demo-daily-standup', 'Daily standup', at(day, 9, 30), 15, ['priya-nair', 'tom-becker', 'mia-novak'], {
      recurring: true,
      meetingUrl: 'https://meet.example.com/notes-standup',
      description: 'Daily sync for the product squad: yesterday, today, blockers.'
    })
  return [
    standup(today),
    make('demo-one-on-one-priya', '1:1 Priya Nair / Alex Morgan', soon, 30, ['priya-nair'], {
      recurring: true,
      meetingUrl: 'https://meet.example.com/priya-alex-1on1',
      description: 'Weekly 1:1: delivery risks for NOTE-231, estimates for the activation experiment, tech debt in the editor save path.'
    }),
    make('demo-activation-review', 'Activation metrics review', soon + 75 * MINUTE, 45, ['kenji-ito', 'tom-becker'], {
      meetingUrl: 'https://meet.example.com/activation-metrics',
      description: 'Walk through the signup funnel: where new teams drop, what the invite-a-teammate experiment showed, and what to try next.'
    }),
    make('demo-roadmap-checkin', 'Roadmap check-in with the founder', soon + 3 * 60 * MINUTE, 60, ['sara-lind', 'priya-nair'], {
      location: 'Board room',
      meetingUrl: 'https://meet.example.com/roadmap-checkin',
      description: 'Milestones: status, risks and what we cut. Bring the milestone view and the open alerts.'
    }),
    make('demo-refinement', 'Backlog refinement', soon + 5 * 60 * MINUTE, 60, ['priya-nair', 'tom-becker', 'mia-novak'], {
      recurring: true,
      meetingUrl: 'https://meet.example.com/notes-refinement',
      description: 'Refine the next sprint: NOTE-250, NOTE-253 and the empty-state copy.'
    }),
    make('demo-support-sync', 'Support sync', soon + 6.5 * 60 * MINUTE, 30, ['omar-haddad', 'kenji-ito'], {
      meetingUrl: 'https://meet.example.com/support-sync',
      description: 'Top cancellation reasons, ticket volume and the calendar integration requests.'
    }),
    standup(tomorrow),
    make('demo-toolbar-critique', 'Design critique: editor toolbar', at(tomorrow, 11), 45, ['tom-becker', 'kenji-ito'], {
      meetingUrl: 'https://meet.example.com/toolbar-critique',
      description: 'Review the new editor toolbar before it ships behind a flag.'
    }),
    make('demo-release-readiness', 'Release readiness', at(tomorrow, 15), 30, ['mia-novak', 'priya-nair'], { location: 'Room Atlas' })
  ].sort((a, b) => a.start - b.start)
}
