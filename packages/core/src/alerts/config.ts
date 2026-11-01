import { isSeverity } from './rules'
import { METRIC_ALERT_THRESHOLD_RANGES, DEFAULT_ALERT_RULES, DEFAULT_METRIC_ALERT_THRESHOLDS, type AlertRulesConfig, type AlertThresholds, type MetricRuleOverride } from './types'

const clamp = (key: keyof AlertThresholds, n: number) => Math.min(METRIC_ALERT_THRESHOLD_RANGES[key][1], Math.max(METRIC_ALERT_THRESHOLD_RANGES[key][0], n))

/**
 * The rules a profile runs with: what it stores (`health.alertRules`, possibly partial or
 * hand-edited) over the defaults, every number clamped to its range.
 */
export function alertRulesOf(stored: Partial<AlertRulesConfig> | undefined): AlertRulesConfig {
  const thresholds = { ...DEFAULT_METRIC_ALERT_THRESHOLDS }
  for (const k of Object.keys(thresholds) as (keyof AlertThresholds)[]) {
    const v = stored?.thresholds?.[k]
    if (typeof v === 'number' && Number.isFinite(v)) thresholds[k] = clamp(k, v)
  }
  const days = Array.isArray(stored?.businessDays) ? [...new Set(stored.businessDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : null
  const overrides: Record<string, MetricRuleOverride> = {}
  for (const [id, o] of Object.entries(stored?.overrides ?? {})) {
    if (!id.trim() || !o || typeof o !== 'object') continue
    const clean: MetricRuleOverride = {}
    for (const k of Object.keys(DEFAULT_METRIC_ALERT_THRESHOLDS) as (keyof AlertThresholds)[]) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) clean[k] = clamp(k, v)
    }
    if (o.critical === true) clean.critical = true
    if (o.muted === true) clean.muted = true
    overrides[id.trim()] = clean
  }
  return {
    thresholds,
    businessDays: days && days.length > 0 ? days : [...DEFAULT_ALERT_RULES.businessDays],
    notifyMinSeverity: isSeverity(stored?.notifyMinSeverity) ? stored.notifyMinSeverity : DEFAULT_ALERT_RULES.notifyMinSeverity,
    overrides
  }
}
