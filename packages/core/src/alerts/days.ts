/** Local calendar days as `YYYY-MM-DD` strings, and business days. Day arithmetic runs in UTC so daylight saving never skips or repeats a day. */

const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const pad = (n: number) => String(n).padStart(2, '0')

export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DAY_RE.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** The local day of an instant. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const utc = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

export function addDays(day: string, n: number): string {
  const d = new Date(utc(day) + n * DAY_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS)
}

/** 0 Sunday to 6 Saturday. */
export function weekdayOf(day: string): number {
  return new Date(utc(day)).getUTCDay()
}

export function isBusinessDay(day: string, businessDays: readonly number[]): boolean {
  return businessDays.includes(weekdayOf(day))
}

/** The latest business day on or before `day`; `day` itself when no business day is configured. */
export function lastBusinessDay(day: string, businessDays: readonly number[]): string {
  if (businessDays.length === 0) return day
  let d = day
  for (let i = 0; i < 7 && !isBusinessDay(d, businessDays); i++) d = addDays(d, -1)
  return d
}

/** Business days strictly after `from` up to and including `to`. */
export function businessDaysAfter(from: string, to: string, businessDays: readonly number[]): number {
  let count = 0
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (businessDays.length === 0 || isBusinessDay(d, businessDays)) count++
  return count
}
