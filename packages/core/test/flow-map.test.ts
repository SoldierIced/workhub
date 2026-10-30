import { describe, expect, it } from 'vitest'
import { edgeId, flowColumns, flowCoverage, flowEntry, flowMeasures, flowPartLabel, formatMs, layoutFlowMap, matchFlowTrace, parseFlowMap, pathMidpoint, pathPointAt, placeFlowLabels, rankFlowParts, routeFlowEdge, type FlowMap, type FlowMapReading, type FlowTraceDoc } from '../src'

/** A synthetic checkout flow: a BFF, an orchestrator, a payment service, an acquirer and a queue to fulfilment. */
const checkout = {
  version: 1,
  id: 'checkout',
  name: 'Checkout',
  phases: [{ label: 'Checkout · sync', fromColumn: 0, toColumn: 2 }, { label: 'Fulfilment · async', fromColumn: 3, toColumn: 4 }],
  lanes: [{ id: 'app', label: '01 / App' }, { id: 'core', label: '02 / Core' }, { id: 'ex', label: 'EX / External and queues', kind: 'exception' }],
  nodes: [
    { id: 'bff', lane: 'app', label: 'shop-bff', kind: 'app', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' } },
    { id: 'orders', lane: 'core', label: 'orders', kind: 'orchestrator' },
    { id: 'payments', lane: 'core', label: 'payments' },
    { id: 'acquirer', lane: 'ex', label: 'Acquirer', kind: 'external' },
    { id: 'events', lane: 'ex', label: 'order-events', kind: 'queue' },
    { id: 'fulfilment', lane: 'core', label: 'fulfilment', kind: 'worker' }
  ],
  edges: [
    { from: 'bff', to: 'orders', label: '1,2 s', measure: { type: 'apm.span', service: 'shop-bff', destination: 'orders' } },
    { from: 'orders', to: 'payments' },
    { from: 'payments', to: 'acquirer', label: 'authorize' },
    { from: 'acquirer', to: 'payments', label: 'webhook', kind: 'async' },
    { from: 'orders', to: 'events', kind: 'async' },
    { from: 'events', to: 'fulfilment', kind: 'wait', label: 'queue' }
  ],
  stages: [{ id: 'placed', label: 'Placed' }, { id: 'paid', label: 'Paid' }, { id: 'shipped', label: 'Shipped' }],
  stagesLane: 'core'
}

describe('parseFlowMap', () => {
  it('accepts a valid map and fills the defaults', () => {
    const r = parseFlowMap(checkout)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.map.nodes[1]).toMatchObject({ kind: 'orchestrator' })
    expect(r.map.nodes[2]).toMatchObject({ kind: 'service' })
    expect(r.map.edges[0]).toMatchObject({ kind: 'sync', emphasis: false, entry: 'side' })
    expect(r.map.lanes[2]).toMatchObject({ kind: 'exception' })
  })

  it('names schema errors by path and catches dangling references', () => {
    const bad = parseFlowMap({ ...checkout, version: 2 })
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.errors[0]).toContain('version')
    const refs = parseFlowMap({ ...checkout, nodes: [...checkout.nodes, { id: 'ghost', lane: 'nowhere', label: 'x' }], edges: [...checkout.edges, { from: 'bff', to: 'missing' }, { from: 'bff', to: 'bff' }] })
    expect(refs.ok).toBe(false)
    if (!refs.ok) expect(refs.errors).toEqual(expect.arrayContaining([expect.stringContaining('unknown lane "nowhere"'), expect.stringContaining('unknown node "missing"'), expect.stringContaining('same node')]))
    const dup = parseFlowMap({ ...checkout, nodes: [...checkout.nodes, { id: 'bff', lane: 'app', label: 'again' }] })
    if (!dup.ok) expect(dup.errors).toEqual(expect.arrayContaining([expect.stringContaining('node "bff" is defined twice')]))
    expect(parseFlowMap({ ...checkout, id: 'bad id' }).ok).toBe(false)
  })
})

