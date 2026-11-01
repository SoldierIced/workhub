import { findMeetingUrl } from './meeting-links'
import { expandRecurrence, parseRrule } from './recurrence'
import { localTimeToEpoch, zonedTimeToEpoch, type WallTime } from './timezone'
import { MAX_DESCRIPTION_CHARS, type AttendeeStatus, type CalendarAttendee, type CalendarEvent } from './types'

/**
 * A reader for iCalendar files (RFC 5545) as Google Calendar, Outlook and iCloud publish them at a
 * private address: folded lines, escaped text, VEVENTs with times in UTC, floating or in a named
 * zone, all-day events, recurrence (with exceptions and moved instances), attendees and the
 * organizer. Only a window of time is expanded. Pure: no I/O.
 */

export interface IcsProperty {
  /** Upper case. */
  name: string
  /** Parameter names upper case, values without quotes. */
  params: Record<string, string>
  value: string
}

/** Lines with folding undone (a line that starts with a space or tab continues the previous one). */
export function unfoldIcs(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1)
    else if (line.length) out.push(line)
  }
  return out
}

/** `NAME;PARAM=value;PARAM="quoted":value`, with `:` and `;` inside quotes kept. */
export function parseIcsLine(line: string): IcsProperty | null {
  let quoted = false
  let colon = -1
  const cuts: number[] = []
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && c === ';') cuts.push(i)
    else if (!quoted && c === ':') {
      colon = i
      break
    }
  }
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  const bounds = [-1, ...cuts.filter((i) => i < colon), colon]
  const pieces = bounds.slice(0, -1).map((b, i) => head.slice(b + 1, bounds[i + 1]))
  const name = (pieces[0] ?? '').trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const piece of pieces.slice(1)) {
    const at = piece.indexOf('=')
    if (at > 0) params[piece.slice(0, at).trim().toUpperCase()] = piece.slice(at + 1).trim().replace(/^"|"$/g, '')
  }
  return { name, params, value: line.slice(colon + 1) }
}

/** TEXT values: `\n`, `\,`, `\;` and `\\` back to their characters. */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

type IcsTime = { kind: 'date'; wall: WallTime } | { kind: 'utc'; wall: WallTime } | { kind: 'zoned'; wall: WallTime; tzid: string } | { kind: 'floating'; wall: WallTime }

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i

/** A DATE or DATE-TIME value; `tzid` applies to a local time without `Z`. */
function parseTime(raw: string, params: Record<string, string>): IcsTime | null {
  const m = DATE_TIME.exec(raw.trim())
  if (!m) return null
  const wall: WallTime = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0) }
  if (!m[4] || params['VALUE']?.toUpperCase() === 'DATE') return { kind: 'date', wall: { ...wall, h: 0, mi: 0, s: 0 } }
  if (m[7]) return { kind: 'utc', wall }
  const tzid = params['TZID']
  return tzid ? { kind: 'zoned', wall, tzid } : { kind: 'floating', wall }
}

const utcOf = (w: WallTime) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s)

/** How a wall time of this kind becomes an instant: all-day and floating times use the machine's zone; an unknown zone too. */
function clockOf(time: IcsTime): (wall: WallTime) => number {
  if (time.kind === 'utc') return utcOf
  if (time.kind === 'zoned') {
    const tzid = time.tzid
    return (wall) => zonedTimeToEpoch(wall, tzid) ?? localTimeToEpoch(wall)
  }
  return localTimeToEpoch
}

const epochOf = (time: IcsTime) => clockOf(time)(time.wall)

function addDays(wall: WallTime, days: number): WallTime {
  const d = new Date(Date.UTC(wall.y, wall.m - 1, wall.d + days))
  return { ...wall, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i

/** An ICS DURATION (`PT30M`, `P1D`) in milliseconds; null when it is not one. */
export function parseIcsDuration(value: string): number | null {
  const m = DURATION.exec(value.trim())
  if (!m || value.trim().toUpperCase() === 'P' || value.trim().toUpperCase() === 'PT') return null
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? 0)) as [number, number, number, number, number]
  const ms = ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000
  return m[1] === '-' ? -ms : ms
}

type RawEvent = IcsProperty[]
const first = (raw: RawEvent, name: string) => raw.find((p) => p.name === name)
const all = (raw: RawEvent, name: string) => raw.filter((p) => p.name === name)
const text = (raw: RawEvent, name: string) => {
  const p = first(raw, name)
  const v = p ? unescapeIcsText(p.value).trim() : ''
  return v || undefined
}

const PARTSTAT: Record<string, AttendeeStatus> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needsAction', DELEGATED: 'delegated' }

