import { ALERT_RULE_KINDS, ALERT_SEVERITIES, ALERT_STATUSES, alertRulesOf, type AlertRuleKind, type AlertRulesConfig, type AlertSeverity, type AlertStatus, type AlertThresholds, type MetricAlert, type MetricRuleOverride } from '@workhub/core'
import type { Tone } from '../components/atoms'
import { DICTIONARIES, type MessageKey } from '../i18n/translate'

export const SEVERITY_TONE: Record<AlertSeverity, Tone> = { high: 'danger', medium: 'warning', low: 'info' }
export const SEVERITY_LABEL: Record<AlertSeverity, MessageKey> = { high: 'metricAlerts.severity.high', medium: 'metricAlerts.severity.medium', low: 'metricAlerts.severity.low' }
export const KIND_LABEL: Record<AlertRuleKind, MessageKey> = {
  jump: 'metricAlerts.kind.jump',
  rateDrop: 'metricAlerts.kind.rateDrop',
  sustainedTrend: 'metricAlerts.kind.sustainedTrend',
  newSubject: 'metricAlerts.kind.newSubject',
  missingData: 'metricAlerts.kind.missingData'
}
export const STATUS_LABEL: Record<AlertStatus, MessageKey> = { new: 'metricAlerts.status.new', tracking: 'metricAlerts.status.tracking', snoozed: 'metricAlerts.status.snoozed', resolved: 'metricAlerts.status.resolved' }

/** `open` is every alert not resolved; `all` is everything. */
export type StatusFilter = AlertStatus | 'open' | 'all'
export interface AlertFilters {
  kind: AlertRuleKind | 'all'
  severity: AlertSeverity | 'all'
  status: StatusFilter
}
export const DEFAULT_ALERT_FILTERS: AlertFilters = { kind: 'all', severity: 'all', status: 'open' }
export const KIND_FILTERS: readonly (AlertRuleKind | 'all')[] = ['all', ...ALERT_RULE_KINDS]
export const SEVERITY_FILTERS: readonly (AlertSeverity | 'all')[] = ['all', ...ALERT_SEVERITIES]
export const STATUS_FILTERS: readonly StatusFilter[] = ['open', ...ALERT_STATUSES, 'all']

export function filterAlerts(alerts: readonly MetricAlert[], f: AlertFilters): MetricAlert[] {
  return alerts.filter(
    (a) =>
      (f.kind === 'all' || a.kind === f.kind) &&
      (f.severity === 'all' || a.severity === f.severity) &&
      (f.status === 'all' || (f.status === 'open' ? a.status !== 'resolved' : a.status === f.status))
  )
}

/** Alerts not resolved: what Home counts. */
export const openAlerts = (alerts: readonly MetricAlert[]) => alerts.filter((a) => a.status !== 'resolved')

/** The change of an alert as short text: `+62%`, `−8 pts`; null when there is none (new subject, missing data). */
export function changeText(alert: Pick<MetricAlert, 'changePct' | 'changePoints'>, points: string): string | null {
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '')
  if (alert.changePoints !== undefined) return `${sign(alert.changePoints)}${Math.abs(alert.changePoints)} ${points}`
  if (alert.changePct !== undefined) return `${sign(alert.changePct)}${Math.abs(Math.round(alert.changePct))}%`
  return null
}

/** The metric's name: a translated label for known ids, else the source's label, else the id. */
export function metricName(alert: Pick<MetricAlert, 'metric' | 'label'>, t: (key: MessageKey) => string): string {
  const key = `metricAlerts.metric.${alert.metric}`
  return key in DICTIONARIES.en ? t(key as MessageKey) : (alert.label ?? alert.metric)
}

/**
 * The polyline points of a sparkline in a `width`×`height` box with `pad` inside: oldest left,
 * the top is the highest value; a flat or single-value series is drawn mid-height.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number, pad = 1.5): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const x = values.length > 1 ? pad + i * step : width / 2
      const y = span === 0 ? height / 2 : pad + (1 - (v - min) / span) * (height - 2 * pad)
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
    })
    .join(' ')
}

/** One row of Settings → Health → Alert rules → per-metric overrides; blank numbers keep the default. */
export interface OverrideForm {
  metric: string
  minVolume: string
  jumpPct: string
  rateDropPoints: string
  critical: boolean
  muted: boolean
}

export interface AlertRulesForm {
  thresholds: AlertThresholds
  businessDays: number[]
  notifyMinSeverity: AlertSeverity
  overrides: OverrideForm[]
}

/** The numbers an override row can set. */
export const OVERRIDE_FIELDS = ['minVolume', 'jumpPct', 'rateDropPoints'] as const

export function alertRulesToForm(stored: Partial<AlertRulesConfig> | undefined): AlertRulesForm {
  const rules = alertRulesOf(stored)
  return {
    thresholds: { ...rules.thresholds },
    businessDays: [...rules.businessDays],
    notifyMinSeverity: rules.notifyMinSeverity,
    overrides: Object.entries(rules.overrides).map(([metric, o]) => ({
      metric,
      minVolume: o.minVolume === undefined ? '' : String(o.minVolume),
      jumpPct: o.jumpPct === undefined ? '' : String(o.jumpPct),
      rateDropPoints: o.rateDropPoints === undefined ? '' : String(o.rateDropPoints),
      critical: o.critical === true,
      muted: o.muted === true
    }))
  }
}

/** The stored rules of a form: rows without a metric id are dropped, numbers are clamped, the last row of a metric wins. */
export function formToAlertRules(form: AlertRulesForm): AlertRulesConfig {
  const overrides: Record<string, MetricRuleOverride> = {}
  for (const row of form.overrides) {
    const id = row.metric.trim()
    if (!id) continue
    const o: MetricRuleOverride = {}
    for (const k of OVERRIDE_FIELDS) {
      const n = Number(row[k])
      if (row[k].trim() !== '' && Number.isFinite(n)) o[k] = n
    }
    if (row.critical) o.critical = true
    if (row.muted) o.muted = true
    overrides[id] = o
  }
  return alertRulesOf({ thresholds: form.thresholds, businessDays: form.businessDays, notifyMinSeverity: form.notifyMinSeverity, overrides })
}
