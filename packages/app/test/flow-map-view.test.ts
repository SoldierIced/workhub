import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { edgeId, flowCoverage, parseFlowMap, rankFlowParts, type FlowMap, type FlowMapReading, type FlowTrace, type FlowTraceLog } from '@workhub/core'
import { FlowMapSvg } from '../src/renderer/screens/flowMaps/FlowMapSvg'
import { FlowSequenceSvg, sequenceLayout } from '../src/renderer/screens/flowMaps/FlowSequenceSvg'
import { AlertsTab, DeviationLine, PartsTab } from '../src/renderer/screens/flowMaps/FlowMapView'
import { LogsSection } from '../src/renderer/screens/flowMaps/TracesPanel'
import { flowMapPrompt } from '../src/renderer/screens/flowMaps/flowMapPrompt'
import { en } from '../src/renderer/i18n/en'
import { interpolate } from '../src/renderer/i18n/translate'

const map = (parseFlowMap(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8'))) as { ok: true; map: FlowMap }).map
const hourly = [{ at: 0, count: 10, p50Ms: 100, p95Ms: 300 }]
const reading: FlowMapReading = {
  at: 1,
  windowHours: 24,
  nodes: { bff: { count: 120, p50Ms: 1234, p95Ms: 2500, errorRate: 0.01, hourly } },
  edges: { 'bff->orders': { count: 118, p50Ms: 880, p95Ms: 1900, hourly } },
  stages: {},
  errors: { 'orders->payments': 'no such index' }
}

describe('FlowMapSvg', () => {
  it('draws every lane, node and edge of the example, with the measured p50 as labels', () => {
    const html = renderToStaticMarkup(createElement(FlowMapSvg, { map, reading, flow: false, picked: null, onPick: () => {} }))
    for (const lane of map.lanes) expect(html).toContain(lane.label)
    for (const node of map.nodes) expect(html).toContain(node.label)
    expect(html).toContain('Checkout · sync')
    expect(html).toContain('Shipped')
    // A measured node shows its numbers instead of its subtitle; a measured edge its p50; a wait edge is dashed red.
    expect(html).toContain('p50 1.2 s · p95 2.5 s')
    expect(html).toContain('880 ms')
    expect(html).toContain('stroke-dasharray="3 4"')
    expect((html.match(/marker-end="url\(#fm-/g) ?? []).length).toBe(map.edges.length)
  })

  it('renders without a reading: subtitles and the edge labels of the file', () => {
    const html = renderToStaticMarkup(createElement(FlowMapSvg, { map, flow: false, picked: null, onPick: () => {} }))
    expect(html).toContain('POST /checkout')
    expect(html).toContain('queue wait')
    expect(html).not.toContain('p95')
  })
})

describe('FlowMapSvg: ranks, coverage, picks and executions', () => {
  const ranks = rankFlowParts(map, reading)
  const coverage = flowCoverage(map, reading)

  it('marks the slowest parts with their rank, hatches measured parts without data and fades unmeasured ones', () => {
    const noData: FlowMapReading = { ...reading, nodes: { ...reading.nodes, orders: { count: 0, p50Ms: 0, p95Ms: 0, hourly: [] } } }
    const html = renderToStaticMarkup(createElement(FlowMapSvg, { map, reading: noData, flow: false, picked: null, onPick: () => {}, ranks: rankFlowParts(map, noData), coverage: flowCoverage(map, noData) }))
    // Rank 1 is the bff node (p95 2.5 s), rank 2 the bff->orders hop.
    expect(html).toContain('>1</text>')
    expect(html).toContain('>2</text>')
    expect(html).toContain('fill="url(#fm-hatch)"')
    // An unmeasured node (acquirer) has a faded, dotted outline.
    expect(html).toMatch(/stroke-opacity="0.4" stroke-dasharray="2 3"/)
    expect(coverage.unmeasured.map((p) => p.key)).toContain('acquirer')
  })

  it('lights the picked part and dims the rest, keeping the edges that touch a picked node', () => {
    const html = renderToStaticMarkup(createElement(FlowMapSvg, { map, reading, flow: false, picked: { of: 'nodes', key: 'bff' }, onPick: () => {}, ranks, coverage }))
    expect(html).toContain('opacity="1" data-part="nodes:bff"')
    expect(html).toContain('opacity="0.3" data-part="nodes:orders"')
    expect(html).toContain('opacity="1" data-part="edges:bff-&gt;orders"')
    expect(html).toContain('opacity="0.3" data-part="edges:orders-&gt;payments"')
    expect(html).toContain('filter="url(#fm-glow)"')
  })

  it('with an execution, labels show what each part took and parts it never touched fade', () => {
    const trace: FlowTrace = { traceId: 't1', at: 0, durationMs: 1500, outcome: 'success', hops: { bff: { key: 'bff', of: 'nodes', startMs: 0, durationMs: 1500, count: 1, failed: false }, 'bff->orders': { key: 'bff->orders', of: 'edges', startMs: 20, durationMs: 700, count: 1, failed: true } }, missing: ['orders'], unmapped: [] }
    const html = renderToStaticMarkup(createElement(FlowMapSvg, { map, reading, trace, flow: false, picked: null, onPick: () => {}, ranks, coverage }))
    expect(html).toContain('1.5 s · +0 ms')
    expect(html).toContain('>700 ms<')
    // The window numbers leave the labels (the hover title keeps them).
    expect(html).not.toContain('>p50 1.2 s · p95 2.5 s<')
    expect(html).toContain('opacity="0.25" data-part="nodes:orders"')
  })

  it('drafts the Claude prompt with the ranked numbers, the gaps and the selected execution', () => {
    const t = (key: string, params?: Record<string, string | number>) => interpolate(en[key as keyof typeof en] ?? key, params)
    const trace: FlowTrace = { traceId: 't1', at: 0, durationMs: 1500, outcome: 'failure', hops: { bff: { key: 'bff', of: 'nodes', startMs: 0, durationMs: 1500, count: 1, failed: true } }, missing: ['bff->orders'], unmapped: [{ event: 'span', service: 'orders', name: 'INSERT', destination: 'postgresql', startMs: 40, durationMs: 300, count: 3 }] }
    const draft = flowMapPrompt(t as never, { map, file: '/data/flow-maps/checkout.json', environment: 'Production', reading, trace, locale: 'en' })
    expect(draft).toContain('# Flow map "Checkout" on Production')
    expect(draft).toContain('/data/flow-maps/checkout.json')
    expect(draft).toContain('- shop-bff: 120 calls, p50 1.2 s, p95 2.5 s, 1.0 % failed (56.8 % of the flow\'s time)')
    expect(draft).toContain('- shop-bff → orders: 118 calls, p50 880 ms, p95 1.9 s (43.2 % of the flow\'s time)')
    expect(draft).toMatch(/Parts drawn but not measured \(no `measure` in the file\): .*Acquirer.*Shipped\./)
    expect(draft).toContain('could not be read: orders → payments (no such index)')
    expect(draft).toContain('trace t1')
    expect(draft).toContain('never touched: shop-bff → orders')
    expect(draft).toContain('orders → postgresql 300 ms ×3')
    expect(draft.trim().endsWith('Ask before changing anything.')).toBe(true)
  })
})

const rich: FlowMapReading = {
  ...reading,
  nodes: {
    bff: {
      count: 1000,
      p50Ms: 400,
      p95Ms: 2400,
      p99Ms: 4100,
      failed: 30,
      errorRate: 0.03,
      perMinute: 41.7,
      codes: [{ code: 'HTTP 2xx', count: 481 }, { code: 'HTTP 4xx', count: 189 }],
      previous: { count: 900, p50Ms: 380, p95Ms: 2000, errorRate: 0.01 },
      weekly: { count: 6000, p50Ms: 300, p95Ms: 1000, errorRate: 0.01 },
      hourly
    }
  },
  edges: {}
}
const noop = () => {}

describe('Parts tab: richer numbers', () => {
  it('shows p99, per minute, failures and the ratios against the previous window and the week', () => {
    const ranks = rankFlowParts(map, rich)
    const html = renderToStaticMarkup(createElement(PartsTab, { map, reading: rich, ranks, coverage: flowCoverage(map, rich), trace: null, picked: null, onPick: noop }))
    expect(html).toContain('4.1 s')
    expect(html).toContain('>42<')
    expect(html).toContain('30 · 3.0 %')
    expect(html).toContain('×1.2')
    expect(html).toContain('×2.4')
    expect(html).toContain('text-danger')
  })

  it('shows a dash when there is no baseline', () => {
    const plain: FlowMapReading = { ...rich, nodes: { bff: { ...rich.nodes.bff!, previous: undefined, weekly: undefined } } }
    const html = renderToStaticMarkup(createElement(PartsTab, { map, reading: plain, ranks: rankFlowParts(map, plain), coverage: flowCoverage(map, plain), trace: null, picked: null, onPick: noop }))
    expect(html).not.toContain('×')
    expect(html).toContain('>–<')
  })

  it('the detail of a picked part lists result codes with their share and both baselines', () => {
    const html = renderToStaticMarkup(createElement(PartsTab, { map, reading: rich, ranks: rankFlowParts(map, rich), coverage: flowCoverage(map, rich), trace: null, picked: { of: 'nodes', key: 'bff' }, onPick: noop }))
    expect(html).toContain('flow-part-codes')
    expect(html).toContain('HTTP 4xx')
    expect(html).toContain('18.9 %')
    expect(html).toContain('Previous window')
    expect(html).toContain('Last 7 days')
    expect(html).toContain('p50 300 ms · p95 1.0 s · 6,000 calls · 1.0 % failed')
  })
})

describe('Today against the 7-day usual', () => {
  it('names the worst deviating part as a button', () => {
    const html = renderToStaticMarkup(createElement(DeviationLine, { map, reading: rich, onPick: noop }))
    expect(html).toContain('<button')
    expect(html).toContain('«shop-bff» is ×2.4 slower than its 7-day usual')
    expect(html).not.toContain('No part deviates')
  })

  it('says nothing deviates when every part is near its usual', () => {
    const calm: FlowMapReading = { ...rich, nodes: { bff: { ...rich.nodes.bff!, weekly: { count: 6000, p50Ms: 400, p95Ms: 2300, errorRate: 0.03 } } } }
    expect(renderToStaticMarkup(createElement(DeviationLine, { map, reading: calm, onPick: noop }))).toContain('No part deviates from its 7-day usual.')
  })

  it('words a failure-share deviation in points', () => {
    const failing: FlowMapReading = { ...rich, nodes: { bff: { ...rich.nodes.bff!, weekly: { count: 6000, p50Ms: 400, p95Ms: 2300, errorRate: -0.01 } } } }
    expect(renderToStaticMarkup(createElement(DeviationLine, { map, reading: failing, onPick: noop }))).toContain('«shop-bff» fails 4 pts more than usual')
  })
})

describe('Alerts tab', () => {
  it('explains the alerts block when the map has none', () => {
    const html = renderToStaticMarkup(createElement(AlertsTab, { map: { ...map, alerts: undefined }, reading: rich, onPick: noop }))
    expect(html).toContain('<pre')
    expect(html).toContain('&quot;p95Ms&quot;: 3000')
    expect(html).toContain('once an hour')
  })

  it('lists each measured part with its limits and flags the ones above', () => {
    const limited: FlowMap = { ...map, alerts: { p95Ms: 2000, errorRate: 0.05, parts: {} } }
    const html = renderToStaticMarkup(createElement(AlertsTab, { map: limited, reading: rich, onPick: noop }))
    expect(html).not.toContain('<pre')
    expect(html).toContain('Above limit')
    expect(html).toContain('2.0 s')
    expect(html).toContain('5.0 %')
    expect(html).toContain('2.4 s')
  })

  it('marks a part under its limits as OK', () => {
    const limited: FlowMap = { ...map, alerts: { p95Ms: 9000, errorRate: 0.5, parts: {} } }
    const html = renderToStaticMarkup(createElement(AlertsTab, { map: limited, reading: rich, onPick: noop }))
    expect(html).toContain('>OK<')
    expect(html).not.toContain('Above limit')
  })
})

describe('Logs of an execution', () => {
  const logs: FlowTraceLog[] = [
    { at: 1240, service: 'orders', level: 'error', message: 'insert failed: duplicate key', type: 'DbError', culprit: 'OrderRepo.save', source: 'apm.error' },
    { at: 1500, service: 'shop-bff', level: 'info', message: 'order accepted', source: 'logs' }
  ]
  const render = (props: Parameters<typeof LogsSection>[0]) => renderToStaticMarkup(createElement(LogsSection, props))

  it('lists the lines with their offset, service, level and, for APM errors, type and culprit', () => {
    const html = render({ trace: { at: 0 }, logs: { ok: true, logs }, loading: false })
    expect(html).toContain('+1.24 s')
    expect(html).toContain('orders')
    expect(html).toContain('insert failed: duplicate key')
    expect(html).toContain('DbError · OrderRepo.save')
    expect(html).toContain('>info<')
    expect(html).not.toContain('only for logs')
  })

  it('shows the loading, error and empty states', () => {
    expect(render({ trace: { at: 0 }, logs: null, loading: true })).toContain('Reading logs')
    expect(render({ trace: { at: 0 }, logs: { ok: false, error: 'boom' }, loading: false })).toContain('The logs could not be read: boom')
    expect(render({ trace: { at: 0 }, logs: { ok: true, logs: [] }, loading: false })).toContain('No logs or errors for this execution')
  })
})

describe('Claude draft: deviations, codes, alerts and logs', () => {
  const t = (key: string, params?: Record<string, string | number>) => interpolate(en[key as keyof typeof en] ?? key, params)
  const limited: FlowMap = { ...map, alerts: { p95Ms: 2000, errorRate: 0.02, parts: {} } }
  const trace: FlowTrace = { traceId: 't1', at: 1000, durationMs: 1500, outcome: 'failure', hops: {}, missing: [], unmapped: [] }
  const lines: FlowTraceLog[] = Array.from({ length: 20 }, (_, i) => ({ at: 1000 + i * 10, service: 'orders', level: 'error', message: `line ${i}`, source: 'logs' as const }))
  const draft = flowMapPrompt(t as never, { map: limited, file: '/data/flow-maps/checkout.json', environment: 'Production', reading: rich, trace, logs: lines, locale: 'en' })

  it('adds the worst deviations with their ratio', () => {
    expect(draft).toContain('the parts that deviate most')
    expect(draft).toContain('- shop-bff: p95 ×2.4 (2.4 s now, 1.0 s usual), 2.0 pts more failures')
  })

  it('adds the result codes of the entry and the alert breaches', () => {
    expect(draft).toContain('Results of the entry (shop-bff): HTTP 2xx 481, HTTP 4xx 189.')
    expect(draft).toContain('shop-bff p95 2.4 s (limit 2.0 s)')
    expect(draft).toContain('shop-bff failures 3.0 % (limit 2.0 %)')
  })

  it('passes the first 15 log lines of the selected execution', () => {
    expect(draft).toContain('(first 15)')
    expect(draft).toContain('- +0.00 s orders error: line 0')
    expect(draft).toContain('line 14')
    expect(draft).not.toContain('line 15')
  })

  it('leaves the sections out without data', () => {
    const bare = flowMapPrompt(t as never, { map, file: 'x.json', environment: 'Production', reading, locale: 'en' })
    expect(bare).not.toContain('deviate most')
    expect(bare).not.toContain('alert limits')
    expect(bare).not.toContain('Logs and errors')
  })
})

describe('FlowSequenceSvg', () => {
  it('draws one lifeline per node, one arrow per edge in file order, and the execution order with a trace', () => {
    const base = sequenceLayout(map)
    expect(base.participants.map((p) => p.id)[0]).toBe('bff')
    expect(base.messages.map((m) => m.key)).toEqual(map.edges.map((_, i) => edgeId(map, i)))
    const trace: FlowTrace = { traceId: 't1', at: 1, durationMs: 900, outcome: 'success', missing: [], unmapped: [], hops: { 'orders->payments': { key: 'orders->payments', of: 'edges', startMs: 10, durationMs: 300, count: 1, failed: false }, 'bff->orders': { key: 'bff->orders', of: 'edges', startMs: 200, durationMs: 100, count: 1, failed: false } } }
    const ordered = sequenceLayout(map, trace)
    expect(ordered.messages[0]!.key).toBe('orders->payments')
    expect(ordered.messages[1]!.key).toBe('bff->orders')
    const html = renderToStaticMarkup(createElement(FlowSequenceSvg, { map, reading, flow: false, picked: { of: 'edges', key: 'bff->orders' }, onPick: () => {} } as never))
    expect(html).toContain('data-testid="flow-sequence-svg"')
    expect(html).toContain('data-part="nodes:bff"')
    expect(html).toContain('data-part="edges:bff-&gt;orders"')
    expect(html).toContain('880 ms')
  })
})