describe('layout', () => {
  const map = (parseFlowMap(checkout) as { ok: true; map: FlowMap }).map

  it('puts nodes in columns by the longest forward path, ignoring edges back to earlier nodes', () => {
    expect(flowColumns(map)).toEqual({ bff: 0, orders: 1, payments: 2, acquirer: 3, events: 2, fulfilment: 3 })
    // An explicit column is kept and pulls its successors.
    const pinned = { ...map, nodes: map.nodes.map((n) => (n.id === 'events' ? { ...n, column: 4 } : n)) }
    expect(flowColumns(pinned)).toMatchObject({ events: 4, fulfilment: 5 })
  })

  it('lays lanes out as rows with stacked nodes, the stage chips in their lane and phase headers over the columns', () => {
    const l = layoutFlowMap(map)
    expect(l.lanes.map((x) => x.id)).toEqual(['app', 'core', 'ex'])
    expect(l.nodes.bff).toMatchObject({ x: l.columnX[0], w: 170, h: 46 })
    expect(l.nodes.orders!.x).toBe(l.columnX[1])
    expect(l.nodes.orders!.y).toBeGreaterThan(l.nodes.bff!.y)
    // Two core nodes in different columns share a row; the lane fits one row.
    expect(l.nodes.payments!.y).toBe(l.nodes.orders!.y)
    expect(l.stages?.chips.paid).toBeDefined()
    expect(l.stages!.box.x).toBeGreaterThan(l.nodes.fulfilment!.x + 170)
    expect(l.phases[0]).toMatchObject({ label: 'Checkout · sync' })
    expect(l.phases[1]!.x1).toBeGreaterThan(l.phases[0]!.x2)
    expect(l.width).toBeGreaterThanOrEqual(l.stages!.box.x + l.stages!.box.w)
    expect(l.height).toBe(l.lanes[2]!.y + l.lanes[2]!.h + 10)
  })

  it('stacks two nodes of one lane and column as rows and grows the lane', () => {
    const two = { ...map, nodes: [...map.nodes, { id: 'risk', lane: 'core', label: 'risk', kind: 'service' as const }], edges: [...map.edges, { from: 'orders', to: 'risk', kind: 'sync' as const, emphasis: false, entry: 'side' as const }] }
    const l = layoutFlowMap(two)
    expect(l.nodes.risk!.x).toBe(l.nodes.payments!.x)
    expect(l.nodes.risk!.y).toBeGreaterThan(l.nodes.payments!.y)
    expect(l.lanes[1]!.h).toBeGreaterThan(layoutFlowMap(map).lanes[1]!.h)
  })
})

describe('pathMidpoint', () => {
  it('finds the middle of straight and cornered routes without a DOM', () => {
    expect(pathMidpoint('M 270 123 L 394 123')).toEqual({ x: 332, y: 123 })
    expect(pathMidpoint('M 0 0 L 100 0 L 100 100')).toEqual({ x: 100, y: 0 })
    // A corner counts as its chord: here the middle of the route falls halfway along that chord.
    const m = pathMidpoint('M 0 0 L 100 0 Q 110 0 110 10 L 110 110')
    expect(m.x).toBeCloseTo(105)
    expect(m.y).toBeCloseTo(5)
    expect(pathMidpoint('')).toEqual({ x: 0, y: 0 })
  })
})

describe('routeFlowEdge', () => {
  const a = { x: 100, y: 100, w: 170, h: 46 }
  it('draws straight lines on one row or one column, else runs vertically in the gutter next to the source', () => {
    expect(routeFlowEdge(a, { x: 400, y: 100, w: 170, h: 46 })).toBe('M 270 123 L 394 123')
    expect(routeFlowEdge(a, { x: 100, y: 300, w: 170, h: 46 })).toBe('M 185 146 L 185 294')
    const l = routeFlowEdge(a, { x: 400, y: 300, w: 170, h: 46 })
    expect(l.startsWith('M 270 123 L 274 123 Q 282 123 282 131 L 282 315')).toBe(true)
    expect(l.endsWith('L 394 323')).toBe(true)
    // Leftwards and upwards: the gutter is on the left of the source.
    expect(routeFlowEdge({ x: 400, y: 300, w: 170, h: 46 }, a).startsWith('M 400 323 L 396 323 Q 388 323 388 315')).toBe(true)
  })

  it('enters from above on `top` and offsets parallel edges', () => {
    const t = routeFlowEdge(a, { x: 400, y: 300, w: 170, h: 46 }, 0, 'top')
    expect(t.endsWith('L 485 294')).toBe(true)
    expect(routeFlowEdge(a, { x: 400, y: 100, w: 170, h: 46 }, 1)).toBe('M 270 130 L 394 130')
  })
})

