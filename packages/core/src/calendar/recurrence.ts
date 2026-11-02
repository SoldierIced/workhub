import type { WallTime } from './timezone'

/**
 * `RRULE` expansion (RFC 5545) for the rules calendars write for meetings: DAILY, WEEKLY (several
 * days with BYDAY), MONTHLY (BYMONTHDAY, or BYDAY with an ordinal such as `2TU` or `-1FR`) and a
 * plain YEARLY, with INTERVAL, COUNT, UNTIL and WKST. Instances are computed in wall time and
 * turned into instants by the caller, so a weekly 09:00 stays at 09:00 across a daylight saving change.
 */
export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

export interface RecurrenceRule {
  freq: RecurrenceFrequency
  interval: number
  count?: number
  /** Inclusive, epoch ms. */
  until?: number
  /** JavaScript weekdays (0 = Sunday), with an ordinal in a month (`2` = second, `-1` = last). */
  byDay: { weekday: number; ordinal?: number }[]
  byMonthDay: number[]
  weekStart: number
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const FREQUENCIES: readonly RecurrenceFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

/** Parses an `RRULE` value; null for a frequency it does not expand (hourly and below). `until` turns the UNTIL value into an instant. */
export function parseRrule(value: string, until: (raw: string) => number | null): RecurrenceRule | null {
  const parts = new Map<string, string>()
  for (const piece of value.split(';')) {
    const at = piece.indexOf('=')
    if (at > 0) parts.set(piece.slice(0, at).trim().toUpperCase(), piece.slice(at + 1).trim())
  }
  const freq = parts.get('FREQ')?.toUpperCase() as RecurrenceFrequency | undefined
  if (!freq || !FREQUENCIES.includes(freq)) return null
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1)
  const rule: RecurrenceRule = { freq, interval, byDay: [], byMonthDay: [], weekStart: WEEKDAYS[parts.get('WKST')?.toUpperCase() ?? 'MO'] ?? 1 }
  const count = Number.parseInt(parts.get('COUNT') ?? '', 10)
  if (Number.isFinite(count) && count > 0) rule.count = count
  const rawUntil = parts.get('UNTIL')
  if (rawUntil) {
    const u = until(rawUntil)
    if (u !== null) rule.until = u
  }
  for (const token of (parts.get('BYDAY') ?? '').split(',')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim())
    if (!m) continue
    const weekday = WEEKDAYS[m[2]!.toUpperCase()]!
    rule.byDay.push(m[1] ? { weekday, ordinal: Number.parseInt(m[1], 10) } : { weekday })
  }
  for (const token of (parts.get('BYMONTHDAY') ?? '').split(',')) {
    const n = Number.parseInt(token, 10)
    if (Number.isFinite(n) && n !== 0 && Math.abs(n) <= 31) rule.byMonthDay.push(n)
  }
  return rule
}

const DAY_MS = 86_400_000
const dayNumber = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS)
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7
function dateOf(day: number): { y: number; m: number; d: number } {
  const date = new Date(day * DAY_MS)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The candidate days (day numbers, ascending) of one period of the rule. */
function periodDays(rule: RecurrenceRule, start: WallTime, startDay: number, period: number): number[] {
  const weekdays = new Set(rule.byDay.map((b) => b.weekday))
  if (rule.freq === 'DAILY') {
    const day = startDay + period * rule.interval
    if (weekdays.size && !weekdays.has(weekdayOf(day))) return []
    if (rule.byMonthDay.length && !rule.byMonthDay.includes(dateOf(day).d)) return []
    return [day]
  }
  if (rule.freq === 'WEEKLY') {
    const weekBase = startDay - ((weekdayOf(startDay) - rule.weekStart + 7) % 7) + period * 7 * rule.interval
    const days = weekdays.size ? [...weekdays] : [weekdayOf(startDay)]
    return days.map((wd) => weekBase + ((wd - rule.weekStart + 7) % 7)).sort((a, b) => a - b)
  }
  if (rule.freq === 'YEARLY') {
    const y = start.y + period * rule.interval
    return start.d <= daysInMonth(y, start.m) ? [dayNumber(y, start.m, start.d)] : []
  }
  // MONTHLY
  const index = start.y * 12 + (start.m - 1) + period * rule.interval
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  const dim = daysInMonth(y, m)
  const days = new Set<number>()
  if (rule.byMonthDay.length) {
    for (const md of rule.byMonthDay) {
      const d = md > 0 ? md : dim + md + 1
      if (d >= 1 && d <= dim) days.add(d)
    }
  } else if (rule.byDay.length) {
    for (const { weekday, ordinal } of rule.byDay) {
      const matching: number[] = []
      for (let d = 1; d <= dim; d++) if (weekdayOf(dayNumber(y, m, d)) === weekday) matching.push(d)
      if (ordinal === undefined) matching.forEach((d) => days.add(d))
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal]
        if (pick !== undefined) days.add(pick)
      }
    }
  } else if (start.d <= dim) days.add(start.d)
  return [...days].sort((a, b) => a - b).map((d) => dayNumber(y, m, d))
}

/** Periods looked at, at most: a daily rule from years ago still ends. */
const MAX_PERIODS = 20_000

/**
 * The instances of a rule from its first one (DTSTART always counts as the first), in order, until
 * COUNT, UNTIL or an instance past `stopAfter` (epoch ms). `toEpoch` turns a wall time into an instant.
 */
export function expandRecurrence(rule: RecurrenceRule, start: WallTime, toEpoch: (wall: WallTime) => number, stopAfter: number): { wall: WallTime; epoch: number }[] {
  const out: { wall: WallTime; epoch: number }[] = []
  const startDay = dayNumber(start.y, start.m, start.d)
  const first = toEpoch(start)
  if (rule.until !== undefined && first > rule.until) return out
  out.push({ wall: start, epoch: first })
  if (first > stopAfter || rule.count === 1) return out
  for (let period = 0; period < MAX_PERIODS; period++) {
    for (const day of periodDays(rule, start, startDay, period)) {
      if (day <= startDay) continue
      const wall: WallTime = { ...dateOf(day), h: start.h, mi: start.mi, s: start.s }
      const epoch = toEpoch(wall)
      if (rule.until !== undefined && epoch > rule.until) return out
      out.push({ wall, epoch })
      if ((rule.count !== undefined && out.length >= rule.count) || epoch > stopAfter) return out
    }
  }
  return out
}