function personOf(p: IcsProperty): CalendarAttendee | null {
  const raw = p.value.trim().replace(/^mailto:/i, '')
  if (!raw.includes('@')) return null
  const person: CalendarAttendee = { email: raw.toLowerCase() }
  const name = p.params['CN']?.trim()
  if (name && name.toLowerCase() !== person.email) person.name = name
  const status = PARTSTAT[p.params['PARTSTAT']?.toUpperCase() ?? '']
  if (status) person.status = status
  return person
}

/** The VEVENTs of a VCALENDAR (alarms and other nested parts left out); null when the text is not a calendar. */
export function icsEvents(textValue: string): RawEvent[] | null {
  const lines = unfoldIcs(textValue)
  if (!lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l))) return null
  const events: RawEvent[] = []
  const stack: string[] = []
  let current: RawEvent | null = null
  for (const line of lines) {
    const prop = parseIcsLine(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      const part = prop.value.trim().toUpperCase()
      stack.push(part)
      if (part === 'VEVENT' && stack.length === 2) current = []
      continue
    }
    if (prop.name === 'END') {
      const part = stack.pop()
      if (part === 'VEVENT' && current && stack.length === 1) {
        events.push(current)
        current = null
      }
      continue
    }
    if (current && stack.length === 2 && stack[1] === 'VEVENT') current.push(prop)
  }
  return events
}

export interface ParseIcsOptions {
  calendarId: string
  /** Only instances that overlap this window (epoch ms) are returned. */
  window: { from: number; to: number }
  /** Events this address declined are left out. */
  ownerEmail?: string
}

export type ParseIcsResult = { ok: true; events: CalendarEvent[] } | { ok: false; reason: 'notCalendar' }

interface Timing {
  start: IcsTime
  /** All-day events last whole days; timed ones a fixed time. */
  days: number
  ms: number
}

function timingOf(raw: RawEvent): Timing | null {
  const dtstart = first(raw, 'DTSTART')
  const start = dtstart ? parseTime(dtstart.value, dtstart.params) : null
  if (!start) return null
  const dtend = first(raw, 'DTEND')
  const end = dtend ? parseTime(dtend.value, dtend.params) : null
  const duration = text(raw, 'DURATION')
  const durationMs = duration ? parseIcsDuration(duration) : null
  if (start.kind === 'date') {
    let days = 1
    if (end) days = Math.max(1, Math.round((utcOf({ ...end.wall, h: 0, mi: 0, s: 0 }) - utcOf(start.wall)) / 86_400_000))
    else if (durationMs !== null) days = Math.max(1, Math.round(durationMs / 86_400_000))
    return { start, days, ms: 0 }
  }
  const startMs = epochOf(start)
  const ms = end ? Math.max(0, epochOf(end) - startMs) : durationMs !== null ? Math.max(0, durationMs) : 0
  return { start, days: 0, ms }
}

/** An instance's start and end from its wall time. */
function instanceSpan(timing: Timing, wall: WallTime, epoch: number): { start: number; end: number } {
  if (timing.start.kind === 'date') return { start: epoch, end: localTimeToEpoch(addDays(wall, timing.days)) }
  return { start: epoch, end: epoch + timing.ms }
}

function buildEvent(raw: RawEvent, uid: string, idEpoch: number, span: { start: number; end: number }, allDay: boolean, recurring: boolean, options: ParseIcsOptions): CalendarEvent | null {
  if (text(raw, 'STATUS')?.toUpperCase() === 'CANCELLED') return null
  const attendees: CalendarAttendee[] = []
  for (const p of all(raw, 'ATTENDEE')) {
    const cutype = p.params['CUTYPE']?.toUpperCase()
    if (cutype === 'RESOURCE' || cutype === 'ROOM') continue
    const person = personOf(p)
    if (person && !attendees.some((a) => a.email === person.email)) attendees.push(person)
  }
  const owner = options.ownerEmail?.trim().toLowerCase()
  if (owner && attendees.some((a) => a.email === owner && a.status === 'declined')) return null
  const organizerProp = first(raw, 'ORGANIZER')
  const organizer = organizerProp ? personOf(organizerProp) : null
  const location = text(raw, 'LOCATION')
  const url = text(raw, 'URL')
  const fullDescription = text(raw, 'DESCRIPTION')
  const conference = text(raw, 'X-GOOGLE-CONFERENCE')
  const meetingUrl = findMeetingUrl([conference, location, url, fullDescription])
  const event: CalendarEvent = {
    id: `${uid}|${idEpoch}`,
    uid,
    title: text(raw, 'SUMMARY') ?? '',
    start: span.start,
    end: span.end,
    allDay,
    attendees,
    calendarId: options.calendarId,
    recurring
  }
  if (location) event.location = location
  if (url) event.url = url
  if (meetingUrl) event.meetingUrl = meetingUrl
  if (organizer) event.organizer = organizer
  if (fullDescription) event.description = fullDescription.length > MAX_DESCRIPTION_CHARS ? `${fullDescription.slice(0, MAX_DESCRIPTION_CHARS)}…` : fullDescription
  return event
}

