import { parseIcs, startOfLocalDayAt, type CalendarEvent, type CalendarReadRequest, type CalendarReadResult, type CalendarSource } from '@workhub/core'
import { describeNetworkError, fetchClient, TooLargeError, type HttpClient } from '../shared/http'

/** A calendar read gives up after this long. */
export const ICS_TIMEOUT_MS = 20_000
/** A calendar file larger than this is refused (years of history in one feed). */
export const ICS_MAX_BYTES = 5 * 1024 * 1024

/**
 * The address a calendar is fetched from: `webcal://` (iCloud, Outlook's subscribe links) becomes
 * `https://`. Only https is accepted (the address is a secret), except a local http server for tests.
 * Null when it is not a usable address.
 */
export function normalizeIcsUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/^webcals?:\/\//i, 'https://')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return url.toString()
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.toString()
  return null
}

export interface IcsCalendarSourceDeps {
  http?: HttpClient
}

/**
 * Reads a calendar from its private ICS address (Google Calendar's "secret address", Outlook's
 * published ICS link, an iCloud public calendar). The address is a secret: it is never logged and
 * never part of an error; errors name the host only.
 */
export class IcsCalendarSource implements CalendarSource {
  private readonly http: HttpClient

  constructor(deps: IcsCalendarSourceDeps = {}) {
    this.http = deps.http ?? fetchClient
  }

  async read(request: CalendarReadRequest): Promise<CalendarReadResult> {
    const url = normalizeIcsUrl(request.url)
    if (!url) return { ok: false, failure: 'unreachable', detail: 'The address must start with https:// or webcal://' }
    const host = new URL(url).hostname
    let response
    try {
      response = await this.http({ method: 'GET', url, headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' }, timeoutMs: ICS_TIMEOUT_MS, maxBytes: ICS_MAX_BYTES })
    } catch (error) {
      if (error instanceof TooLargeError || (error instanceof Error && error.name === 'TooLargeError')) return { ok: false, failure: 'tooLarge' }
      return { ok: false, failure: 'unreachable', detail: describeNetworkError(error, host) }
    }
    // A private address that was reset or revoked answers 401, 403 or 404 depending on the provider.
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) return { ok: false, failure: 'unauthorized', detail: `${host} answered ${response.status}` }
    if (response.status < 200 || response.status >= 300) return { ok: false, failure: 'unreachable', detail: `${host} answered ${response.status}` }
    const parsed = parseIcs(response.text, { calendarId: request.calendarId, window: request.window, ...(request.ownerEmail ? { ownerEmail: request.ownerEmail } : {}) })
    return parsed.ok ? { ok: true, events: parsed.events } : { ok: false, failure: 'notCalendar' }
  }
}

/** `WORKHUB_DEMO_CALENDAR=1`: synthetic meetings around now, no address needed. Nothing here is real data. */
export class DemoCalendarSource implements CalendarSource {
  /** `events` builds the day around `now`; the generic demo day by default (the team-lead scenario passes its own). */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly events: (now: number, calendarId: string) => CalendarEvent[] = demoCalendarEvents
  ) {}

  async read(request: CalendarReadRequest): Promise<CalendarReadResult> {
    return { ok: true, events: this.events(this.now(), request.calendarId).filter((e) => e.end > request.window.from && e.start < request.window.to) }
  }
}

const TEAM = [
  { name: 'Ana Lopez', email: 'ana@example.com' },
  { name: 'Bo Chen', email: 'bo@example.com' },
  { name: 'Cy Park', email: 'cy@example.com' },
  { name: 'Dee Silva', email: 'dee@example.com' },
  { name: 'Eli Novak', email: 'eli@example.com' }
]
const ME = { name: 'Demo User', email: 'me@example.com' }

/**
 * Today's and tomorrow's demo meetings: a daily stand-up, a 1:1, sprint planning and a review,
 * placed so that one is always coming up (the next ones start a few minutes from now).
 */
export function demoCalendarEvents(now: number, calendarId = 'demo-calendar'): CalendarEvent[] {
  const today = startOfLocalDayAt(now)
  const at = (dayStart: number, h: number, m = 0) => new Date(new Date(dayStart).setHours(h, m, 0, 0)).getTime()
  const soon = Math.ceil((now + 8 * 60_000) / (5 * 60_000)) * 5 * 60_000
  const make = (uid: string, title: string, start: number, minutes: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: `${uid}|${start}`,
    uid,
    title,
    start,
    end: start + minutes * 60_000,
    allDay: false,
    attendees: [{ ...ME, status: 'accepted' }, ...TEAM.slice(0, 3).map((p) => ({ ...p, status: 'accepted' as const }))],
    organizer: TEAM[0]!,
    calendarId,
    recurring: false,
    ...extra
  })
  const tomorrow = startOfLocalDayAt(now, 1)
  return [
    make('demo-standup', 'Team stand-up', at(today, 9, 30), 15, { recurring: true, meetingUrl: 'https://meet.google.com/abc-defg-hij', description: 'Daily sync: yesterday, today, blockers.' }),
    make('demo-one-on-one', '1:1 Ana / Demo', soon, 30, { attendees: [{ ...ME, status: 'accepted' }, { ...TEAM[0]!, status: 'accepted' }], recurring: true, meetingUrl: 'https://acme.zoom.us/j/1234567890', description: 'Weekly 1:1.' }),
    make('demo-planning', 'Sprint planning', soon + 90 * 60_000, 60, {
      attendees: [{ ...ME, status: 'accepted' }, ...TEAM.map((p) => ({ ...p, status: 'accepted' as const }))],
      location: 'Room Atlas',
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/demo',
      description: 'Pick the stories for the next sprint. Bring estimates for PAY-123 and PAY-130.'
    }),
    make('demo-review', 'Design review: billing export', soon + 4 * 60 * 60_000, 45, { description: 'Walk through the export flow.' }),
    make('demo-offsite', 'Team offsite', tomorrow, 24 * 60, { allDay: true, attendees: [] }),
    make('demo-standup', 'Team stand-up', at(tomorrow, 9, 30), 15, { recurring: true, meetingUrl: 'https://meet.google.com/abc-defg-hij', description: 'Daily sync: yesterday, today, blockers.' }),
    make('demo-retro', 'Sprint retro', at(tomorrow, 15), 60, { recurring: true, attendees: [{ ...ME, status: 'accepted' }, ...TEAM.map((p) => ({ ...p, status: 'accepted' as const }))] })
  ].sort((a, b) => a.start - b.start)
}

/** The people the demo meetings involve, for a demo profile's People list. */
export const DEMO_PEOPLE = TEAM.map((p, i) => ({ id: `demo-${i + 1}`, name: p.name, emails: [p.email] }))
