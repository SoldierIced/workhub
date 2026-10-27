/**
 * Credits spent per day and per week, from the per-turn credits an agent's local session files
 * record (Kiro). Kiro does not expose the credits left or its plan limits locally, so spend is
 * the figure Workhub can show. Pure: the caller reads the files.
 */

/** Credits one turn used, and when it ended (epoch ms). */
export interface CreditEntry {
  at: number
  credits: number
}

export interface CreditDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  credits: number
}

export interface CreditSpend {
  /** Since local midnight. */
  today: number
  /** The last 7 local days, today included. */
  week: number
  /** The last 7 local days, oldest first, each with its total (0 when nothing was spent). */
  days: CreditDay[]
  /** Turns counted in `week`. */
  turns: number
}

const DAYS = 7

/** Local calendar day of a date, `YYYY-MM-DD`. */
export function localDayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Local midnight of the day `days` before `now`'s day. */
export function startOfLocalDay(now: number, daysBack = 0): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysBack)
  return d.getTime()
}

/** Today's and the last 7 days' spend. Entries in the future or with no positive credits are skipped. */
export function creditSpend(entries: readonly CreditEntry[], now: number): CreditSpend {
  const days: CreditDay[] = []
  for (let i = DAYS - 1; i >= 0; i--) days.push({ day: localDayKey(new Date(startOfLocalDay(now, i))), credits: 0 })
  const since = startOfLocalDay(now, DAYS - 1)
  const todayStart = startOfLocalDay(now)
  let today = 0
  let week = 0
  let turns = 0
  for (const e of entries) {
    if (!Number.isFinite(e.at) || !Number.isFinite(e.credits) || e.credits <= 0 || e.at < since || e.at > now) continue
    week += e.credits
    turns++
    if (e.at >= todayStart) today += e.credits
    const slot = days.find((d) => d.day === localDayKey(new Date(e.at)))
    if (slot) slot.credits += e.credits
  }
  return { today, week, days, turns }
}
