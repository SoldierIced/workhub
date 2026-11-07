/**
 * Settings → Alerts, the parts without React: the flow-map limits form (what the inputs hold, the
 * `alerts` field it writes), the "Now" tone of a part, and the per-kind Health alert settings.
 */
import {
  breaches,
  DEFAULT_FLOW_MIN_CALLS,
  FLOW_ALERT_KINDS,
  flowMeasures,
  flowPartLabel,
  flowThresholds,
  HEALTH_ALERT_CHANNELS,
  slowShareOf,
  type FlowAlertKind,
  type FlowLimits,
  type FlowMap,
  type FlowMapAlerts,
  type FlowMapReading,
  type FlowPartRef,
  type FlowTiming,
  type HealthAlertChannel,
  type HealthAlertKind,
  type HealthAlertKindSettings,
  type HealthAlertSettings
} from '@workhub/core'
import type { FlowMapSetAlertsResult, FlowMapsApi } from '@shared/flow-maps-api'

// Flow-map limits ---------------------------------------------------------------------------------

/** One part's own limits; blank inherits the map's. */
export interface PartLimitForm {
  key: string
  p95Ms: string
  errorPct: string
  /** Calls slower than this many milliseconds count as slow. */
  slowMs: string
  /** The share of slow calls, in percent, that breaks the limit (blank: a single one). */
  slowPct: string
}

/** What the inputs of one map hold: numbers as typed, the failure share in percent. */
export interface FlowLimitsForm {
  p95Ms: string
  errorPct: string
  slowMs: string
  slowPct: string
  minCalls: string
  notify: boolean
  parts: PartLimitForm[]
}

const text = (n: number | undefined) => (n === undefined ? '' : String(n))
/** A share (0–1) as a percentage, without float noise (0.05 → "5"). */
const percent = (rate: number | undefined) => (rate === undefined ? '' : String(Math.round(rate * 10_000) / 100))

export function flowLimitsToForm(alerts: FlowMapAlerts | undefined): FlowLimitsForm {
  return {
    p95Ms: text(alerts?.p95Ms),
    errorPct: percent(alerts?.errorRate),
    slowMs: text(alerts?.slowMs),
    slowPct: percent(alerts?.slowShare),
    minCalls: text(alerts?.minCalls),
    notify: alerts?.notify !== false,
    parts: Object.entries(alerts?.parts ?? {}).map(([key, p]) => ({ key, p95Ms: text(p.p95Ms), errorPct: percent(p.errorRate), slowMs: text(p.slowMs), slowPct: percent(p.slowShare) }))
  }
}

export type FlowLimitsField = 'p95Ms' | 'errorPct' | 'slowMs' | 'slowPct' | 'minCalls'
export type FlowLimitsParse = { ok: true; alerts: FlowMapAlerts | null } | { ok: false; field: FlowLimitsField; part?: string }

function parseNumber(raw: string, check: (n: number) => boolean): number | undefined | null {
  const v = raw.trim()
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) && check(n) ? n : null
}

const p95Ok = (n: number) => n > 0
const pctOk = (n: number) => n >= 0 && n <= 100
const toRate = (pct: number) => Math.round(pct * 100) / 10_000

/**
 * The `alerts` field the form writes; null when it sets nothing (no limits, no minimum, notify
 * on), which removes the field. A field that does not parse is named so the form can mark it.
 */