describe('measures and ids', () => {
  const map = (parseFlowMap(checkout) as { ok: true; map: FlowMap }).map
  it('derives edge ids from the ends, numbering repeats, and lists every measure with its key', () => {
    expect(edgeId(map, 0)).toBe('bff->orders')
    const twice = { ...map, edges: [...map.edges, { ...map.edges[0]! }] }
    expect(edgeId(twice, twice.edges.length - 1)).toBe('bff->orders#2')
    expect(flowMeasures(map)).toEqual([
      { key: 'bff->orders', of: 'edges', measure: { type: 'apm.span', service: 'shop-bff', destination: 'orders' } },
      { key: 'bff', of: 'nodes', measure: { type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' } }
    ])
  })

  it('formats durations', () => {
    expect(formatMs(340)).toBe('340 ms')
    expect(formatMs(1234)).toBe('1.2 s')
    expect(formatMs(12_345)).toBe('12 s')
    expect(formatMs(125_000)).toBe('2 m 05 s')
  })
})

describe('executions (traces)', () => {
  const base = (parseFlowMap(checkout) as { ok: true; map: FlowMap }).map
  // A second measured node downstream, so the entry is the leftmost transaction, not the first in the file.
  const map: FlowMap = {
    ...base,
    nodes: [...base.nodes, { id: 'orders', lane: 'app', label: 'orders', kind: 'service', measure: { type: 'apm.transaction', service: 'orders', transaction: 'POST /orders' } }],
    edges: [...base.edges, { from: 'bff', to: 'orders', kind: 'sync', emphasis: false, entry: 'side', measure: { type: 'apm.span', service: 'shop-bff', destination: 'orders' } }],
    stages: [{ id: 'paid', label: 'Paid', measure: { type: 'apm.transaction', service: 'payments', transaction: 'POST /pay' } }]
  }

  it('takes the entry from the file, else the leftmost node with a transaction measure', () => {
    expect(flowEntry(map)).toEqual({ type: 'apm.transaction', service: 'shop-bff', transaction: 'POST /checkout' })
    expect(flowEntry({ ...map, entry: { type: 'apm.transaction', service: 'orders', transaction: 'POST /orders' } })).toEqual({ type: 'apm.transaction', service: 'orders', transaction: 'POST /orders' })
    expect(flowEntry({ ...map, nodes: map.nodes.map((n) => ({ ...n, measure: undefined })), stages: [] })).toBeNull()
  })

  it('lays the documents of one trace over the map: hops by measure (summed when repeated), missing parts, unmapped work largest first', () => {
    const t0 = 1_700_000_000_000
    const docs: FlowTraceDoc[] = [
      { event: 'transaction', service: 'shop-bff', name: 'POST /checkout', at: t0, durationMs: 900, outcome: 'success' },
      { event: 'span', service: 'shop-bff', name: 'POST orders', destination: 'orders', at: t0 + 20, durationMs: 300 },
      { event: 'span', service: 'shop-bff', name: 'POST orders', destination: 'orders', at: t0 + 400, durationMs: 100, outcome: 'failure' },
      { event: 'transaction', service: 'orders', name: 'POST /orders', at: t0 + 30, durationMs: 250, outcome: 'success' },
      { event: 'span', service: 'orders', name: 'INSERT orders', destination: 'postgresql', at: t0 + 50, durationMs: 120 },
      { event: 'span', service: 'orders', name: 'INSERT lines', destination: 'postgresql', at: t0 + 180, durationMs: 60 },
      { event: 'transaction', service: 'mailer', name: 'send receipt', at: t0 + 700, durationMs: 40 }
    ]
    const trace = matchFlowTrace(map, 'abc', docs)
    expect(trace).toMatchObject({ traceId: 'abc', at: t0, durationMs: 900, outcome: 'success' })
    expect(trace.hops.bff).toEqual({ key: 'bff', of: 'nodes', startMs: 0, durationMs: 900, count: 1, failed: false })
    expect(trace.hops['bff->orders#2']).toEqual({ key: 'bff->orders#2', of: 'edges', startMs: 20, durationMs: 400, count: 2, failed: true })
    expect(trace.hops.orders).toMatchObject({ startMs: 30, durationMs: 250 })
    expect(trace.missing).toEqual(['paid'])
    expect(trace.unmapped.map((u) => [u.event, u.service, u.destination ?? u.name, u.durationMs, u.count])).toEqual([
      ['span', 'orders', 'postgresql', 180, 2],
      ['transaction', 'mailer', 'send receipt', 40, 1]
    ])
    expect(trace.unmapped[0]).toMatchObject({ startMs: 50 })
  })

  it('without the entry transaction the first transaction is the root; without any, the first document', () => {
    const t0 = 1_700_000_000_000
    const only = matchFlowTrace(map, 'x', [{ event: 'span', service: 'shop-bff', name: 'a', destination: 'orders', at: t0 + 10, durationMs: 50 }])
    expect(only).toMatchObject({ at: t0 + 10, durationMs: 50, outcome: 'unknown' })
    expect(only.hops['bff->orders#2']?.startMs).toBe(0)
  })
})

describe('reading the numbers', () => {
  const map = (parseFlowMap(checkout) as { ok: true; map: FlowMap }).map
  const hourly = [{ at: 0, count: 1, p50Ms: 1, p95Ms: 1 }]
  const reading: FlowMapReading = {
    at: 1,
    windowHours: 24,
    nodes: { bff: { count: 100, p50Ms: 200, p95Ms: 600, hourly } },
    edges: { 'bff->orders': { count: 98, p50Ms: 100, p95Ms: 400, hourly } },
    stages: {},
    errors: {}
  }

  it('ranks measured parts slowest first with each one\'s share of the summed p95', () => {
    const ranks = rankFlowParts(map, reading)
    expect(ranks.map((r) => [r.key, r.of, Math.round(r.share * 100)])).toEqual([
      ['bff', 'nodes', 60],
      ['bff->orders', 'edges', 40]
    ])
    expect(ranks[0]!.label).toBe('shop-bff')
    expect(ranks[1]!.label.startsWith('shop-bff → orders')).toBe(true)
    // A measure with no calls in the window is not ranked.
    expect(rankFlowParts(map, { ...reading, edges: { 'bff->orders': { count: 0, p50Ms: 0, p95Ms: 0, hourly: [] } } })).toHaveLength(1)
  })

  it('labels parts: a node or stage by label, an edge by its ends and label', () => {
    expect(flowPartLabel(map, { of: 'nodes', key: 'bff' })).toBe('shop-bff')
    expect(flowPartLabel({ ...map, edges: [{ ...map.edges[0]!, label: undefined }] }, { of: 'edges', key: 'bff->orders' })).toBe('shop-bff → orders')
    expect(flowPartLabel({ ...map, edges: [{ ...map.edges[0]!, label: 'place' }] }, { of: 'edges', key: 'bff->orders' })).toBe('shop-bff → orders · place')
    expect(flowPartLabel(map, { of: 'stages', key: 'nope' })).toBe('nope')
  })

  it('reports coverage: unmeasured parts, measured parts with no data, failed reads', () => {
    const c = flowCoverage(map, { ...reading, edges: { 'bff->orders': { count: 0, p50Ms: 0, p95Ms: 0, hourly: [] } } })
    expect(c).toMatchObject({ total: map.edges.length + map.nodes.length + map.stages.length, measured: 2 })
    expect(c.unmeasured.map((p) => p.key)).toContain('orders')
    expect(c.unmeasured.map((p) => p.key)).not.toContain('bff')
    expect(c.noData.map((p) => p.key)).toEqual(['bff->orders'])
    expect(c.failed).toEqual([])
    const failed = flowCoverage(map, { ...reading, nodes: {}, errors: { bff: 'no such index' } })
    expect(failed.failed).toEqual([{ of: 'nodes', key: 'bff', label: 'shop-bff', error: 'no such index' }])
    // Without a reading only the file is known: nothing has data yet, nothing failed.
    expect(flowCoverage(map)).toMatchObject({ measured: 2, noData: [], failed: [] })
  })
})

describe('placeFlowLabels', () => {
  it('keeps a label at the middle of a free path and moves it off a box it would cover', () => {
    const box = { x: 100, y: 80, w: 170, h: 46 }
    const [freeSpot, covered] = placeFlowLabels(
      [
        { d: 'M 0 200 L 400 200', width: 60 },
        // A short hop whose whole path runs through the box.
        { d: 'M 110 103 L 260 103', width: 60 }
      ],
      [box]
    )
    expect(freeSpot).toEqual({ x: 200, y: 200 })
    expect(covered!.anchor).toEqual({ x: 185, y: 103 })
    expect(covered!.y).toBeLessThan(box.y - 8)
  })

  it('does not stack two labels on the same spot', () => {
    const [a, b] = placeFlowLabels([{ d: 'M 0 0 L 300 0', width: 80 }, { d: 'M 0 0 L 300 0', width: 80 }], [])
    expect(a).toEqual({ x: 150, y: 0 })
    expect(Math.abs(b!.x - 150)).toBeGreaterThan(20)
  })

  it('pathPointAt walks the path by length', () => {
    expect(pathPointAt('M 0 0 L 100 0 L 100 100', 0.25)).toEqual({ x: 50, y: 0 })
    expect(pathPointAt('M 0 0 L 100 0 L 100 100', 1)).toEqual({ x: 100, y: 100 })
  })
})
