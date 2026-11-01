/**
 * Metric alerts: a source-agnostic engine that turns daily metric values into alerts with a
 * lifecycle. A source (Health's Elastic signals today; product analytics, campaign tools or
 * Prometheus later) only reports samples and describes its metrics; the rules and the lifecycle
 * never know where a number came from.
 */

/** One value of one metric for one subject on one local day. */
export interface MetricSample {
  /** `MetricDefinition.id`. */
  metric: string
  /** What the value is about: a service, a container, a campaign, a page. */
  subject: string
  /** An optional split of the subject: an environment, a platform, a country. */
  segment?: string
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  /** A count, or for a rate metric a percentage from 0 to 100. */
  value: number
  /** Denominator of a rate (sessions, calls); the volume floor applies to it. */
  base?: number
  /** The source id (`MetricSource.id`). */
  source: string
  /** When the value was measured (epoch ms); defaults to the moment it was collected. */
  at?: number
  /** A deep link for this subject (a dashboard, a Kibana page). */
  link?: string
}

export type MetricDirection = 'upIsBad' | 'downIsBad'
export type MetricKind = 'count' | 'rate'

/** What a source says about one of its metrics. */
export interface MetricDefinition {
  id: string
  /** A readable name, in English; the UI may translate known ids. */
  label: string
  source: string
  direction: MetricDirection
  kind: MetricKind
  /** A link for the metric as a whole, used when a sample brings none. */
  link?: string
  /** Every alert on this metric is high severity (except the low "near threshold" and missing data ones). */
  critical?: boolean
  /** A day without a sample means zero (an error count that only lists services with errors). */
  absentIsZero?: boolean
  /** A sample is expected every business day: a gap of more than a day is itself an alert. */
  expectDaily?: boolean
}

/** One stored day of a series. */
export interface DailyPoint {
  day: string
  value: number
  base?: number
}

/** The stored history of one key (`source|metric|subject|segment`), oldest day first. */
export interface MetricSeries {
  key: string
  source: string
  metric: string
  subject: string
  segment?: string
  points: DailyPoint[]
  /** Epoch ms of the newest sample merged. */
  lastSampleAt?: number
  link?: string
}

export type MetricSeriesStore = Record<string, MetricSeries>

export const ALERT_RULE_KINDS = ['jump', 'rateDrop', 'sustainedTrend', 'newSubject', 'missingData'] as const
export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number]

export const ALERT_SEVERITIES = ['high', 'medium', 'low'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_STATUSES = ['new', 'tracking', 'snoozed', 'resolved'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

/** The tunable limits of the rules. */
export interface AlertThresholds {
  /** Sustained trend: business days in a row the metric moves the bad way. */
  trendDays: number
  /** Sustained trend: and the last day is this much (%) worse than the previous 7 business days. */
  trendPct: number
  /** Jump: the last day is this much (%) worse than the previous 7 business days... */
  jumpPct: number
  /** ...or this many standard deviations away. */
  jumpStdDevs: number
  /** Nothing alerts below this daily volume (the value of a count, the base of a rate). */
  minVolume: number
  /** New subject: first appearance in this many days. */
  newSubjectDays: number
  /** Rate drop: points (of 100) worse than the previous 7 business days. */
  rateDropPoints: number
}

/** Per metric id: thresholds that differ from the defaults, and whether it is critical or muted. */
export interface MetricRuleOverride extends Partial<AlertThresholds> {
  critical?: boolean
  muted?: boolean
}

/** The rule setup of a profile (`profiles[].health.alertRules`). */
export interface AlertRulesConfig {
  thresholds: AlertThresholds
  /** Days of the week the rules count (0 Sunday to 6 Saturday). */
  businessDays: number[]
  /** Only newly opened or escalated alerts of at least this severity notify. */
  notifyMinSeverity: AlertSeverity
  overrides: Record<string, MetricRuleOverride>
}

export const DEFAULT_METRIC_ALERT_THRESHOLDS: AlertThresholds = {
  trendDays: 3,
  trendPct: 20,
  jumpPct: 50,
  jumpStdDevs: 2,
  minVolume: 20,
  newSubjectDays: 30,
  rateDropPoints: 5
}

/** Allowed range of each threshold; the settings form and the config schema clamp to it. */
export const METRIC_ALERT_THRESHOLD_RANGES: Record<keyof AlertThresholds, readonly [number, number]> = {
  trendDays: [2, 10],
  trendPct: [1, 1000],
  jumpPct: [1, 1000],
  jumpStdDevs: [0.5, 10],
  minVolume: [0, 1_000_000_000],
  newSubjectDays: [7, 44],
  rateDropPoints: [0.5, 100]
}

export const DEFAULT_BUSINESS_DAYS: readonly number[] = [1, 2, 3, 4, 5]

export const DEFAULT_ALERT_RULES: AlertRulesConfig = {
  thresholds: DEFAULT_METRIC_ALERT_THRESHOLDS,
  businessDays: [...DEFAULT_BUSINESS_DAYS],
  notifyMinSeverity: 'high',
  overrides: {}
}

/** What the rules found for one key on one evaluation. */
export interface MetricDetection {
  key: string
  kind: AlertRuleKind
  severity: AlertSeverity
  source: string
  metric: string
  subject: string
  segment?: string
  /** The day the value belongs to. */
  day: string
  value: number
  /** The previous-7-business-day average (0 for a new subject). */
  baseline: number
  changePct?: number
  changePoints?: number
  /** Last 14 days, oldest first. */
  history: { day: string; value: number }[]
  label?: string
  link?: string
}

/** Snooze for a while, or until the alert changes rule kind or severity rises. */
export type SnoozeUntil = number | 'trendChange'

export interface MetricAlert {
  /** The series key: one alert per key. */
  key: string
  kind: AlertRuleKind
  severity: AlertSeverity
  status: AlertStatus
  snoozedUntil?: SnoozeUntil
  firstSeenDay: string
  lastSeenDay: string
  metric: string
  subject: string
  segment?: string
  source: string
  lastValue: number
  baseline: number
  changePct?: number
  changePoints?: number
  /** Last 14 days, oldest first. */
  history: { day: string; value: number }[]
  /** Not detected for 3 business days: the UI offers to resolve it. */
  proposeResolve?: boolean
  link?: string
  /** The metric's label, kept so the list needs no definition. */
  label?: string
  /** When it was resolved (epoch ms); resolved alerts are pruned 7 days later. */
  closedAt?: number
}
