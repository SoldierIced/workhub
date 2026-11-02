/**
 * Wall-clock times in a named time zone, converted with `Intl.DateTimeFormat` only (no time zone
 * library). Calendars name zones by IANA id (Google, iCloud) or by Windows name (Outlook).
 */

/** A date and time as a clock shows it, months 1-12. */
export interface WallTime {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

/** Windows zone names Outlook writes as `TZID`, mapped to their IANA ids (the common ones). */
const WINDOWS_ZONES: Record<string, string> = {
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'SA Pacific Standard Time': 'America/Bogota',
  'Pacific SA Standard Time': 'America/Santiago',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai'
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

/** The IANA id behind a calendar's `TZID` (a leading `/`, Windows names), or the id as given. */
export function resolveTimeZone(tzid: string): string {
  const trimmed = tzid.trim().replace(/^"|"$/g, '').replace(/^\/+/, '')
  return WINDOWS_ZONES[trimmed] ?? trimmed
}

function formatterOf(zone: string): Intl.DateTimeFormat | null {
  if (formatters.has(zone)) return formatters.get(zone)!
  let made: Intl.DateTimeFormat | null
  try {
    made = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
  } catch {
    made = null
  }
  formatters.set(zone, made)
  return made
}

/** Whether `Intl` knows the zone (after `resolveTimeZone`). */
export function isKnownTimeZone(tzid: string): boolean {
  return formatterOf(resolveTimeZone(tzid)) !== null
}

/** The wall time in `zone` at an instant. */
function wallAt(format: Intl.DateTimeFormat, instant: number): WallTime {
  const parts: Record<string, number> = {}
  for (const p of format.formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  return { y: parts['year'] ?? 1970, m: parts['month'] ?? 1, d: parts['day'] ?? 1, h: (parts['hour'] ?? 0) % 24, mi: parts['minute'] ?? 0, s: parts['second'] ?? 0 }
}

const utcOf = (w: WallTime) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s)

/**
 * The instant a wall time in a zone names; null when the zone is unknown. The zone's offset is
 * looked up at a guess and the guess corrected until it holds, which settles across a daylight
 * saving change (a time skipped by the change lands just after it).
 */
export function zonedTimeToEpoch(wall: WallTime, tzid: string): number | null {
  const format = formatterOf(resolveTimeZone(tzid))
  if (!format) return null
  const target = utcOf(wall)
  const offsetAt = (instant: number) => utcOf(wallAt(format, instant)) - Math.floor(instant / 1000) * 1000
  let guess = target - offsetAt(target)
  for (let i = 0; i < 4; i++) {
    const next = target - offsetAt(guess)
    if (next === guess) break
    guess = next
  }
  return guess
}

/** The instant of a floating wall time: the machine's own time zone. */
export function localTimeToEpoch(wall: WallTime): number {
  return new Date(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s).getTime()
}
