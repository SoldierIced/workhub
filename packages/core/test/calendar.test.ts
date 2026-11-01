import { describe, expect, it } from 'vitest'
import {
  agendaDays,
  briefContext,
  briefValues,
  DEFAULT_BRIEF_TEMPLATE,
  dueActions,
  emptyConfig,
  findMeetingUrl,
  meetingsWith,
  mergeCalendars,
  nextMeetings,
  parseConfig,
  parseIcs,
  parseIcsDuration,
  parseIcsLine,
  plannerSettings,
  pruneBriefs,
  pruneFired,
  renderBriefTemplate,
  ruleMatches,
  unescapeIcsText,
  unfoldIcs,
  unknownPlaceholders,
  validateConfig,
  zonedTimeToEpoch,
  deleteConnection,
  CONFIG_VERSION,
  type CalendarEvent,
  type MeetingRule,
  type Person,
  type WorkhubConfig
} from '../src'

const WIDE = { from: Date.UTC(2020, 0, 1), to: Date.UTC(2030, 0, 1) }
const cal = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Acme//Test//EN', ...events, 'END:VCALENDAR'].join('\r\n')
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')
const parse = (text: string, window = WIDE, ownerEmail?: string) => {
  const r = parseIcs(text, { calendarId: 'acme-cal', window, ...(ownerEmail ? { ownerEmail } : {}) })
  if (!r.ok) throw new Error('not a calendar')
  return r.events
}
const iso = (ms: number) => new Date(ms).toISOString()

describe('ICS lines', () => {
  it('unfolds continuation lines and keeps quoted colons in parameters', () => {
    expect(unfoldIcs('SUMMARY:Plan\r\n ning\r\n\tday\r\nUID:1')).toEqual(['SUMMARY:Planningday', 'UID:1'])
    expect(parseIcsLine('ATTENDEE;CN="Doe, Ana";PARTSTAT=ACCEPTED:mailto:ana@example.com')).toEqual({ name: 'ATTENDEE', params: { CN: 'Doe, Ana', PARTSTAT: 'ACCEPTED' }, value: 'mailto:ana@example.com' })
    expect(parseIcsLine('DTSTART;TZID="America/New_York":20260302T090000')?.params['TZID']).toBe('America/New_York')
    expect(parseIcsLine('no colon here')).toBeNull()
  })

  it('unescapes text values', () => {
    expect(unescapeIcsText('One\\, two\\; three\\nfour\\\\five\\Nsix')).toBe('One, two; three\nfour\\five\nsix')
  })

  it('reads durations', () => {
    expect(parseIcsDuration('PT30M')).toBe(30 * 60_000)
    expect(parseIcsDuration('P1DT2H')).toBe(26 * 3_600_000)
    expect(parseIcsDuration('P1W')).toBe(7 * 86_400_000)
    expect(parseIcsDuration('nope')).toBeNull()
  })
})

