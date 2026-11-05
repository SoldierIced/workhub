/**
 * The lifecycle of metric alerts: one alert per series key. A detection opens an alert or updates
 * the open one (its severity only rises while open); an alert not detected for 3 business days
 * proposes to be resolved; a snooze lasts a while or until the trend changes; resolved alerts are
 * pruned after 7 days, unless their detection is still present (pruning it would reopen it as new).
 */
import { businessDaysAfter, localDay } from './days'
import { compareSeverity } from './rules'
import { DEFAULT_BUSINESS_DAYS, type AlertSeverity, type AlertStatus, type MetricAlert, type MetricDetection, type SnoozeUntil } from './types'

/** Business days without a detection after which an alert proposes to be resolved. */
export const PROPOSE_RESOLVE_AFTER_DAYS = 3
/** Resolved alerts stay listed this long (longer while their detection is still present). */
export const CLOSED_ALERT_LIFETIME_MS = 7 * 24 * 60 * 60_000

const DAY_MS = 24 * 60 * 60_000
export const SNOOZE_CHOICES = ['7d', '30d', 'trendChange'] as const
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number]

export const isOpenAlert = (a: Pick<MetricAlert, 'status'>): boolean => a.status !== 'resolved'

export interface ReconcileResult {
  alerts: MetricAlert[]
  /** Alerts opened by this evaluation (new keys, or a resolved key detected again on a later day). */
  opened: MetricAlert[]
  /** Open, not snoozed alerts whose severity rose, or snoozed "until the trend changes" ones that changed. */
  escalated: MetricAlert[]
}

const fromDetection = (d: MetricDetection): Omit<MetricAlert, 'status' | 'firstSeenDay'> => ({
  key: d.key,
  kind: d.kind,
  severity: d.severity,
  lastSeenDay: d.day,
  metric: d.metric,
  subject: d.subject,
  ...(d.segment ? { segment: d.segment } : {}),
  source: d.source,
  lastValue: d.value,
  baseline: d.baseline,
  ...(d.changePct !== undefined ? { changePct: d.changePct } : {}),
  ...(d.changePoints !== undefined ? { changePoints: d.changePoints } : {}),
  history: d.history.slice(-14),
  ...(d.link ? { link: d.link } : {}),
  ...(d.label ? { label: d.label } : {})
})

const maxSeverity = (a: AlertSeverity, b: AlertSeverity): AlertSeverity => (compareSeverity(a, b) >= 0 ? a : b)

/**
 * The next alert list for this evaluation's detections. Pure: `now` decides the day, snooze
 * expiry and pruning. `opened` and `escalated` are what may be announced.
 */
export function reconcileAlerts(previous: readonly MetricAlert[], detections: readonly MetricDetection[], now: number, businessDays: readonly number[] = DEFAULT_BUSINESS_DAYS): ReconcileResult {
  const today = localDay(now)
  const found = new Map(detections.map((d) => [d.key, d]))
  const opened: MetricAlert[] = []
  const escalated: MetricAlert[] = []
  const alerts: MetricAlert[] = []
  const seen = new Set<string>()

  for (const old of previous) {
    if (seen.has(old.key)) continue
    seen.add(old.key)
    const d = found.get(old.key)
    if (old.status === 'resolved') {
      // Detected again on a later day, or worse than when it was resolved: a fresh alert.
      if (d && (d.day > old.lastSeenDay || compareSeverity(d.severity, old.severity) > 0)) {
        const fresh: MetricAlert = { ...fromDetection(d), status: 'new', firstSeenDay: d.day }
        alerts.push(fresh)
        opened.push(fresh)
      } else if (d || old.closedAt === undefined || now - old.closedAt < CLOSED_ALERT_LIFETIME_MS) {
        // Still detected (same day, not worse): kept resolved, so the next evaluation does not
        // mistake it for a key never seen and open it again.
        alerts.push(old)
      }
      continue
    }
    let status: AlertStatus = old.status
    let snoozedUntil: SnoozeUntil | undefined = old.snoozedUntil
    if (status === 'snoozed' && typeof snoozedUntil === 'number' && now >= snoozedUntil) {
      status = 'new'
      snoozedUntil = undefined
    }
    if (!d) {
      const quiet = businessDaysAfter(old.lastSeenDay, today, businessDays)
      const next: MetricAlert = { ...old, status, proposeResolve: quiet >= PROPOSE_RESOLVE_AFTER_DAYS }
      if (snoozedUntil === undefined) delete next.snoozedUntil
      alerts.push(next)
      continue
    }
    const severity = maxSeverity(old.severity, d.severity)
    const rose = compareSeverity(severity, old.severity) > 0
    let announce = rose && status !== 'snoozed'
    if (status === 'snoozed' && snoozedUntil === 'trendChange' && (d.kind !== old.kind || rose)) {
      status = 'new'
      snoozedUntil = undefined
      announce = true
    }
    const next: MetricAlert = { ...old, ...fromDetection(d), severity, status, firstSeenDay: old.firstSeenDay, proposeResolve: false }
    if (snoozedUntil === undefined) delete next.snoozedUntil
    else next.snoozedUntil = snoozedUntil
    delete next.closedAt
    alerts.push(next)
    if (announce) escalated.push(next)
  }

  for (const d of detections) {
    if (seen.has(d.key)) continue
    seen.add(d.key)
    const fresh: MetricAlert = { ...fromDetection(d), status: 'new', firstSeenDay: d.day }
    alerts.push(fresh)
    opened.push(fresh)
  }
  return { alerts, opened, escalated }
}

