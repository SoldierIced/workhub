import { flowAlertsOf, flowCoverage, flowEntry, flowMeasures, flowPartLabel, formatMs, rankFlowDeviations, rankFlowParts, type FlowMap, type FlowMapReading, type FlowTrace, type FlowTraceLog } from '@workhub/core'
import type { MessageKey } from '../../i18n/translate'

type T = (key: MessageKey, params?: Record<string, string | number>) => string

export interface FlowMapPromptInput {
  map: FlowMap
  file: string
  environment: string
  reading?: FlowMapReading
  trace?: FlowTrace | null
  /** The selected execution's APM errors and log lines, when loaded. */
  logs?: FlowTraceLog[] | null
  locale: string
}

/**
 * "Ask Claude" for a flow map: the file, the numbers of the window (slowest first, with each
 * part's share), what is not measured or has no data, the selected execution and what it did
 * beyond the map, and what to do with all that. Nothing is sent: the draft lands in the composer.
 */
export function flowMapPrompt(t: T, input: FlowMapPromptInput): string {
  const { map, file, environment, reading, trace, logs, locale } = input
  const lines: string[] = [t('flowMapPrompt.title', { name: map.name, environment })]
  if (map.description) lines.push(map.description)
  lines.push('')
  const rate = (r: number) => `${(r * 100).toFixed(1)} %`
  if (reading) {
    lines.push(t('flowMapPrompt.intro', { file, hours: reading.windowHours }))
    for (const r of rankFlowParts(map, reading)) {
      const failed = r.timing.errorRate !== undefined && r.timing.errorRate > 0 ? t('flowMapPrompt.partFailed', { rate: rate(r.timing.errorRate) }) : ''
      lines.push(t('flowMapPrompt.part', { label: r.label, calls: r.timing.count.toLocaleString(locale), p50: formatMs(r.timing.p50Ms), p95: formatMs(r.timing.p95Ms), failed, share: rate(r.share) }))
    }
    const deviations = rankFlowDeviations(map, reading, 'weekly').filter((d) => d.ratio > 1 || d.errorDelta > 0.005).slice(0, 3)
    if (deviations.length) {
      lines.push('', t('flowMapPrompt.deviations'))
      for (const d of deviations) {
        const errors = d.errorDelta > 0.005 ? t('flowMapPrompt.deviationErrors', { points: (d.errorDelta * 100).toFixed(1) }) : ''
        lines.push(t('flowMapPrompt.deviation', { label: d.label, ratio: d.ratio.toFixed(1), now: formatMs(d.timing.p95Ms), usual: formatMs(d.baseline.p95Ms), errors }))
      }
    }
    const entry = flowEntry(map)
    const entryPart = entry && flowMeasures(map).find((m) => m.measure.type === 'apm.transaction' && m.measure.service === entry.service && m.measure.transaction === entry.transaction)
    const codes = entryPart ? reading[entryPart.of][entryPart.key]?.codes : undefined
    if (entryPart && codes?.length) lines.push('', t('flowMapPrompt.codes', { label: flowPartLabel(map, entryPart), list: codes.map((c) => `${c.code} ${c.count.toLocaleString(locale)}`).join(', ') }))
    const alerts = flowAlertsOf(map, reading, { id: '', name: environment })
    if (alerts.length) lines.push('', t('flowMapPrompt.alerts', { list: alerts.map((a) => (a.kind === 'flowSlow' ? t('flowMapPrompt.alertSlow', { label: a.label, value: formatMs(a.value), limit: formatMs(a.threshold) }) : t('flowMapPrompt.alertErrors', { label: a.label, value: rate(a.value), limit: rate(a.threshold) }))).join('; ') }))
    const c = flowCoverage(map, reading)
    if (c.unmeasured.length) lines.push('', t('flowMapPrompt.unmeasured', { list: c.unmeasured.map((p) => p.label).join(', ') }))
    if (c.noData.length) lines.push('', t('flowMapPrompt.noData', { list: c.noData.map((p) => p.label).join(', ') }))
    if (c.failed.length) lines.push('', t('flowMapPrompt.failed', { list: c.failed.map((p) => `${p.label} (${p.error})`).join('; ') }))
  } else {
    lines.push(t('flowMapPrompt.intro', { file, hours: 0 }))
  }
  if (trace) {
    const hops = Object.values(trace.hops)
      .sort((a, b) => a.startMs - b.startMs)
      .map((h) => `${flowPartLabel(map, h)} +${formatMs(h.startMs)} ${formatMs(h.durationMs)}${h.count > 1 ? ` ×${h.count}` : ''}${h.failed ? ' ✕' : ''}`)
      .join('; ')
    lines.push('', t('flowMapPrompt.trace', { id: trace.traceId, when: new Date(trace.at).toLocaleString(locale), duration: formatMs(trace.durationMs), outcome: trace.outcome, hops }))
    if (trace.missing.length) lines.push(t('flowMapPrompt.traceMissing', { list: trace.missing.map((k) => flowPartLabel(map, { of: hopOf(map, k), key: k })).join(', ') }))
    if (trace.unmapped.length) lines.push(t('flowMapPrompt.unmapped', { list: trace.unmapped.slice(0, 15).map((u) => `${u.service} ${u.event === 'span' ? `→ ${u.destination ?? u.name}` : u.name} ${formatMs(u.durationMs)}${u.count > 1 ? ` ×${u.count}` : ''}`).join('; ') }))
  }
  if (trace && logs?.length) {
    const first = logs.slice(0, 15)
    lines.push('', t('flowMapPrompt.logs', { count: first.length }))
    for (const l of first) lines.push(t('flowMapPrompt.logLine', { at: `${(Math.max(0, l.at - trace.at) / 1000).toFixed(2)} s`, service: l.service, level: l.level ?? (l.source === 'apm.error' ? 'error' : 'log'), message: l.message.replace(/\s+/g, ' ').slice(0, 300) }))
  }
  lines.push('', t('flowMapPrompt.ask'))
  return lines.join('\n')
}

function hopOf(map: FlowMap, key: string): 'edges' | 'nodes' | 'stages' {
  if (map.nodes.some((n) => n.id === key)) return 'nodes'
  if (map.stages.some((s) => s.id === key)) return 'stages'
  return 'edges'
}