describe('parseIcs', () => {
  it('refuses text that is not a calendar', () => {
    expect(parseIcs('<html>Sign in</html>', { calendarId: 'x', window: WIDE })).toEqual({ ok: false, reason: 'notCalendar' })
  })

  it('reads a UTC event with folded, escaped text, attendees, organizer and a call link', () => {
    const [event, ...rest] = parse(
      cal(
        vevent(
          'UID:evt-1@example.com',
          'SUMMARY:Sprint planning\\, Q4',
          'DTSTART:20261103T150000Z',
          'DTEND:20261103T160000Z',
          'LOCATION:Room 4',
          'DESCRIPTION:Agenda:\\n- scope\\n- risks\\nJoin: https://meet.google.com/abc-defg-hij',
          'ORGANIZER;CN=Ana Lopez:mailto:ana@example.com',
          'ATTENDEE;CN=Ana Lopez;PARTSTAT=ACCEPTED:mailto:ana@example.com',
          'ATTENDEE;CN=Bo;PARTSTAT=TENTATIVE:mailto:BO@example.com',
          'ATTENDEE;CUTYPE=RESOURCE;CN=Room 4:mailto:room4@resource.example.com',
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          'DESCRIPTION:Reminder',
          'END:VALARM'
        )
      ).replace('Join: https', 'Join: \r\n https')
    )
    expect(rest).toEqual([])
    expect(event).toMatchObject({
      id: `evt-1@example.com|${Date.UTC(2026, 10, 3, 15)}`,
      title: 'Sprint planning, Q4',
      start: Date.UTC(2026, 10, 3, 15),
      end: Date.UTC(2026, 10, 3, 16),
      allDay: false,
      location: 'Room 4',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      organizer: { name: 'Ana Lopez', email: 'ana@example.com' },
      calendarId: 'acme-cal',
      recurring: false
    })
    expect(event!.attendees).toEqual([
      { name: 'Ana Lopez', email: 'ana@example.com', status: 'accepted' },
      { name: 'Bo', email: 'bo@example.com', status: 'tentative' }
    ])
    expect(event!.description).toContain('- scope\n- risks')
  })

  it('converts a TZID wall time, and keeps a weekly meeting at the same wall time across a DST change', () => {
    const events = parse(cal(vevent('UID:standup', 'SUMMARY:Standup', 'DTSTART;TZID=America/New_York:20260302T090000', 'DTEND;TZID=America/New_York:20260302T091500', 'RRULE:FREQ=WEEKLY;COUNT=3')))
    // New York moves to daylight time on 2026-03-08: 09:00 is 14:00 UTC before and 13:00 UTC after.
    expect(events.map((e) => iso(e.start))).toEqual(['2026-03-02T14:00:00.000Z', '2026-03-09T13:00:00.000Z', '2026-03-16T13:00:00.000Z'])
    expect(events.every((e) => e.end - e.start === 15 * 60_000 && e.recurring)).toBe(true)
  })

  it('handles the European DST change and Outlook Windows zone names', () => {
    const madrid = parse(cal(vevent('UID:m', 'SUMMARY:Sync', 'DTSTART;TZID=Europe/Madrid:20260328T100000', 'DURATION:PT30M', 'RRULE:FREQ=DAILY;COUNT=2')))
    expect(madrid.map((e) => iso(e.start))).toEqual(['2026-03-28T09:00:00.000Z', '2026-03-29T08:00:00.000Z'])
    const outlook = parse(cal(vevent('UID:o', 'SUMMARY:Review', 'DTSTART;TZID=Pacific Standard Time:20260715T100000', 'DTEND;TZID=Pacific Standard Time:20260715T110000')))
    expect(iso(outlook[0]!.start)).toBe('2026-07-15T17:00:00.000Z')
  })

  it('treats floating times and unknown zones as local time', () => {
    const [floating, unknown] = parse(cal(vevent('UID:f', 'SUMMARY:F', 'DTSTART:20261110T083000'), vevent('UID:u', 'SUMMARY:U', 'DTSTART;TZID=Mars/Olympus:20261111T083000')))
    expect(floating!.start).toBe(new Date(2026, 10, 10, 8, 30).getTime())
    expect(unknown!.start).toBe(new Date(2026, 10, 11, 8, 30).getTime())
  })

  it('reads all-day events as local days', () => {
    const [offsite, holiday] = parse(cal(vevent('UID:a', 'SUMMARY:Offsite', 'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261104'), vevent('UID:b', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261225')))
    expect(offsite).toMatchObject({ allDay: true, start: new Date(2026, 10, 2).getTime(), end: new Date(2026, 10, 4).getTime() })
    expect(holiday).toMatchObject({ allDay: true, start: new Date(2026, 11, 25).getTime(), end: new Date(2026, 11, 26).getTime() })
  })

  it('applies EXDATE, moved instances (RECURRENCE-ID) and cancelled instances', () => {
    const events = parse(
      cal(
        vevent('UID:daily', 'SUMMARY:Daily', 'DTSTART:20261102T140000Z', 'DTEND:20261102T141500Z', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE:20261103T140000Z'),
        vevent('UID:daily', 'RECURRENCE-ID:20261104T140000Z', 'SUMMARY:Daily (moved)', 'DTSTART:20261104T170000Z', 'DTEND:20261104T171500Z'),
        vevent('UID:daily', 'RECURRENCE-ID:20261105T140000Z', 'SUMMARY:Daily', 'STATUS:CANCELLED', 'DTSTART:20261105T140000Z', 'DTEND:20261105T141500Z')
      )
    )
    expect(events.map((e) => [iso(e.start), e.title])).toEqual([
      ['2026-11-02T14:00:00.000Z', 'Daily'],
      ['2026-11-04T17:00:00.000Z', 'Daily (moved)'],
      ['2026-11-06T14:00:00.000Z', 'Daily']
    ])
    // The moved instance keeps the id of the slot it replaces.
    expect(events[1]!.id).toBe(`daily|${Date.UTC(2026, 10, 4, 14)}`)
  })

  it('leaves out cancelled events and events the owner declined', () => {
    const text = cal(
      vevent('UID:c', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261102T140000Z'),
      vevent('UID:d', 'SUMMARY:Declined', 'DTSTART:20261102T150000Z', 'ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com'),
      vevent('UID:k', 'SUMMARY:Kept', 'DTSTART:20261102T160000Z', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com')
    )
    expect(parse(text, WIDE, 'Me@Example.com').map((e) => e.title)).toEqual(['Kept'])
    expect(parse(text).map((e) => e.title)).toEqual(['Declined', 'Kept'])
  })

  it('expands weekly BYDAY with INTERVAL and UNTIL', () => {
    const events = parse(cal(vevent('UID:w', 'SUMMARY:Gym', 'DTSTART:20261102T120000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;UNTIL=20261120T235959Z')))
    expect(events.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-16', '2026-11-18', '2026-11-20'])
  })

  it('expands monthly rules by month day and by ordinal weekday', () => {
    const last = parse(cal(vevent('UID:l', 'SUMMARY:Close', 'DTSTART:20260131T100000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3')))
    expect(last.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
    const second = parse(cal(vevent('UID:t', 'SUMMARY:Retro', 'DTSTART:20261110T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3')))
    expect(second.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-11-10', '2026-12-08', '2027-01-12'])
    const plain = parse(cal(vevent('UID:p', 'SUMMARY:Pay', 'DTSTART:20260131T100000Z', 'RRULE:FREQ=MONTHLY;COUNT=3')))
    // Months without a 31st are skipped.
    expect(plain.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31'])
  })

  it('returns only the instances inside the window, counting from the first one', () => {
    const window = { from: Date.UTC(2026, 10, 10), to: Date.UTC(2026, 10, 13) }
    const events = parse(cal(vevent('UID:d', 'SUMMARY:Daily', 'DTSTART:20200101T090000Z', 'DTEND:20200101T091500Z', 'RRULE:FREQ=DAILY')), window)
    expect(events.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-11-10', '2026-11-11', '2026-11-12'])
    const counted = parse(cal(vevent('UID:c', 'SUMMARY:Counted', 'DTSTART:20261101T090000Z', 'RRULE:FREQ=DAILY;COUNT=10')), window)
    expect(counted.map((e) => iso(e.start).slice(0, 10))).toEqual(['2026-11-10'])
  })
})

describe('zonedTimeToEpoch', () => {
  it('converts across offsets and settles inside a DST gap', () => {
    expect(zonedTimeToEpoch({ y: 2026, m: 1, d: 15, h: 9, mi: 0, s: 0 }, 'America/Argentina/Buenos_Aires')).toBe(Date.UTC(2026, 0, 15, 12))
    expect(zonedTimeToEpoch({ y: 2026, m: 7, d: 1, h: 9, mi: 0, s: 0 }, 'Europe/London')).toBe(Date.UTC(2026, 6, 1, 8))
    // 02:30 does not exist in New York on 2026-03-08; the answer lands within the hour around it.
    const gap = zonedTimeToEpoch({ y: 2026, m: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York')!
    expect(Math.abs(gap - Date.UTC(2026, 2, 8, 7, 0))).toBeLessThanOrEqual(3_600_000)
    expect(zonedTimeToEpoch({ y: 2026, m: 1, d: 1, h: 0, mi: 0, s: 0 }, 'Not/AZone')).toBeNull()
  })
})

describe('findMeetingUrl', () => {
  it('finds common video links in order of the texts', () => {
    expect(findMeetingUrl([undefined, 'Join https://acme.zoom.us/j/123456789?pwd=abc.'])).toBe('https://acme.zoom.us/j/123456789?pwd=abc')
    expect(findMeetingUrl(['https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1'])).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//)
    expect(findMeetingUrl(['Room 4', 'see https://example.com/doc'])).toBeUndefined()
  })
})

const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e1|1',
  uid: 'e1',
  title: 'Weekly sync',
  start: Date.UTC(2026, 10, 2, 15),
  end: Date.UTC(2026, 10, 2, 15, 30),
  allDay: false,
  attendees: [
    { email: 'ana@example.com', name: 'Ana' },
    { email: 'bo@example.com' }
  ],
  calendarId: 'c',
  recurring: true,
  ...patch
})
const rule = (patch: Partial<MeetingRule> = {}): MeetingRule => ({ id: 'r1', name: 'R', enabled: true, match: {}, action: 'remind', leadMinutes: 5, ...patch })

describe('meeting rules', () => {
  it('matches every condition that is set', () => {
    expect(ruleMatches(rule(), event())).toBe(true)
    expect(ruleMatches(rule({ match: { titleContains: ['SYNC', 'retro'] } }), event())).toBe(true)
    expect(ruleMatches(rule({ match: { titleContains: ['retro'] } }), event())).toBe(false)
    expect(ruleMatches(rule({ match: { titleRegex: '^weekly' } }), event())).toBe(true)
    expect(ruleMatches(rule({ match: { titleRegex: '(' } }), event())).toBe(false)
    expect(ruleMatches(rule({ match: { attendeeEmails: ['BO@example.com'] } }), event())).toBe(true)
    expect(ruleMatches(rule({ match: { attendeeEmails: ['cy@example.com'] } }), event())).toBe(false)
    expect(ruleMatches(rule({ match: { minAttendees: 3 } }), event())).toBe(false)
    expect(ruleMatches(rule({ match: { recurringOnly: true } }), event({ recurring: false }))).toBe(false)
  })

  it('fires the default reminder once, inside its lead time, never for all-day events', () => {
    const settings = { rules: [], reminderLeadMinutes: 10 }
    const start = event().start
    expect(dueActions([event()], settings, start - 11 * 60_000, () => false)).toEqual([])
    const due = dueActions([event(), event({ id: 'all', allDay: true, start: start - 60_000 })], settings, start - 9 * 60_000, () => false)
    expect(due.map((d) => d.key)).toEqual(['remind|default|e1|1'])
    expect(dueActions([event()], settings, start - 9 * 60_000, (k) => k === 'remind|default|e1|1')).toEqual([])
    expect(dueActions([event()], { rules: [], reminderLeadMinutes: 0 }, start - 60_000, () => false)).toEqual([])
    // Long after the start it is too late.
    expect(dueActions([event()], settings, start + 10 * 60_000, () => false)).toEqual([])
  })

  it('lets a matching reminder rule replace the default one, and starts one brief per event', () => {
    const settings = {
      reminderLeadMinutes: 10,
      rules: [rule({ id: 'r1', message: 'Bring the numbers' }), rule({ id: 'off', enabled: false }), rule({ id: 'b1', action: 'brief', leadMinutes: 30 }), rule({ id: 'b2', action: 'brief', leadMinutes: 30 })]
    }
    const due = dueActions([event()], settings, event().start - 4 * 60_000, () => false)
    expect(due.map((d) => [d.key, d.message])).toEqual([
      ['remind|r1|e1|1', 'Bring the numbers'],
      ['brief|b1|e1|1', undefined]
    ])
  })

  it('prunes old fired keys and brief records', () => {
    const now = Date.UTC(2026, 10, 10)
    expect(pruneFired({ old: now - 4 * 86_400_000, fresh: now - 1000 }, now)).toEqual({ fresh: now - 1000 })
    const brief = { profileId: 'p', eventId: 'e', title: 't', at: 0, status: 'started' as const }
    expect(Object.keys(pruneBriefs({ a: { ...brief, start: now - 5 * 86_400_000 }, b: { ...brief, start: now + 1000 } }, now))).toEqual(['b'])
  })
})

describe('agenda', () => {
  const at = (day: number, h: number) => new Date(2026, 10, day, h).getTime()
  const list = [
    event({ id: 'a', title: 'Early', start: at(2, 8), end: at(2, 9) }),
    event({ id: 'b', title: 'Later', start: at(2, 15), end: at(2, 16) }),
    event({ id: 'c', title: 'All day', allDay: true, start: at(2, 0), end: at(3, 0) }),
    event({ id: 'd', title: 'Tomorrow', start: at(3, 10), end: at(3, 11), attendees: [{ email: 'cy@example.com' }] }),
    event({ id: 'e', title: 'Next week', start: at(9, 10), end: at(9, 11), attendees: [{ email: 'cy@example.com' }] })
  ]

  it('splits today and tomorrow, all-day events first', () => {
    const { today, tomorrow } = agendaDays(list, at(2, 12))
    expect(today.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(tomorrow.map((e) => e.id)).toEqual(['d'])
  })

  it('lists the next timed meetings of today and the meetings with a person', () => {
    expect(nextMeetings(list, at(2, 12)).map((e) => e.id)).toEqual(['b'])
    expect(meetingsWith({ emails: ['CY@example.com'] }, list, at(2, 12)).map((e) => e.id)).toEqual(['d', 'e'])
  })

  it('merges calendars without repeating an instance', () => {
    expect(mergeCalendars([[list[1]!, list[0]!], [list[0]!]]).map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('briefs', () => {
  const ana: Person = { id: 'ana', name: 'Ana', emails: ['ana@example.com'], handles: { github: 'ana-gh', jira: 'Ana Lopez' }, notes: 'Owns billing.' }

  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(renderBriefTemplate('{title} at {start} {titel}', { title: 'Sync', start: '10:00' })).toBe('Sync at 10:00 {titel}')
    expect(unknownPlaceholders('{title} {titel} {context}')).toEqual(['titel'])
    expect(unknownPlaceholders(DEFAULT_BRIEF_TEMPLATE)).toEqual([])
  })

  it('summarizes the user work and the items that involve the people at the meeting', () => {
    const text = briefContext({
      mine: [{ title: 'Fix totals', url: 'https://github.com/acme/api/pull/1', repo: 'acme/api', author: 'me' }],
      toReview: [{ title: 'Add export', url: 'https://github.com/acme/api/pull/2', author: 'ana-gh' }],
      tickets: [{ key: 'PAY-123', title: 'Refunds', status: 'In Progress', assignee: 'Ana Lopez' }],
      people: [ana]
    })
    expect(text).toContain('My open pull requests (1):\n- Fix totals [acme/api] https://github.com/acme/api/pull/1')
    expect(text).toContain('My tickets in progress (1):\n- PAY-123 Refunds (In Progress)')
    expect(text).toContain('Involving Ana:\n- Add export https://github.com/acme/api/pull/2\n- PAY-123 Refunds (In Progress)')
    expect(briefContext({ mine: [], tickets: [], people: [] })).toBe('Nothing known.')
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `PR ${i}`, url: `https://github.com/acme/api/pull/${i}` }))
    expect(briefContext({ mine: many, tickets: [], people: [] }).split('\n')).toHaveLength(11)
    expect(briefContext({ mine: many, tickets: [], people: [] }, { items: 30, chars: 50 })).toHaveLength(51)
  })

  it('words an event for the template', () => {
    const values = briefValues(event({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), { people: [ana], context: 'ctx', formatTime: (ms) => new Date(ms).toISOString() })
    expect(values).toMatchObject({ title: 'Weekly sync', attendees: 'Ana <ana@example.com>, bo@example.com', meetingUrl: 'https://meet.google.com/abc-defg-hij', people: '- Ana <ana@example.com>: Owns billing.', context: 'ctx', description: 'None.' })
  })
})

describe('planner config', () => {
  const base = (): WorkhubConfig => ({
    ...emptyConfig(),
    connections: [
      { id: 'cal', kind: 'calendar', provider: 'ics', secretRef: 'connection/cal', settings: { ownerEmail: 'me@example.com' } },
      { id: 'jira', kind: 'tracker', provider: 'jira', endpoint: 'https://acme.example.com', secretRef: 'connection/jira', settings: {} }
    ],
    profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: true }, planner: { ...plannerSettings(undefined), calendarIds: ['cal'] } }]
  })

  it('fills defaults and clamps hand-edited values', () => {
    const parsed = parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', planner: { refreshMinutes: 1, reminderLeadMinutes: 9999, rules: [{ id: 'r', action: 'brief' }] } }] })
    expect(parsed.profiles[0]!.modules.planner).toBe(false)
    expect(parsed.profiles[0]!.planner).toEqual({ calendarIds: [], refreshMinutes: 5, reminderLeadMinutes: 240, rules: [{ id: 'r', name: '', enabled: true, match: {}, action: 'brief', leadMinutes: 10 }], briefTemplate: '', people: [] })
    expect(parseConfig({ version: 7, profiles: [] }).options).toBeUndefined()
  })

  it('checks that calendars exist and are calendar connections, and that the ids are unique', () => {
    expect(validateConfig(base())).toEqual([])
    const wrong = base()
    wrong.profiles[0]!.planner = { ...wrong.profiles[0]!.planner!, calendarIds: ['jira', 'gone'], people: [ana(), ana()] }
    expect(validateConfig(wrong).map((i) => i.message)).toEqual(['connection "jira" is a tracker connection, not calendar', 'unknown connection "gone"', 'duplicate id "ana"'])
  })

  it('refuses to delete a calendar a profile reads', () => {
    const r = deleteConnection(base(), 'cal')
    expect(r.ok).toBe(false)
  })
})

function ana(): Person {
  return { id: 'ana', name: 'Ana', emails: [] }
}
