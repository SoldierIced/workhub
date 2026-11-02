/**
 * The alert rules: pure, deterministic arithmetic over daily series (no model calls). Each series
 * is compared with its own previous 7 business days; the strongest finding per series is kept.
 */
import { addDays, daysBetween, isBusinessDay, lastBusinessDay, localDay } from './days'
import { ALERT_RULE_KINDS, ALERT_SEVERITIES, type AlertRuleKind, type AlertRulesConfig, type AlertSeverity, type AlertThresholds, type DailyPoint, type MetricDefinition, type MetricDetection, type MetricSeries, type MetricSeriesStore } from './types'

/** Business days behind the baseline. */
export const BASELINE_DAYS = 7
/** A baseline needs at least this many days. */
export const MIN_BASELINE_POINTS = 3
/** A finding at this share of a threshold (but under it) is a low "near threshold" alert. */
export const NEAR_THRESHOLD_RATIO = 0.8
/** New subject: the source must have this many days of history, or every subject of a fresh install would be new. */
export const NEW_SUBJECT_WARMUP_DAYS = 7
/** Days of history an alert carries for its sparkline. */
export const HISTORY_DAYS = 14
/** Missing data: no sample for this long on a business day. */
export const MISSING_AFTER_MS = 24 * 60 * 60_000
/** A series whose latest point is older than this many days is only checked for missing data. */
export const STALE_POINT_DAYS = 7

const SEVERITY_RANK: Record<AlertSeverity, number> = { high: 3, medium: 2, low: 1 }

export function severityAtLeast(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum]
}

export function compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b]
}

export function isSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value)
}

/** The thresholds a metric runs with: the defaults, then its override. */
export function rulesForMetric(config: AlertRulesConfig, metricId: string, definition?: MetricDefinition): { thresholds: AlertThresholds; critical: boolean; muted: boolean } {
  const o = config.overrides[metricId] ?? {}
  const thresholds = { ...config.thresholds }
  for (const k of Object.keys(thresholds) as (keyof AlertThresholds)[]) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) thresholds[k] = v
  }
  return { thresholds, critical: o.critical ?? definition?.critical ?? false, muted: o.muted === true }
}

