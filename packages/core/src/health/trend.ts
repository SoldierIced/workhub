import type { TrendStats } from './types'

/** The upper median of the values (0 when there are none). */
export function median(values: number[]): number {
  if (values.length === 0) return 0
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
}

/** Consecutive days, ending with the last one, that had activity. */
export function trailingStreak(series: number[]): number {
  let streak = 0
  for (let i = series.length - 1; i >= 0 && (series[i] ?? 0) > 0; i--) streak++
  return streak
}

/**
 * Verdict for one key from its daily series (oldest first, today last and partial) and its count
 * in the rolling window. A key with nothing in the rolling window is dropped (null). `new`: active
 * for a day or less; `worsening`: the rolling count is over twice a typical day; `chronic`: a week
 * or more of activity; `ongoing` otherwise.
 */
export function trendStats(series: number[], recent: number): TrendStats | null {
  if (recent <= 0) return null
  const typicalDay = median(series.slice(0, -1).filter((n) => n > 0))
  const streakDays = trailingStreak(series)
  const state = streakDays <= 1 ? 'new' : typicalDay > 0 && recent > typicalDay * 2 ? 'worsening' : streakDays >= 7 ? 'chronic' : 'ongoing'
  return { recent, typicalDay, streakDays, streakTruncated: streakDays >= series.length, daysWithData: series.length, state }
}
