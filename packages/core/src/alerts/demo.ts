/**
 * Synthetic metric history for the Health demo (WORKHUB_DEMO_HEALTH=1): 30 days of made-up
 * product metrics shaped so each rule shows up once. Deterministic per day, nothing real.
 */
import { addDays, isBusinessDay, localDay } from './days'
import { DEFAULT_BUSINESS_DAYS, type MetricDefinition, type MetricSample } from './types'

export const DEMO_METRIC_SOURCE = 'demo'

export const DEMO_METRICS: readonly MetricDefinition[] = [
  { id: 'demo.paymentErrors', label: 'Payment errors', source: DEMO_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', absentIsZero: true, link: 'https://dashboards.example.test/payments' },
  { id: 'demo.checkoutConversion', label: 'Checkout conversion', source: DEMO_METRIC_SOURCE, direction: 'downIsBad', kind: 'rate' },
  { id: 'demo.signups', label: 'Sign-ups', source: DEMO_METRIC_SOURCE, direction: 'downIsBad', kind: 'count', expectDaily: true }
]

const DEMO_DAYS = 30

/** A small deterministic wobble per day and subject. */
function wobble(day: string, subject: string, size: number): number {
  let h = 0
  for (const c of `${day}|${subject}`) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ((h % 1000) / 1000 - 0.5) * 2 * size
}

/** The demo samples at `now`; business day 0 is the latest business day on or before today. */
export function demoMetricSamples(now: number, businessDays: readonly number[] = DEFAULT_BUSINESS_DAYS): MetricSample[] {
  const today = localDay(now)
  const out: MetricSample[] = []
  const noon = (day: string) => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime()
  }
  // Business-day index of each day, counting back from the latest business day.
  let index = -1
  const days: { day: string; bi: number }[] = []
  for (let back = 0; back < DEMO_DAYS; back++) {
    const day = addDays(today, -back)
    const business = businessDays.length === 0 || isBusinessDay(day, businessDays)
    if (business) index++
    days.push({ day, bi: business ? index : -1 })
  }
  for (const { day, bi } of days) {
    const at = day === today ? now : noon(day)
    const push = (metric: string, subject: string, value: number, extra: Partial<MetricSample> = {}) =>
      out.push({ metric, subject, segment: 'Production', day, value: Math.max(0, Math.round(value * 10) / 10), source: DEMO_METRIC_SOURCE, at, ...extra })
    const weekend = bi < 0
    // A jump on the latest business day: about 40 a day, then 130.
    push('demo.paymentErrors', 'checkout-api', bi === 0 ? 130 : 40 + wobble(day, 'checkout-api', 4))
    // A sustained rise over the last three business days.
    const rise: Record<number, number> = { 0: 53, 1: 48, 2: 44, 3: 41 }
    push('demo.paymentErrors', 'billing-api', rise[bi] ?? 40 + wobble(day, 'billing-api', 1))
    // A subject first seen on the latest business day.
    if (bi === 0) push('demo.paymentErrors', 'notifications-worker', 35)
    // Conversion falls 8 points on the latest business day.
    push('demo.checkoutConversion', 'web', bi === 0 ? 24 : 32 + wobble(day, 'web', 0.6), { base: weekend ? 300 : 800 })
    // Steady sign-ups on the web; the mobile feed stopped two days ago.
    push('demo.signups', 'web', (weekend ? 120 : 220) + wobble(day, 'signups-web', 10))
    if (day <= addDays(today, -2)) push('demo.signups', 'mobile', (weekend ? 60 : 110) + wobble(day, 'signups-mobile', 6))
  }
  return out
}