/**
 * What a user can do to an alert. `sendToInbox` files a pending bug in Plan's inbox (the main
 * process creates the item; it never creates a ticket without approval) and tracks a new alert.
 */
export type MetricAlertAction = { type: 'track' } | { type: 'resolve' } | { type: 'snooze'; until: SnoozeChoice } | { type: 'reopen' } | { type: 'sendToInbox' }
export type MetricAlertActionType = MetricAlertAction['type']
export const METRIC_ALERT_ACTION_TYPES: readonly MetricAlertActionType[] = ['track', 'resolve', 'snooze', 'reopen', 'sendToInbox']

/** The actions an alert offers in its status, in display order; `inbox` adds "Send to inbox" (the profile has Plan on). */
export function availableAlertActions(alert: Pick<MetricAlert, 'status'>, options: { inbox?: boolean } = {}): MetricAlertActionType[] {
  const inbox: MetricAlertActionType[] = options.inbox && alert.status !== 'resolved' ? ['sendToInbox'] : []
  switch (alert.status) {
    case 'new':
      return ['track', ...inbox, 'snooze', 'resolve']
    case 'tracking':
      return [...inbox, 'snooze', 'resolve']
    case 'snoozed':
      return ['reopen', ...inbox, 'resolve']
    case 'resolved':
      return ['reopen']
  }
}

export function isAlertAction(value: unknown): value is MetricAlertAction {
  if (!value || typeof value !== 'object') return false
  const v = value as { type?: unknown; until?: unknown }
  if (v.type === 'snooze') return typeof v.until === 'string' && (SNOOZE_CHOICES as readonly string[]).includes(v.until)
  return v.type === 'track' || v.type === 'resolve' || v.type === 'reopen' || v.type === 'sendToInbox'
}

export function snoozeUntil(choice: SnoozeChoice, now: number): SnoozeUntil {
  return choice === 'trendChange' ? 'trendChange' : now + (choice === '7d' ? 7 : 30) * DAY_MS
}

/** Applies a user's action to the alert with `key`; the list is unchanged when there is none. */
export function applyAlertAction(alerts: readonly MetricAlert[], key: string, action: MetricAlertAction, now: number): MetricAlert[] {
  return alerts.map((a) => {
    if (a.key !== key) return a
    const { snoozedUntil: _s, closedAt: _c, ...rest } = a
    switch (action.type) {
      case 'track':
        return { ...rest, status: 'tracking' }
      case 'resolve':
        return { ...rest, status: 'resolved', proposeResolve: false, closedAt: now }
      case 'snooze':
        return { ...rest, status: 'snoozed', snoozedUntil: snoozeUntil(action.until, now) }
      case 'reopen':
        return { ...rest, status: 'tracking', proposeResolve: false }
      case 'sendToInbox':
        return a.status === 'new' ? { ...rest, status: 'tracking' } : a
    }
  })
}

const SEVERITY_SORT: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 }

/** Highest severity first, then the most recently seen, then the oldest opened. */
export function sortAlerts(alerts: readonly MetricAlert[]): MetricAlert[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_SORT[a.severity] - SEVERITY_SORT[b.severity] ||
      (a.lastSeenDay < b.lastSeenDay ? 1 : a.lastSeenDay > b.lastSeenDay ? -1 : 0) ||
      (a.firstSeenDay < b.firstSeenDay ? -1 : a.firstSeenDay > b.firstSeenDay ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )
}