const overlaps = (span: { start: number; end: number }, window: { from: number; to: number }) => span.start < window.to && (span.end > window.from || (span.end === span.start && span.start >= window.from))

/** The epochs a multi-valued date property (EXDATE) names. */
function datesOf(props: IcsProperty[]): Set<number> {
  const out = new Set<number>()
  for (const p of props) {
    for (const value of p.value.split(',')) {
      const t = parseTime(value, p.params)
      if (t) out.add(epochOf(t))
    }
  }
  return out
}

/**
 * The events of a calendar that overlap the window, recurring ones expanded, sorted by start.
 * Cancelled events and instances, excluded dates and events the owner declined are left out; a
 * moved instance (RECURRENCE-ID) replaces the one it moves. Never throws on odd content: an event
 * it cannot read is skipped.
 */
export function parseIcs(textValue: string, options: ParseIcsOptions): ParseIcsResult {
  const raws = icsEvents(textValue)
  if (!raws) return { ok: false, reason: 'notCalendar' }
  const masters: { raw: RawEvent; uid: string }[] = []
  const overrides = new Map<string, Map<number, RawEvent>>()
  raws.forEach((raw, index) => {
    const uid = text(raw, 'UID') ?? `${options.calendarId}-${index}`
    const rid = first(raw, 'RECURRENCE-ID')
    const ridTime = rid ? parseTime(rid.value, rid.params) : null
    if (ridTime) {
      const byEpoch = overrides.get(uid) ?? new Map<number, RawEvent>()
      byEpoch.set(epochOf(ridTime), raw)
      overrides.set(uid, byEpoch)
    } else masters.push({ raw, uid })
  })

  const events: CalendarEvent[] = []
  const consumed = new Set<string>()
  for (const { raw, uid } of masters) {
    if (text(raw, 'STATUS')?.toUpperCase() === 'CANCELLED') {
      overrides.get(uid)?.forEach((_r, epoch) => consumed.add(`${uid}|${epoch}`))
      continue
    }
    const timing = timingOf(raw)
    if (!timing) continue
    const allDay = timing.start.kind === 'date'
    const moved = overrides.get(uid)
    const rruleProp = first(raw, 'RRULE')
    const clock = clockOf(timing.start)
    const rule = rruleProp
      ? parseRrule(rruleProp.value, (rawUntil) => {
          const t = parseTime(rawUntil, timing.start.kind === 'zoned' ? { TZID: timing.start.tzid } : {})
          if (!t) return null
          // A date-only UNTIL includes that whole day.
          return t.kind === 'date' ? clock({ ...t.wall, h: 23, mi: 59, s: 59 }) : epochOf(t)
        })
      : null
    if (!rule) {
      const epoch = clock(timing.start.wall)
      const span = instanceSpan(timing, timing.start.wall, epoch)
      if (overlaps(span, options.window)) {
        const event = buildEvent(raw, uid, epoch, span, allDay, false, options)
        if (event) events.push(event)
      }
      continue
    }
    const excluded = datesOf(all(raw, 'EXDATE'))
    // Instances moved into the window from further out still have to be generated to be replaced.
    const stopAfter = Math.max(options.window.to, ...[...(moved?.keys() ?? [])])
    for (const { wall, epoch } of expandRecurrence(rule, timing.start.wall, clock, stopAfter)) {
      if (excluded.has(epoch)) {
        consumed.add(`${uid}|${epoch}`)
        continue
      }
      const override = moved?.get(epoch)
      if (override) {
        consumed.add(`${uid}|${epoch}`)
        const overrideTiming = timingOf(override)
        if (!overrideTiming) continue
        const overrideEpoch = epochOf(overrideTiming.start)
        const span = instanceSpan(overrideTiming, overrideTiming.start.wall, overrideEpoch)
        if (!overlaps(span, options.window)) continue
        const event = buildEvent(override, uid, epoch, span, overrideTiming.start.kind === 'date', true, options)
        if (event) events.push(event)
        continue
      }
      const span = instanceSpan(timing, wall, epoch)
      if (span.start >= options.window.to) break
      if (!overlaps(span, options.window)) continue
      const event = buildEvent(raw, uid, epoch, span, allDay, true, options)
      if (event) events.push(event)
    }
  }
  // Moved instances whose series did not produce them (no master in the file, or not expanded).
  for (const [uid, byEpoch] of overrides) {
    for (const [epoch, raw] of byEpoch) {
      if (consumed.has(`${uid}|${epoch}`)) continue
      const timing = timingOf(raw)
      if (!timing) continue
      const start = epochOf(timing.start)
      const span = instanceSpan(timing, timing.start.wall, start)
      if (!overlaps(span, options.window)) continue
      const event = buildEvent(raw, uid, epoch, span, timing.start.kind === 'date', true, options)
      if (event) events.push(event)
    }
  }
  events.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
  return { ok: true, events }
}
