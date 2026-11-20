// How the Plan screens write dates the planner stores as "YYYY-MM-DD".

/** A day as a local date, or null when the text is not one. */
function localDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/**
 * "Aug 26" for a day of the current year, "Aug 26, 2027" for any other; text that is not a day is
 * returned as it came. `format` is the screen's date formatter (its language).
 */
export function shortDay(day: string, now: number, format: (date: number, options: Intl.DateTimeFormatOptions) => string): string {
  const d = localDay(day)
  if (!d) return day
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return format(d.getTime(), sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}