export function formToFlowAlerts(form: FlowLimitsForm): FlowLimitsParse {
  const p95 = parseNumber(form.p95Ms, p95Ok)
  if (p95 === null) return { ok: false, field: 'p95Ms' }
  const pct = parseNumber(form.errorPct, pctOk)
  if (pct === null) return { ok: false, field: 'errorPct' }
  const slowMs = parseNumber(form.slowMs, p95Ok)
  if (slowMs === null) return { ok: false, field: 'slowMs' }
  const slowPct = parseNumber(form.slowPct, pctOk)
  if (slowPct === null) return { ok: false, field: 'slowPct' }
  const minCalls = parseNumber(form.minCalls, (n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000)
  if (minCalls === null) return { ok: false, field: 'minCalls' }
  const parts: FlowMapAlerts['parts'] = {}
  for (const part of form.parts) {
    if (!part.key) continue
    const ownP95 = parseNumber(part.p95Ms, p95Ok)
    if (ownP95 === null) return { ok: false, field: 'p95Ms', part: part.key }
    const ownPct = parseNumber(part.errorPct, pctOk)
    if (ownPct === null) return { ok: false, field: 'errorPct', part: part.key }
    const ownSlowMs = parseNumber(part.slowMs, p95Ok)
    if (ownSlowMs === null) return { ok: false, field: 'slowMs', part: part.key }
    const ownSlowPct = parseNumber(part.slowPct, pctOk)
    if (ownSlowPct === null) return { ok: false, field: 'slowPct', part: part.key }
    if (ownP95 === undefined && ownPct === undefined && ownSlowMs === undefined && ownSlowPct === undefined) continue
    parts[part.key] = {
      ...(ownP95 !== undefined ? { p95Ms: ownP95 } : {}),
      ...(ownPct !== undefined ? { errorRate: toRate(ownPct) } : {}),
      ...(ownSlowMs !== undefined ? { slowMs: ownSlowMs } : {}),
      ...(ownSlowPct !== undefined ? { slowShare: toRate(ownSlowPct) } : {})
    }
  }
  const alerts: FlowMapAlerts = {
    ...(p95 !== undefined ? { p95Ms: p95 } : {}),
    ...(pct !== undefined ? { errorRate: toRate(pct) } : {}),
    ...(slowMs !== undefined ? { slowMs } : {}),
    ...(slowPct !== undefined ? { slowShare: toRate(slowPct) } : {}),
    ...(minCalls !== undefined ? { minCalls } : {}),
    ...(form.notify ? {} : { notify: false }),
    parts
  }
  const empty = p95 === undefined && pct === undefined && slowMs === undefined && slowPct === undefined && minCalls === undefined && form.notify && Object.keys(parts).length === 0
  return { ok: true, alerts: empty ? null : alerts }
}

/** Parses the form and writes it into the map's file; a form that does not parse writes nothing. */
export async function saveFlowLimits(api: Pick<FlowMapsApi, 'setAlerts'>, profileId: string | null, mapId: string, form: FlowLimitsForm): Promise<FlowLimitsParse | FlowMapSetAlertsResult> {
  const parsed = formToFlowAlerts(form)
  if (!parsed.ok) return parsed
  return api.setAlerts(profileId, mapId, parsed.alerts)
}

/** The measured parts of a map, the ones a limit can be set on, in drawing order. */
export function measuredParts(map: FlowMap): (FlowPartRef & { label: string })[] {
  return flowMeasures(map).map((m) => ({ of: m.of, key: m.key, label: flowPartLabel(map, m) }))
}

/** The map as the form would leave it, for the "Now" column; the stored limits while the form does not parse. */
export function draftMap(map: FlowMap, form: FlowLimitsForm): FlowMap {
  const parsed = formToFlowAlerts(form)
  if (!parsed.ok) return map
  const { alerts: _old, ...rest } = map
  return parsed.alerts ? { ...rest, alerts: parsed.alerts } : rest
}

/** How a part stands against its limits now: no data, ok, or the limits it is over. */
export type NowTone = { kind: 'none' } | { kind: 'ok' } | { kind: 'over'; over: FlowAlertKind[] }

export function nowTone(timing: FlowTiming | undefined, limits: FlowLimits): NowTone {
  if (!timing || timing.count === 0) return { kind: 'none' }
  const over = breaches(timing, limits).map((b) => b.kind)
  return over.length ? { kind: 'over', over } : { kind: 'ok' }
}

export function timingOf(reading: FlowMapReading | undefined, part: FlowPartRef): FlowTiming | undefined {
  return reading?.[part.of][part.key]
}

/** The share of a timing's calls slower than `ms`, when the limit is set and the timing has a histogram. */
export function slowShareNow(timing: FlowTiming | undefined, ms: number | undefined): number | undefined {
  return timing && timing.count > 0 && ms !== undefined ? slowShareOf(timing, ms) : undefined
}

/** The map's default row: its slowest measured part, its worst failure share, its worst share of slow calls (against the map's `slowMs`), and every limit any part is over. */
export function mapNow(map: FlowMap, reading: FlowMapReading | undefined): { p95Ms?: number; errorRate?: number; slowShare?: number; tone: NowTone } {
  let p95: number | undefined
  let rate: number | undefined
  let slow: number | undefined
  let seen = false
  const over = new Set<FlowAlertKind>()
  for (const part of measuredParts(map)) {
    const timing = timingOf(reading, part)
    if (!timing || timing.count === 0) continue
    seen = true
    p95 = Math.max(p95 ?? 0, timing.p95Ms)
    if (timing.errorRate !== undefined) rate = Math.max(rate ?? 0, timing.errorRate)
    const share = slowShareNow(timing, map.alerts?.slowMs)
    if (share !== undefined) slow = Math.max(slow ?? 0, share)
    const tone = nowTone(timing, flowThresholds(map, part))
    if (tone.kind === 'over') tone.over.forEach((k) => over.add(k))
  }
  const tone: NowTone = !seen ? { kind: 'none' } : over.size ? { kind: 'over', over: FLOW_ALERT_KINDS.filter((k) => over.has(k)) } : { kind: 'ok' }
  return { ...(p95 !== undefined ? { p95Ms: p95 } : {}), ...(rate !== undefined ? { errorRate: rate } : {}), ...(slow !== undefined ? { slowShare: slow } : {}), tone }
}

export { DEFAULT_FLOW_MIN_CALLS }

// Health alerts per kind ----------------------------------------------------------------------------

/** The stored settings with one kind changed; channels are left out while every channel is on. */
export function withHealthAlertKind(stored: HealthAlertSettings | undefined, kind: HealthAlertKind, next: { notify: boolean; threshold?: number; channels: HealthAlertChannel[] }): HealthAlertSettings {
  const all = HEALTH_ALERT_CHANNELS.every((c) => next.channels.includes(c))
  const entry: HealthAlertKindSettings = {
    notify: next.notify,
    ...(next.threshold !== undefined ? { threshold: next.threshold } : {}),
    ...(all ? {} : { channels: HEALTH_ALERT_CHANNELS.filter((c) => next.channels.includes(c)) })
  }
  return { ...stored, [kind]: entry }
}