interface Finding {
  kind: AlertRuleKind
  severity: AlertSeverity
  value: number
  baseline: number
  day: string
  changePct?: number
  changePoints?: number
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const stdDev = (xs: readonly number[]) => {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}
const round = (n: number) => Math.round(n * 10) / 10

/** The business-day values of a series up to `until`; a series whose missing days are zeros is filled from its first day. */
function businessValues(series: MetricSeries, absentIsZero: boolean, until: string, businessDays: readonly number[]): DailyPoint[] {
  const isBusiness = (d: string) => businessDays.length === 0 || isBusinessDay(d, businessDays)
  if (!absentIsZero) return series.points.filter((p) => p.day <= until && isBusiness(p.day))
  const first = series.points[0]?.day
  if (!first || first > until) return []
  const byDay = new Map(series.points.map((p) => [p.day, p]))
  const out: DailyPoint[] = []
  for (let d = first; d <= until; d = addDays(d, 1)) if (isBusiness(d)) out.push(byDay.get(d) ?? { day: d, value: 0 })
  return out
}

/** The last `HISTORY_DAYS` calendar days, oldest first. */
export function seriesHistory(series: MetricSeries, absentIsZero: boolean, today: string): { day: string; value: number }[] {
  const from = addDays(today, -(HISTORY_DAYS - 1))
  if (!absentIsZero) return series.points.filter((p) => p.day >= from && p.day <= today).map((p) => ({ day: p.day, value: p.value }))
  const first = series.points[0]?.day ?? today
  const byDay = new Map(series.points.map((p) => [p.day, p.value]))
  const out: { day: string; value: number }[] = []
  for (let d = from > first ? from : first; d <= today; d = addDays(d, 1)) out.push({ day: d, value: byDay.get(d) ?? 0 })
  return out
}

function countFindings(cur: DailyPoint, prev: DailyPoint[], t: AlertThresholds, up: boolean, skipFromZero: boolean): Finding[] {
  if (prev.length < MIN_BASELINE_POINTS) return []
  const values = prev.map((p) => p.value)
  const avg = mean(values)
  // Counts are noisy by nature (about √mean), so a flat history does not make every wobble a jump.
  const std = Math.max(stdDev(values), Math.sqrt(avg))
  const delta = up ? cur.value - avg : avg - cur.value
  const volumeOk = up ? cur.value >= t.minVolume : avg >= t.minVolume
  if (!volumeOk || delta <= 0) return []
  const pct = avg > 0 ? (delta / avg) * 100 : undefined
  const base = { value: cur.value, baseline: round(avg), day: cur.day, ...(avg > 0 ? { changePct: round(((cur.value - avg) / avg) * 100) } : {}) }
  const out: Finding[] = []
  if (pct === undefined) {
    if (!skipFromZero) out.push({ ...base, kind: 'jump', severity: 'high' })
  } else if (pct > t.jumpPct || delta > t.jumpStdDevs * std) {
    out.push({ ...base, kind: 'jump', severity: pct > 2 * t.jumpPct ? 'high' : 'medium' })
  } else if (pct >= NEAR_THRESHOLD_RATIO * t.jumpPct) {
    out.push({ ...base, kind: 'jump', severity: 'low' })
  }
  const run = [...prev, cur].slice(-(t.trendDays + 1))
  const rising = run.length === t.trendDays + 1 && run.every((p, i) => i === 0 || (up ? p.value > run[i - 1]!.value : p.value < run[i - 1]!.value))
  if (rising && pct !== undefined && pct > t.trendPct) out.push({ ...base, kind: 'sustainedTrend', severity: 'medium' })
  return out
}

function rateFindings(cur: DailyPoint, prev: DailyPoint[], t: AlertThresholds, up: boolean): Finding[] {
  if (prev.length < MIN_BASELINE_POINTS) return []
  if (cur.base !== undefined && cur.base < t.minVolume) return []
  const avg = mean(prev.map((p) => p.value))
  const worse = up ? cur.value - avg : avg - cur.value
  const base = { value: cur.value, baseline: round(avg), day: cur.day, changePoints: round(cur.value - avg) }
  if (worse > t.rateDropPoints) return [{ ...base, kind: 'rateDrop', severity: worse > 2 * t.rateDropPoints ? 'high' : 'medium' }]
  if (worse > 0 && worse >= NEAR_THRESHOLD_RATIO * t.rateDropPoints) return [{ ...base, kind: 'rateDrop', severity: 'low' }]
  return []
}

/**
 * The strongest finding for one series at `now`, or null. `sourceSince` is the first day the
 * source has any history (new subjects are only announced once the source is warmed up).
 */
export function detectSeries(series: MetricSeries, definition: MetricDefinition | undefined, config: AlertRulesConfig, now: number, sourceSince?: string): MetricDetection | null {
  const { thresholds: t, critical, muted } = rulesForMetric(config, series.metric, definition)
  if (muted) return null
  const today = localDay(now)
  const businessDays = config.businessDays
  const absentIsZero = definition?.absentIsZero === true
  const up = (definition?.direction ?? 'upIsBad') === 'upIsBad'
  const kind = definition?.kind ?? 'count'
  const evalDay = lastBusinessDay(today, businessDays)
  const values = businessValues(series, absentIsZero, evalDay, businessDays)
  const findings: Finding[] = []

  const cur = values.at(-1)
  if (cur && cur.day >= addDays(evalDay, -STALE_POINT_DAYS)) {
    const prev = values.slice(0, -1).slice(-BASELINE_DAYS)
    let isNew = false
    if (kind === 'count' && up && cur.value > 0 && cur.value >= t.minVolume && sourceSince && daysBetween(sourceSince, cur.day) >= NEW_SUBJECT_WARMUP_DAYS) {
      const from = addDays(cur.day, -t.newSubjectDays)
      isNew = !series.points.some((p) => p.day < cur.day && p.day >= from && p.value > 0)
      if (isNew) findings.push({ kind: 'newSubject', severity: 'medium', value: cur.value, baseline: 0, day: cur.day })
    }
    findings.push(...(kind === 'rate' ? rateFindings(cur, prev, t, up) : countFindings(cur, prev, t, up, isNew)))
  }

  if (definition?.expectDaily && isBusinessDay(today, businessDays) && series.lastSampleAt !== undefined && now - series.lastSampleAt > MISSING_AFTER_MS) {
    const recent = series.points.filter((p) => p.day >= addDays(today, -10) && p.day < today)
    const last = series.points.at(-1)
    if (recent.length >= MIN_BASELINE_POINTS && last) findings.push({ kind: 'missingData', severity: 'low', value: last.value, baseline: round(mean(recent.slice(-BASELINE_DAYS).map((p) => p.value))), day: last.day })
  }

  if (findings.length === 0) return null
  const best = findings
    .map((f) => (critical && f.severity !== 'low' ? { ...f, severity: 'high' as const } : f))
    .sort((a, b) => compareSeverity(b.severity, a.severity) || ALERT_RULE_KINDS.indexOf(a.kind) - ALERT_RULE_KINDS.indexOf(b.kind))[0]!
  const link = series.link ?? definition?.link
  return {
    key: series.key,
    kind: best.kind,
    severity: best.severity,
    source: series.source,
    metric: series.metric,
    subject: series.subject,
    ...(series.segment ? { segment: series.segment } : {}),
    day: best.day,
    value: best.value,
    baseline: best.baseline,
    ...(best.changePct !== undefined ? { changePct: best.changePct } : {}),
    ...(best.changePoints !== undefined ? { changePoints: best.changePoints } : {}),
    history: seriesHistory(series, absentIsZero, today),
    ...(definition?.label ? { label: definition.label } : {}),
    ...(link ? { link } : {})
  }
}

/** Runs the rules over every series of a store. Definitions are matched by metric id; an unknown metric is an upIsBad count. */
export function detectMetricAlerts(store: MetricSeriesStore, definitions: readonly MetricDefinition[], config: AlertRulesConfig, now: number): MetricDetection[] {
  const byId = new Map(definitions.map((d) => [d.id, d]))
  const since = new Map<string, string>()
  for (const s of Object.values(store)) {
    const first = s.points[0]?.day
    if (first && (!since.has(s.source) || first < since.get(s.source)!)) since.set(s.source, first)
  }
  const out: MetricDetection[] = []
  for (const s of Object.values(store)) {
    const d = detectSeries(s, byId.get(s.metric), config, now, since.get(s.source))
    if (d) out.push(d)
  }
  return out
}
