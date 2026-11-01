import { addDays, isBusinessDay, localDay } from '../alerts/days'
import { DEMO_METRICS, demoMetricSamples } from '../alerts/demo'
import { applyAlertAction, reconcileAlerts } from '../alerts/lifecycle'
import { mergeSamples } from '../alerts/series'
import { detectMetricAlerts } from '../alerts/rules'
import { DEFAULT_ALERT_RULES, DEFAULT_BUSINESS_DAYS, type MetricAlert, type MetricDefinition, type MetricSample, type MetricSeriesStore } from '../alerts/types'

/** The id of the scenario's product analytics source. */
export const PRODUCT_METRIC_SOURCE = 'analytics'

const ANALYTICS = 'https://analytics.example.com'
const SEGMENT = 'All platforms'
const FUNNEL = 'Signup funnel'

export const PRODUCT_METRICS: readonly MetricDefinition[] = [
  { id: 'funnel.signupVerify', label: 'Sign up → verify email', source: PRODUCT_METRIC_SOURCE, direction: 'downIsBad', kind: 'rate', link: `${ANALYTICS}/funnels/signup?step=signup-verify` },
  { id: 'funnel.verifyWorkspace', label: 'Verify email → create workspace', source: PRODUCT_METRIC_SOURCE, direction: 'downIsBad', kind: 'rate', link: `${ANALYTICS}/funnels/signup?step=verify-workspace` },
  { id: 'funnel.workspaceInvite', label: 'Create workspace → invite a teammate', source: PRODUCT_METRIC_SOURCE, direction: 'downIsBad', kind: 'rate', link: `${ANALYTICS}/funnels/signup?step=workspace-invite` },
  { id: 'funnel.inviteTrial', label: 'Invite a teammate → start trial', source: PRODUCT_METRIC_SOURCE, direction: 'downIsBad', kind: 'rate', link: `${ANALYTICS}/funnels/signup?step=invite-trial` },
  { id: 'cancellations.byReason', label: 'Cancellations by reason', source: PRODUCT_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', link: `${ANALYTICS}/dashboards/cancellation-reasons` },
  { id: 'frontend.errors', label: 'Front-end errors', source: PRODUCT_METRIC_SOURCE, direction: 'upIsBad', kind: 'count', link: `${ANALYTICS}/dashboards/frontend-errors` },
  { id: 'events.workspaceCreated', label: 'Key event: workspace_created', source: PRODUCT_METRIC_SOURCE, direction: 'downIsBad', kind: 'count', expectDaily: true, link: `${ANALYTICS}/events/workspace_created` }
]

/** Subjects of the scenario's alerts, by the story they tell. */
export const PRODUCT_SUBJECTS = {
  sustainedReason: 'Too many bugs',
  jumpReason: 'Billing confusion',
  newReason: 'Missing calendar integration',
  risingError: 'editor_save_failed',
  quietError: 'mobile_sync_timeout',
  missingEvent: 'web'
} as const

const DEMO_DAYS = 30

/** A small deterministic wobble per day and subject. */
function wobble(day: string, subject: string, size: number): number {
  let h = 0
  for (const c of `${day}|${subject}`) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ((h % 1000) / 1000 - 0.5) * 2 * size
}

/**
 * 30 days of made-up product metrics shaped so each story shows once. Day `bi` 0 is the latest
 * business day on or before today; deterministic per day, nothing real.
 */
export function productMetricSamples(now: number, businessDays: readonly number[] = DEFAULT_BUSINESS_DAYS): MetricSample[] {
  const today = localDay(now)
  const out: MetricSample[] = []
  const noon = (day: string) => {
    const [y, m, d] = day.split('-').map(Number)
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12).getTime()
  }
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
    const weekend = bi < 0
    const push = (metric: string, subject: string, value: number, extra: Partial<MetricSample> = {}) =>
      out.push({ metric, subject, day, value: Math.max(0, Math.round(value * 10) / 10), source: PRODUCT_METRIC_SOURCE, at, ...extra })
    // Funnel: a rate per step with its volume. The workspace step falls 12 points on the latest day
    // (high); the invite step falls 7 points (medium); the others stay flat.
    const step = (metric: string, level: number, drop: number) =>
      push(metric, FUNNEL, level + wobble(day, metric, 0.5) - (bi === 0 ? drop : 0), { segment: SEGMENT, base: weekend ? 260 : 900 })
    step('funnel.signupVerify', 88, 0)
    step('funnel.verifyWorkspace', 71, 12)
    step('funnel.workspaceInvite', 46, 7)
    step('funnel.inviteTrial', 34, 0)
    // Cancellations by reason (counts).
    const reason = (subject: string, value: number) => push('cancellations.byReason', subject, value)
    reason('Too expensive', 120 + wobble(day, 'Too expensive', 5))
    reason('Switched to another tool', 85 + wobble(day, 'Switched to another tool', 4))
    // A steady climb over the last four business days (sustained trend).
    const climb: Record<number, number> = { 0: 54, 1: 50, 2: 46, 3: 42 }
    reason(PRODUCT_SUBJECTS.sustainedReason, climb[bi] ?? 40 + wobble(day, 'bugs', 1))
    // More than doubles on the latest business day (jump).
    reason(PRODUCT_SUBJECTS.jumpReason, bi === 0 ? 75 : 30 + wobble(day, 'billing', 2))
    // First seen on the latest business day (new subject).
    if (bi === 0) reason(PRODUCT_SUBJECTS.newReason, 34)
    // Front-end errors: one rising, one quiet since it was fixed.
    push('frontend.errors', PRODUCT_SUBJECTS.risingError, bi === 0 ? 48 : 25 + wobble(day, 'save', 2))
    push('frontend.errors', 'signup_validation_failed', 30 + wobble(day, 'signup', 2))
    push('frontend.errors', PRODUCT_SUBJECTS.quietError, 30 + wobble(day, 'sync', 2))
    // Key event: iOS reports every day; web stopped reporting two days ago (missing data).
    push('events.workspaceCreated', 'ios', (weekend ? 40 : 90) + wobble(day, 'ios', 5))
    if (day <= addDays(today, -2)) push('events.workspaceCreated', PRODUCT_SUBJECTS.missingEvent, (weekend ? 50 : 110) + wobble(day, 'web', 6))
  }
  return out
}

