/**
 * Flow alerts: a map's `alerts` thresholds checked against a reading. The watcher reads every map
 * with thresholds over a 1 h window (the last whole hour plus the part of the hour in course, see
 * `flowTimingFromHistory`) and announces the parts above them, each at most once an hour; the
 * Alerts tab shows the same check for the window on screen.
 */
import { DEFAULT_FLOW_MIN_CALLS, flowMeasures, flowPartLabel, type FlowMap, type FlowMapReading, type FlowPartRef, type FlowThreshold, type FlowTiming } from './flow-map'

export type FlowAlertKind = 'flowSlow' | 'flowErrors'

export interface FlowAlert {
  mapId: string
  mapName: string
  environmentId: string
  environmentName: string
  kind: FlowAlertKind
  part: FlowPartRef
  label: string
  /** The p95 in milliseconds (`flowSlow`) or the failure share (`flowErrors`) seen. */
  value: number
  threshold: number
  windowHours: number
}

/** Whether the map asks for any alert at all. */
export function hasFlowAlerts(map: Pick<FlowMap, 'alerts'>): boolean {
  const a = map.alerts
  if (!a) return false
  return a.p95Ms !== undefined || a.errorRate !== undefined || Object.values(a.parts).some((p) => p.p95Ms !== undefined || p.errorRate !== undefined)
}

/** The limits of one part, and the calls the window needs before they apply (`DEFAULT_FLOW_MIN_CALLS` when unset). */
export type FlowLimits = FlowThreshold & { minCalls?: number }

/** The limits one part must stay under: its own entry over the map's defaults, field by field. */
export function flowThresholds(map: Pick<FlowMap, 'alerts'>, part: Pick<FlowPartRef, 'key'>): FlowLimits {
  const own = map.alerts?.parts[part.key]
  return { p95Ms: own?.p95Ms ?? map.alerts?.p95Ms, errorRate: own?.errorRate ?? map.alerts?.errorRate, minCalls: map.alerts?.minCalls }
}

/** The thresholds one timing breaks, in a fixed order (slow first); none under the minimum calls. */
export function breaches(timing: FlowTiming, limits: FlowLimits): { kind: FlowAlertKind; value: number; threshold: number }[] {
  const out: { kind: FlowAlertKind; value: number; threshold: number }[] = []
  if (timing.count === 0 || timing.count < (limits.minCalls ?? DEFAULT_FLOW_MIN_CALLS)) return out
  if (limits.p95Ms !== undefined && timing.p95Ms > limits.p95Ms) out.push({ kind: 'flowSlow', value: timing.p95Ms, threshold: limits.p95Ms })
  if (limits.errorRate !== undefined && timing.errorRate !== undefined && timing.errorRate > limits.errorRate && (timing.failed ?? 1) > 0) out.push({ kind: 'flowErrors', value: timing.errorRate, threshold: limits.errorRate })
  return out
}

/** Whether the watcher notifies about the map: it has limits and its `notify` is not off. */
export function notifiesFlowAlerts(map: Pick<FlowMap, 'alerts'>): boolean {
  return hasFlowAlerts(map) && map.alerts?.notify !== false
}

/** Every measured part of the map above its thresholds in this reading. */
export function flowAlertsOf(map: FlowMap, reading: FlowMapReading, env: { id: string; name: string }): FlowAlert[] {
  if (!hasFlowAlerts(map)) return []
  const alerts: FlowAlert[] = []
  for (const m of flowMeasures(map)) {
    const timing = reading[m.of][m.key]
    if (!timing) continue
    for (const b of breaches(timing, flowThresholds(map, m))) {
      alerts.push({ mapId: map.id, mapName: map.name, environmentId: env.id, environmentName: env.name, kind: b.kind, part: { of: m.of, key: m.key }, label: flowPartLabel(map, m), value: b.value, threshold: b.threshold, windowHours: reading.windowHours })
    }
  }
  return alerts
}

/** One part is announced at most this often, per kind. */
export const FLOW_ALERT_COOLDOWN_MS = 60 * 60_000

export const flowAlertKey = (a: Pick<FlowAlert, 'kind' | 'environmentId' | 'mapId' | 'part'>): string => `${a.kind}|${a.environmentId}|${a.mapId}|${a.part.of}:${a.part.key}`

/** The alerts that may fire at `now` and the updated record of when each fired (kept across launches). */
export function admitFlowAlerts(alerts: readonly FlowAlert[], firedAt: Readonly<Record<string, number>>, now: number): { admitted: FlowAlert[]; firedAt: Record<string, number> } {
  const record: Record<string, number> = {}
  for (const [key, at] of Object.entries(firedAt)) if (now - at < FLOW_ALERT_COOLDOWN_MS) record[key] = at
  const admitted: FlowAlert[] = []
  for (const alert of alerts) {
    const key = flowAlertKey(alert)
    if (record[key] !== undefined) continue
    record[key] = now
    admitted.push(alert)
  }
  return { admitted, firedAt: record }
}
