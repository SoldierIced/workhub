import type { WallTime } from './timezone'

/**
 * `RRULE` expansion (RFC 5545) for the rules calendars write for meetings: DAILY, WEEKLY (several
 * days with BYDAY), MONTHLY (BYMONTHDAY, or BYDAY with an ordinal such as `2TU` or `-1FR`) and
 * YEARLY (on DTSTART's date, or on BYMONTH months with BYMONTHDAY or BYDAY), with INTERVAL, COUNT,
 * UNTIL, WKST, BYMONTH (a filter for the other frequencies) and BYSETPOS (positions in each
 * period's sorted candidates). A rule with any other part is not expanded: only DTSTART is shown,
 * rather than a wrong series. Instances are computed in wall time and turned into instants by the
 * caller, so a weekly 09:00 stays at 09:00 across a daylight saving change.
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
  /** Months 1-12; empty for every month. */
  byMonth: number[]
  /** 1-based positions in each period's sorted candidates, negative from the end; empty for all. */
  bySetPos: number[]
  weekStart: number
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const FREQUENCIES: readonly RecurrenceFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS'])

/** Integers of a comma list within `[-max, max]`, zero excluded (and negatives unless allowed); null when any is invalid. */
function intList(raw: string | undefined, max: number, negative: boolean): number[] | null {
  if (raw === undefined) return []
  const out: number[] = []
  for (const token of raw.split(',')) {
    const t = token.trim()
    if (!/^[+-]?\d{1,3}$/.test(t)) return null
    const n = Number.parseInt(t, 10)
    if (n === 0 || Math.abs(n) > max || (!negative && n < 0)) return null
    out.push(n)
  }
  return out
}

/**
 * Parses an `RRULE` value; null for a rule it does not expand (hourly and below, a part it does
 * not know, or a combination it cannot honour), which callers show as DTSTART only. `until`
 * turns the UNTIL value into an instant.
 */
export function parseRrule(value: string, until: (raw: string) => number | null): RecurrenceRule | null {
  const parts = new Map<string, string>()
  for (const piece of value.split(';')) {
    const at = piece.indexOf('=')
    if (at > 0) parts.set(piece.slice(0, at).trim().toUpperCase(), piece.slice(at + 1).trim())
  }
  const freq = parts.get('FREQ')?.toUpperCase() as RecurrenceFrequency | undefined
  if (!freq || !FREQUENCIES.includes(freq)) return null
  for (const key of parts.keys()) if (!SUPPORTED_PARTS.has(key)) return null
  const byMonth = intList(parts.get('BYMONTH'), 12, false)
  const bySetPos = intList(parts.get('BYSETPOS'), 366, true)
  if (!byMonth || !bySetPos) return null
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1)
  const rule: RecurrenceRule = { freq, interval, byDay: [], byMonthDay: [], byMonth, bySetPos, weekStart: WEEKDAYS[parts.get('WKST')?.toUpperCase() ?? 'MO'] ?? 1 }
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
  // A yearly BYDAY or BYMONTHDAY without BYMONTH counts within the whole year: not expanded.
  if (freq === 'YEARLY' && !byMonth.length && (rule.byDay.length || rule.byMonthDay.length)) return null
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

/** The days (1-31, ascending) of one month that BYMONTHDAY and BYDAY select; `fallback` when neither is set. */
function monthDays(rule: RecurrenceRule, y: number, m: number, fallback: number): number[] {
  const dim = daysInMonth(y, m)
  let byMonthDay: Set<number> | null = null
  if (rule.byMonthDay.length) {
    byMonthDay = new Set<number>()
    for (const md of rule.byMonthDay) {
      const d = md > 0 ? md : dim + md + 1
      if (d >= 1 && d <= dim) byMonthDay.add(d)
    }
  }
  let byDay: Set<number> | null = null
  if (rule.byDay.length) {
    byDay = new Set<number>()
    for (const { weekday, ordinal } of rule.byDay) {
      const matching: number[] = []
      for (let d = 1; d <= dim; d++) if (weekdayOf(dayNumber(y, m, d)) === weekday) matching.push(d)
      if (ordinal === undefined) matching.forEach((d) => byDay!.add(d))
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal]
        if (pick !== undefined) byDay.add(pick)
      }
    }
  }
  // Both set: a day must match both (RFC 5545 makes BYDAY limit BYMONTHDAY here).
  const days = byMonthDay && byDay ? [...byMonthDay].filter((d) => byDay!.has(d)) : [...(byMonthDay ?? byDay ?? (fallback <= dim ? [fallback] : []))]
  return days.sort((a, b) => a - b)
}

/** The candidate days (day numbers, ascending) of one period of the rule, before BYSETPOS. */
function periodCandidates(rule: RecurrenceRule, start: WallTime, startDay: number, period: number): number[] {
  const weekdays = new Set(rule.byDay.map((b) => b.weekday))
  const inMonths = (day: number) => !rule.byMonth.length || rule.byMonth.includes(dateOf(day).m)
  if (rule.freq === 'DAILY') {
    const day = startDay + period * rule.interval
    if (weekdays.size && !weekdays.has(weekdayOf(day))) return []
    if (rule.byMonthDay.length && !rule.byMonthDay.includes(dateOf(day).d)) return []
    return inMonths(day) ? [day] : []
  }
  if (rule.freq === 'WEEKLY') {
    const weekBase = startDay - ((weekdayOf(startDay) - rule.weekStart + 7) % 7) + period * 7 * rule.interval
    const days = weekdays.size ? [...weekdays] : [weekdayOf(startDay)]
    return days.map((wd) => weekBase + ((wd - rule.weekStart + 7) % 7)).filter(inMonths).sort((a, b) => a - b)
  }
  if (rule.freq === 'YEARLY') {
    const y = start.y + period * rule.interval
    if (!rule.byMonth.length) return start.d <= daysInMonth(y, start.m) ? [dayNumber(y, start.m, start.d)] : []
    return [...rule.byMonth].sort((a, b) => a - b).flatMap((m) => monthDays(rule, y, m, start.d).map((d) => dayNumber(y, m, d)))
  }
  // MONTHLY
  const index = start.y * 12 + (start.m - 1) + period * rule.interval
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  if (rule.byMonth.length && !rule.byMonth.includes(m)) return []
  return monthDays(rule, y, m, start.d).map((d) => dayNumber(y, m, d))
}

/** The days of one period of the rule (day numbers, ascending), with BYSETPOS applied. */
function periodDays(rule: RecurrenceRule, start: WallTime, startDay: number, period: number): number[] {
  const days = periodCandidates(rule, start, startDay, period)
  if (!rule.bySetPos.length) return days
  const picked = new Set<number>()
  for (const pos of rule.bySetPos) {
    const day = pos > 0 ? days[pos - 1] : days[days.length + pos]
    if (day !== undefined) picked.add(day)
  }
  return [...picked].sort((a, b) => a - b)
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