/** Every definition of the Health demo: the Elastic-style signals and the scenario's product metrics. */
export const PRODUCT_ALL_METRICS: readonly MetricDefinition[] = [...DEMO_METRICS, ...PRODUCT_METRICS]

export interface ProductMetricState {
  series: MetricSeriesStore
  alerts: MetricAlert[]
  updatedAt: number
}

/** What the first evaluation would do to each alert the user already handled, by series key. */
const keyOf = (metric: string, subject: string, segment = '') => `${PRODUCT_METRIC_SOURCE}|${metric}|${subject}|${segment}`

export const PRODUCT_ALERT_KEYS = {
  workspaceDrop: keyOf('funnel.verifyWorkspace', FUNNEL, SEGMENT),
  inviteDrop: keyOf('funnel.workspaceInvite', FUNNEL, SEGMENT),
  sustainedReason: keyOf('cancellations.byReason', PRODUCT_SUBJECTS.sustainedReason),
  jumpReason: keyOf('cancellations.byReason', PRODUCT_SUBJECTS.jumpReason),
  newReason: keyOf('cancellations.byReason', PRODUCT_SUBJECTS.newReason),
  risingError: keyOf('frontend.errors', PRODUCT_SUBJECTS.risingError),
  quietError: keyOf('frontend.errors', PRODUCT_SUBJECTS.quietError),
  missingEvent: keyOf('events.workspaceCreated', PRODUCT_SUBJECTS.missingEvent)
} as const

/**
 * The series and alerts the Health demo starts with, so the Alerts tab is populated at once:
 * the rules run over the history, then a few alerts get the state a user would have left them in
 * (tracking, snoozed) and an old one that went quiet proposes to be resolved.
 */
export function productMetricState(now: number, businessDays: readonly number[] = DEFAULT_BUSINESS_DAYS): ProductMetricState {
  const rules = { ...DEFAULT_ALERT_RULES, businessDays: [...businessDays] }
  const samples = [...demoMetricSamples(now, businessDays), ...productMetricSamples(now, businessDays)]
  const series = mergeSamples({}, samples, now)
  const detections = detectMetricAlerts(series, PRODUCT_ALL_METRICS, rules, now)
  const today = localDay(now)
  // An alert from last week on a metric that has been fine since: it proposes to be resolved.
  const old: MetricAlert = {
    key: PRODUCT_ALERT_KEYS.quietError,
    kind: 'jump',
    severity: 'medium',
    status: 'tracking',
    firstSeenDay: addDays(today, -10),
    lastSeenDay: addDays(today, -7),
    metric: 'frontend.errors',
    subject: PRODUCT_SUBJECTS.quietError,
    source: PRODUCT_METRIC_SOURCE,
    lastValue: 61,
    baseline: 30,
    changePct: 103.3,
    history: Array.from({ length: 8 }, (_, i) => ({ day: addDays(today, -14 + i), value: i < 4 ? 30 : 61 - (i - 4) * 8 })),
    link: `${ANALYTICS}/dashboards/frontend-errors`,
    label: 'Front-end errors'
  }
  let alerts = reconcileAlerts([old], detections, now, businessDays).alerts
  alerts = applyAlertAction(alerts, PRODUCT_ALERT_KEYS.workspaceDrop, { type: 'track' }, now)
  alerts = applyAlertAction(alerts, PRODUCT_ALERT_KEYS.risingError, { type: 'track' }, now)
  alerts = applyAlertAction(alerts, PRODUCT_ALERT_KEYS.jumpReason, { type: 'snooze', until: '7d' }, now)
  return { series, alerts, updatedAt: now }
}
