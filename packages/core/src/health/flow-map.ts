/**
 * Flow maps: a diagram of one business flow across services (lanes, nodes, calls and messages),
 * written once as a JSON file and measured live from the environment's APM data. Nothing here
 * names a company, a service or an index: the map file and the profile's environment do.
 *
 * The file is the contract an agent or a person writes (see `docs/user-guide/flow-maps.md` and
 * the `workhub-flow-map` skill); this module validates it, lays it out and routes its edges.
 * Rendering and reading the numbers live elsewhere (renderer, health provider).
 */
import { z } from 'zod'

export const FLOW_MAP_VERSION = 1

/** How one number of the map is read from the environment. */
const measure = z.discriminatedUnion('type', [
  /** Duration of a transaction (an entry point: an HTTP route, a gRPC method, a consumer). */
  z.object({ type: z.literal('apm.transaction'), service: z.string().min(1), transaction: z.string().min(1) }),
  /** Duration of the outgoing calls of a service to a destination (`span.destination.service.resource`). */
  z.object({ type: z.literal('apm.span'), service: z.string().min(1), destination: z.string().min(1) })
])

const id = z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/i, 'an id uses letters, digits, "-", "_" or "."')

const lane = z.object({
  id,
  label: z.string().min(1),
  /** `exception` draws the lane dashed, for the external and asynchronous parts of a flow. */
  kind: z.enum(['normal', 'exception']).default('normal')
})

export const FLOW_NODE_KINDS = ['app', 'service', 'orchestrator', 'worker', 'queue', 'external', 'datastore'] as const

const node = z.object({
  id,
  lane: id,
  label: z.string().min(1).max(40),
  subtitle: z.string().max(60).optional(),
  kind: z.enum(FLOW_NODE_KINDS).default('service'),
  /** Where the node sits left to right; computed from the edges when unset. */
  column: z.number().int().min(0).max(20).optional(),
  /** Longer text shown on hover. */
  note: z.string().max(400).optional(),
  measure: measure.optional()
})

const edge = z.object({
  id: id.optional(),
  from: id,
  to: id,
  label: z.string().max(40).optional(),
  /** `sync`: a call that waits; `async`: a message; `wait`: time spent waiting in a queue (drawn in red). */
  kind: z.enum(['sync', 'async', 'wait']).default('sync'),
  emphasis: z.boolean().default(false),
  /** `top` enters the target from above (through the corridor between lanes) instead of from its side. */
  entry: z.enum(['side', 'top']).default('side'),
  measure: measure.optional()
})

const stage = z.object({ id, label: z.string().min(1).max(30), measure: measure.optional() })

/** Limits a part must stay under: p95 in milliseconds, failure share between 0 and 1. */
const flowThreshold = z.object({ p95Ms: z.number().positive().optional(), errorRate: z.number().min(0).max(1).optional() })

export const flowMapSchema = z.object({
  version: z.literal(FLOW_MAP_VERSION),
  id,
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  /** The health environment (by id) whose data measures the map; the screen asks when unset. */
  environmentId: z.string().optional(),
  /** Phase headers over the columns, left to right, e.g. "Checkout · 2 s", "Fulfilment · async". */
  phases: z.array(z.object({ label: z.string().min(1).max(40), fromColumn: z.number().int().min(0), toColumn: z.number().int().min(0) })).default([]),
  lanes: z.array(lane).min(1).max(12),
  nodes: z.array(node).min(1).max(60),
  edges: z.array(edge).max(120).default([]),
  /** Named checkpoints of the flow, drawn as chips in a group (a saga's steps, say). */
  stages: z.array(stage).max(12).default([]),
  /** The lane the stage chips are drawn in; the first lane when unset. */
  stagesLane: id.optional(),
  /**
   * The transaction that starts the flow, used to list its executions (traces). When unset, the
   * first node with a transaction measure (left to right) is the entry.
   */
  entry: measure.optional(),
  /**
   * When to notify about the flow (checked every minute over the last hour, see `flowAlertsOf`):
   * a p95 above `p95Ms` or a failure share above `errorRate`, for every measured part or per part
   * (keyed like the Parts tab: node id, stage id, edge id or `from->to`). A part's entry wins.
   */
  alerts: flowThreshold.extend({ parts: z.record(z.string(), flowThreshold).default({}) }).optional()
})

export type FlowThreshold = z.infer<typeof flowThreshold>
export type FlowMeasure = z.infer<typeof measure>
export type FlowLane = z.infer<typeof lane>
export type FlowNode = z.infer<typeof node>
export type FlowEdge = z.infer<typeof edge>
export type FlowStage = z.infer<typeof stage>
export type FlowMap = z.infer<typeof flowMapSchema>
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number]

export type FlowMapParse = { ok: true; map: FlowMap } | { ok: false; errors: string[] }

/** Validates a map file: the schema, then the references between lanes, nodes and edges. */
export function parseFlowMap(input: unknown): FlowMapParse {
  const parsed = flowMapSchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  const map = parsed.data
  const errors: string[] = []
  const dup = (what: string, ids: string[]) => {
    const seen = new Set<string>()
    for (const v of ids) {
      if (seen.has(v)) errors.push(`${what} "${v}" is defined twice`)
      seen.add(v)
    }
  }
  dup('lane', map.lanes.map((l) => l.id))
  dup('node', map.nodes.map((n) => n.id))
  dup('stage', map.stages.map((s) => s.id))
  dup('edge', map.edges.map((e) => e.id).filter((e): e is string => e !== undefined))
  const lanes = new Set(map.lanes.map((l) => l.id))
  const nodes = new Set(map.nodes.map((n) => n.id))
  for (const n of map.nodes) if (!lanes.has(n.lane)) errors.push(`node "${n.id}": unknown lane "${n.lane}"`)
  map.edges.forEach((e, i) => {
    for (const end of [e.from, e.to]) if (!nodes.has(end)) errors.push(`edge ${e.id ?? i}: unknown node "${end}"`)
    if (e.from === e.to) errors.push(`edge ${e.id ?? i}: from and to are the same node`)
  })
  if (map.stagesLane && !lanes.has(map.stagesLane)) errors.push(`stagesLane: unknown lane "${map.stagesLane}"`)
  for (const p of map.phases) if (p.toColumn < p.fromColumn) errors.push(`phase "${p.label}": toColumn is before fromColumn`)
  if (map.alerts) {
    const measured = new Map(flowParts(map).map((p) => [p.key, p.measured]))
    for (const key of Object.keys(map.alerts.parts)) {
      if (!measured.has(key)) errors.push(`alerts.parts: unknown part "${key}"`)
      else if (!measured.get(key)) errors.push(`alerts.parts: part "${key}" has no measure`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, map }
}

/** The id an edge is read and drawn by: its own, else `from->to#n` for the n-th edge between the pair. */
export function edgeId(map: Pick<FlowMap, 'edges'>, index: number): string {
  const e = map.edges[index]!
  if (e.id) return e.id
  const n = map.edges.slice(0, index).filter((o) => !o.id && o.from === e.from && o.to === e.to).length
  return n ? `${e.from}->${e.to}#${n + 1}` : `${e.from}->${e.to}`
}

/**
 * Columns from the edges: a node's column is the longest path to it from a source, counting
 * forward edges only (an edge back to an earlier node, as a reply or a loop, adds nothing).
 * Explicit `column`s are kept and pull their successors after them.
 */
export function flowColumns(map: Pick<FlowMap, 'nodes' | 'edges'>): Record<string, number> {
  const col: Record<string, number> = {}
  const order = map.nodes.map((n) => n.id)
  const index = new Map(order.map((n, i) => [n, i]))
  // Forward edges only, in node order: the author lists nodes roughly in flow order, so a back edge is one to an earlier node.
  const next = new Map<string, string[]>()
  for (const e of map.edges) if ((index.get(e.to) ?? 0) > (index.get(e.from) ?? 0)) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const fixed = new Map(map.nodes.filter((n) => n.column !== undefined).map((n) => [n.id, n.column!]))
  const depth = (n: string, seen: Set<string>): number => {
    if (col[n] !== undefined) return col[n]
    if (seen.has(n)) return 0
    seen.add(n)
    let d = 0
    for (const e of map.edges) if (e.to === n && (index.get(e.to) ?? 0) > (index.get(e.from) ?? 0)) d = Math.max(d, depth(e.from, seen) + 1)
    col[n] = Math.max(d, fixed.get(n) ?? 0)
    return col[n]
  }
  for (const n of order) depth(n, new Set())
  return col
}

export interface FlowBox {
  x: number
  y: number
  w: number
  h: number
}

export interface FlowLayout {
  width: number
  height: number
  lanes: { id: string; label: string; kind: 'normal' | 'exception'; y: number; h: number }[]
  nodes: Record<string, FlowBox>
  /** Column index -> x of the column's left edge. */
  columnX: number[]
  phases: { label: string; x1: number; x2: number }[]
  stages?: { box: FlowBox; chips: Record<string, FlowBox> }
}

export const FLOW_GEOMETRY = {
  nodeW: 170,
  nodeH: 46,
  columnW: 190,
  left: 40,
  top: 70,
  laneGap: 10,
  lanePad: 26,
  rowGap: 34,
  chipW: 112,
  chipH: 30
}

/**
 * Lays the map out on a grid: lanes are rows, columns come from `flowColumns`. Nodes of one lane in
 * the same column stack as rows. Vertical edge segments run in the gutters between columns, so a
 * route never crosses a node of another column.
 */
export function layoutFlowMap(map: FlowMap): FlowLayout {
  const G = FLOW_GEOMETRY
  const columns = flowColumns(map)
  const maxCol = Math.max(0, ...Object.values(columns))
  const columnX = Array.from({ length: maxCol + 1 }, (_, c) => G.left + 20 + c * G.columnW)
  const width = columnX[maxCol]! + G.nodeW + 40
  const nodes: Record<string, FlowBox> = {}
  const lanes: FlowLayout['lanes'] = []
  let y = G.top
  let stages: FlowLayout['stages']
  const stagesLane = map.stagesLane ?? map.lanes[0]!.id
  for (const lane of map.lanes) {
    const own = map.nodes.filter((n) => n.lane === lane.id)
    const rows = new Map<number, number>()
    let laneRows = 1
    for (const n of own) {
      const c = columns[n.id] ?? 0
      const r = rows.get(c) ?? 0
      rows.set(c, r + 1)
      laneRows = Math.max(laneRows, r + 1)
      nodes[n.id] = { x: columnX[c]!, y: y + G.lanePad + r * (G.nodeH + G.rowGap), w: G.nodeW, h: G.nodeH }
    }
    let h = G.lanePad + laneRows * G.nodeH + (laneRows - 1) * G.rowGap + 16
    if (map.stages.length && lane.id === stagesLane) {
      // The stage chips sit in a group to the right of the lane's nodes, or across the lane when it has none.
      const used = own.length ? Math.max(...own.map((n) => nodes[n.id]!.x + G.nodeW)) + 40 : columnX[0]!
      const chips: Record<string, FlowBox> = {}
      map.stages.forEach((s, i) => (chips[s.id] = { x: used + 14 + i * (G.chipW + 8), y: y + G.lanePad + 14, w: G.chipW, h: G.chipH }))
      const box = { x: used, y: y + G.lanePad - 2, w: 14 + map.stages.length * (G.chipW + 8) + 6, h: G.chipH + 30 }
      stages = { box, chips }
      h = Math.max(h, G.lanePad + box.h + 12)
    }
    lanes.push({ id: lane.id, label: lane.label, kind: lane.kind, y, h })
    y += h + G.laneGap
  }
  const stagesRight = stages ? stages.box.x + stages.box.w + 40 : 0
  const totalWidth = Math.max(width, stagesRight)
  const phases = map.phases.map((p) => ({ label: p.label, x1: columnX[Math.min(p.fromColumn, maxCol)]! - 4, x2: columnX[Math.min(p.toColumn, maxCol)]! + G.nodeW + 4 }))
  return { width: totalWidth, height: y - G.laneGap + 10, lanes, nodes, columnX, phases, ...(stages ? { stages } : {}) }
}

/**
 * The SVG path of an edge. Same row: straight. Same column: straight vertical. Otherwise the edge
 * leaves the source sideways into the gutter next to it, runs vertically there and enters the
 * target from the side; `top` enters from above through the corridor between lanes. `spread`
 * offsets parallel edges between the same nodes.
 */
export function routeFlowEdge(a: FlowBox, b: FlowBox, spread = 0, entry: 'side' | 'top' = 'side'): string {
  const A = { cx: a.x + a.w / 2, cy: a.y + a.h / 2, r: a.x + a.w, b: a.y + a.h, x: a.x, y: a.y }
  const B = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: b.x + b.w, b: b.y + b.h, x: b.x, y: b.y }
  const off = spread * 7
  const r = 8
  if (Math.abs(A.cy - B.cy) < 2) return A.cx < B.cx ? `M ${A.r} ${A.cy + off} L ${B.x - 6} ${B.cy + off}` : `M ${A.x} ${A.cy + off} L ${B.r + 6} ${B.cy + off}`
  if (Math.abs(A.cx - B.cx) < 2) {
    const down = B.y > A.b
    return `M ${A.cx + off} ${down ? A.b : A.y} L ${B.cx + off} ${down ? B.y - 6 : B.b + 6}`
  }
  const right = B.cx > A.cx
  const gx = right ? A.r + 12 + off : A.x - 12 + off
  const sy = A.cy + off
  const sx = right ? r : -r
  const bend = (y1: number, y2: number) => (y2 > y1 ? r : -r)
  if (entry === 'top') {
    const ty = B.y - 14
    return `M ${right ? A.r : A.x} ${sy} L ${gx - sx} ${sy} Q ${gx} ${sy} ${gx} ${sy + bend(sy, ty)} L ${gx} ${ty - bend(sy, ty)} Q ${gx} ${ty} ${gx + sx} ${ty} L ${B.cx - sx} ${ty} Q ${B.cx} ${ty} ${B.cx} ${ty + r} L ${B.cx} ${B.y - 6}`
  }
  const ey = B.cy + off
  const ex = right ? B.x - 6 : B.r + 6
  return `M ${right ? A.r : A.x} ${sy} L ${gx - sx} ${sy} Q ${gx} ${sy} ${gx} ${sy + bend(sy, ey)} L ${gx} ${ey - bend(sy, ey)} Q ${gx} ${ey} ${gx + sx} ${ey} L ${ex} ${ey}`
}

/** One hour of a measure: how many came in and how slow they were. */
export interface FlowHourPoint {
  /** Epoch milliseconds of the hour's start. */
  at: number
  count: number
  p50Ms: number
  p95Ms: number
}

/** A part's numbers over a comparison window: the same length right before the reading's (`previous`), or the last seven days (`weekly`). */
export interface FlowBaseline {
  count: number
  p50Ms: number
  p95Ms: number
  errorRate?: number
}

/** How often one result came back (`transaction.result`, e.g. "HTTP 4xx", or a gRPC status), most frequent first. */
export interface FlowCodeCount {
  code: string
  count: number
}

/** One measured number of the map, over the reading's window. */
export interface FlowTiming {
  count: number
  p50Ms: number
  p95Ms: number
  p99Ms?: number
  /** Share of failed calls (`event.outcome: failure`), when the provider reads outcomes. */
  errorRate?: number
  /** Failed calls in the window. */
  failed?: number
  /** Calls per minute over the window. */
  perMinute?: number
  /** The results of the window (transactions only), most frequent first. */
  codes?: FlowCodeCount[]
  previous?: FlowBaseline
  weekly?: FlowBaseline
  /** The window hour by hour, oldest first; hours without data have count 0. */
  hourly: FlowHourPoint[]
}

/** The numbers of a map at one time: by edge id (`edgeId`), node id and stage id. */
export interface FlowMapReading {
  at: number
  windowHours: number
  edges: Record<string, FlowTiming>
  nodes: Record<string, FlowTiming>
  stages: Record<string, FlowTiming>
  /** Measures that could not be read, by the same keys, with the reason. */
  errors: Record<string, string>
}

/** The hour a measure was slowest (highest p95 with at least one call), or null without data. */
export function worstHour(timing: Pick<FlowTiming, 'hourly'>): FlowHourPoint | null {
  let worst: FlowHourPoint | null = null
  for (const h of timing.hourly) if (h.count > 0 && (!worst || h.p95Ms > worst.p95Ms)) worst = h
  return worst
}

/** Every measure of a map with the key its value is stored under. */
export function flowMeasures(map: FlowMap): { key: string; of: 'edges' | 'nodes' | 'stages'; measure: FlowMeasure }[] {
  const out: { key: string; of: 'edges' | 'nodes' | 'stages'; measure: FlowMeasure }[] = []
  map.edges.forEach((e, i) => e.measure && out.push({ key: edgeId(map, i), of: 'edges', measure: e.measure }))
  for (const n of map.nodes) if (n.measure) out.push({ key: n.id, of: 'nodes', measure: n.measure })
  for (const s of map.stages) if (s.measure) out.push({ key: s.id, of: 'stages', measure: s.measure })
  return out
}

/**
 * The point halfway along a path from `routeFlowEdge` (M, L and Q commands), used to place the edge label.
 * Corners are short, so each Q is treated as the straight line between its ends; no DOM measurement is needed.
 */
export function pathMidpoint(d: string): { x: number; y: number } {
  return pathPointAt(d, 0.5)
}

/** The point `fraction` (0–1) of the way along an M/L/Q path, by length; a curve counts as the chord to its end. */
export function pathPointAt(d: string, fraction: number): { x: number; y: number } {
  const tokens = d.trim().split(/[\s,]+/)
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === 'M' || t === 'L') points.push({ x: Number(tokens[++i]), y: Number(tokens[++i]) })
    else if (t === 'Q') { i += 2; points.push({ x: Number(tokens[++i]), y: Number(tokens[++i]) }) }
  }
  if (points.length === 0) return { x: 0, y: 0 }
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y))
  let left = lengths.reduce((a, b) => a + b, 0) * Math.min(1, Math.max(0, fraction))
  for (let i = 0; i < lengths.length; i++) {
    const seg = lengths[i]!
    if (left <= seg) {
      const a = points[i]!, b = points[i + 1]!, f = seg === 0 ? 0 : left / seg
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    }
    left -= seg
  }
  return points[points.length - 1]!
}

/** Where a label was put, and the point of its path it belongs to when it had to move off the path. */
export interface FlowLabelSpot {
  x: number
  y: number
  anchor?: { x: number; y: number }
}

/** Fractions of the path tried for a label, nearest the middle first. */
const LABEL_FRACTIONS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88]

/**
 * Where each edge label goes: the spot nearest the middle of its path where the pill covers no
 * node and no label already placed; when the whole path is covered (a short hop between
 * neighbouring boxes), the pill moves above or below the middle, with `anchor` pointing back at it.
 */
export function placeFlowLabels(labels: readonly { d: string; width: number; height?: number }[], obstacles: readonly FlowBox[]): FlowLabelSpot[] {
  const pad = 6
  const placed: FlowBox[] = []
  const hits = (r: FlowBox, boxes: readonly FlowBox[]) => boxes.some((b) => r.x < b.x + b.w + pad && r.x + r.w + pad > b.x && r.y < b.y + b.h + pad && r.y + r.h + pad > b.y)
  const free = (r: FlowBox) => !hits(r, obstacles) && !hits(r, placed)
  return labels.map((l) => {
    const h = l.height ?? 16
    const rect = (p: { x: number; y: number }): FlowBox => ({ x: p.x - l.width / 2, y: p.y - h / 2, w: l.width, h })
    for (const f of LABEL_FRACTIONS) {
      const p = pathPointAt(l.d, f)
      const r = rect(p)
      if (free(r)) {
        placed.push(r)
        return p
      }
    }
    // Nothing free on the path: beside it first (a vertical run in a narrow gutter), then above or below.
    const mid = pathPointAt(l.d, 0.5)
    const side = l.width / 2 + 8
    for (const [dx, dy] of [[-side, 0], [side, 0], [0, -40], [0, 40], [0, -60], [0, 60], [-side, -20], [side, -20], [0, -80], [0, 80]] as const) {
      const p = { x: mid.x + dx, y: mid.y + dy }
      const r = rect(p)
      if (free(r)) {
        placed.push(r)
        return { ...p, anchor: mid }
      }
    }
    placed.push(rect(mid))
    return mid
  })
}

/** `1.2 s`, `340 ms`, `2 m 05 s`: the label of a duration. */
export function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)} m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`
  return `${Math.round(ms)} ms`
}

// Executions (traces) -------------------------------------------------------------------------

/** One execution of the flow, as the list of recent executions shows it. */
export interface FlowTraceSummary {
  traceId: string
  /** Epoch milliseconds of the entry transaction's start. */
  at: number
  durationMs: number
  outcome: 'success' | 'failure' | 'unknown'
}

export type FlowTraceSort = 'latest' | 'slowest' | 'failed'
export const FLOW_TRACE_SORTS: readonly FlowTraceSort[] = ['latest', 'slowest', 'failed']

/** One document of a trace as a provider reports it, with only what matching needs. */
export interface FlowTraceDoc {
  event: 'transaction' | 'span'
  service: string
  /** `transaction.name` or `span.name`. */
  name: string
  /** `span.destination.service.resource`, for spans. */
  destination?: string
  at: number
  durationMs: number
  outcome?: string
}

/** What one part of the map did in one execution: when it started (from the trace's start) and how long it took. */
export interface FlowTraceHop {
  key: string
  of: 'edges' | 'nodes' | 'stages'
  startMs: number
  /** Summed when the part ran more than once in the trace (a retried call, a loop). */
  durationMs: number
  count: number
  failed: boolean
}

/** A transaction or an outgoing call the trace holds that no part of the map measures. */
export interface FlowTraceUnmapped {
  event: 'transaction' | 'span'
  service: string
  name: string
  destination?: string
  startMs: number
  durationMs: number
  count: number
}

/** One execution of the flow laid over the map. */
export interface FlowTrace {
  traceId: string
  at: number
  durationMs: number
  outcome: 'success' | 'failure' | 'unknown'
  hops: Record<string, FlowTraceHop>
  /** Measured parts of the map this execution never touched. */
  missing: string[]
  /** What the execution did beyond the map, largest first: the candidates for new parts. */
  unmapped: FlowTraceUnmapped[]
}

/** The measure that starts the flow: the file's `entry`, else the first transaction-measured node left to right. */
export function flowEntry(map: FlowMap): Extract<FlowMeasure, { type: 'apm.transaction' }> | null {
  if (map.entry?.type === 'apm.transaction') return map.entry
  const columns = flowColumns(map)
  const candidates = map.nodes.filter((n) => n.measure?.type === 'apm.transaction').sort((a, b) => (columns[a.id] ?? 0) - (columns[b.id] ?? 0))
  const first = candidates[0]?.measure
  return first?.type === 'apm.transaction' ? first : null
}

const outcomeOf = (value: string | undefined): FlowTrace['outcome'] => (value === 'failure' ? 'failure' : value === 'success' ? 'success' : 'unknown')

/**
 * Lays the documents of one trace over the map: each measured part takes the documents its
 * measure describes (same service and transaction name, or same service and destination), summed
 * when there are several; everything else is listed as unmapped, grouped by what it is.
 */
export function matchFlowTrace(map: FlowMap, traceId: string, docs: readonly FlowTraceDoc[]): FlowTrace {
  const sorted = [...docs].sort((a, b) => a.at - b.at)
  const entry = flowEntry(map)
  const root = sorted.find((d) => d.event === 'transaction' && entry && d.service === entry.service && d.name === entry.transaction) ?? sorted.find((d) => d.event === 'transaction') ?? sorted[0]
  const start = root?.at ?? 0
  const end = Math.max(start, ...sorted.map((d) => d.at + d.durationMs))
  const hops: Record<string, FlowTraceHop> = {}
  const taken = new Set<FlowTraceDoc>()
  for (const m of flowMeasures(map)) {
    const mine = sorted.filter((d) =>
      m.measure.type === 'apm.transaction'
        ? d.event === 'transaction' && d.service === m.measure.service && d.name === m.measure.transaction
        : d.event === 'span' && d.service === m.measure.service && d.destination === m.measure.destination
    )
    if (mine.length === 0) continue
    for (const d of mine) taken.add(d)
    hops[m.key] = {
      key: m.key,
      of: m.of,
      startMs: mine[0]!.at - start,
      durationMs: mine.reduce((s, d) => s + d.durationMs, 0),
      count: mine.length,
      failed: mine.some((d) => d.outcome === 'failure')
    }
  }
  const groups = new Map<string, FlowTraceUnmapped>()
  for (const d of sorted) {
    if (taken.has(d)) continue
    const key = `${d.event}|${d.service}|${d.event === 'span' ? d.destination ?? d.name : d.name}`
    const g = groups.get(key)
    if (g) {
      g.durationMs += d.durationMs
      g.count += 1
    } else groups.set(key, { event: d.event, service: d.service, name: d.name, ...(d.destination ? { destination: d.destination } : {}), startMs: d.at - start, durationMs: d.durationMs, count: 1 })
  }
  const unmapped = [...groups.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 40)
  const missing = flowMeasures(map).map((m) => m.key).filter((k) => !hops[k])
  return { traceId, at: start, durationMs: root ? Math.max(root.durationMs, end - start) : end - start, outcome: outcomeOf(root?.outcome), hops, missing, unmapped }
}

// Reading the numbers --------------------------------------------------------------------------

export type FlowPartRef = { of: 'edges' | 'nodes' | 'stages'; key: string }

/** The label of a part as the tables show it: a node's or stage's label, `A → B · label` for an edge. */
export function flowPartLabel(map: FlowMap, part: FlowPartRef): string {
  if (part.of === 'nodes') return map.nodes.find((n) => n.id === part.key)?.label ?? part.key
  if (part.of === 'stages') return map.stages.find((s) => s.id === part.key)?.label ?? part.key
  const names = new Map(map.nodes.map((n) => [n.id, n.label]))
  const i = map.edges.findIndex((_, idx) => edgeId(map, idx) === part.key)
  const e = map.edges[i]
  if (!e) return part.key
  return `${names.get(e.from) ?? e.from} → ${names.get(e.to) ?? e.to}${e.label ? ` · ${e.label}` : ''}`
}

/** Every part of the map, measured or not, in drawing order: edges, nodes, stages. */
export function flowParts(map: FlowMap): (FlowPartRef & { label: string; measured: boolean })[] {
  const out: (FlowPartRef & { label: string; measured: boolean })[] = []
  map.edges.forEach((e, i) => out.push({ of: 'edges', key: edgeId(map, i), label: flowPartLabel(map, { of: 'edges', key: edgeId(map, i) }), measured: Boolean(e.measure) }))
  for (const n of map.nodes) out.push({ of: 'nodes', key: n.id, label: n.label, measured: Boolean(n.measure) })
  for (const s of map.stages) out.push({ of: 'stages', key: s.id, label: s.label, measured: Boolean(s.measure) })
  return out
}

/** A measured part with its numbers and its share of the flow's time (its p95 over the sum of every measured p95). */
export interface FlowPartRank extends FlowPartRef {
  label: string
  timing: FlowTiming
  share: number
}

/** Measured parts with data, slowest first by p95, each with its share: the first rows are where the flow spends its time. */
export function rankFlowParts(map: FlowMap, reading: FlowMapReading): FlowPartRank[] {
  const rows: FlowPartRank[] = []
  for (const m of flowMeasures(map)) {
    const timing = reading[m.of][m.key]
    if (timing && timing.count > 0) rows.push({ of: m.of, key: m.key, label: flowPartLabel(map, m), timing, share: 0 })
  }
  const total = rows.reduce((s, r) => s + r.timing.p95Ms, 0)
  for (const r of rows) r.share = total > 0 ? r.timing.p95Ms / total : 0
  return rows.sort((a, b) => b.timing.p95Ms - a.timing.p95Ms)
}

/** One log line or APM error of an execution, by `trace.id`. */
export interface FlowTraceLog {
  at: number
  service: string
  /** `error`, `warn`, `info`… when the source says. */
  level?: string
  message: string
  /** The exception type (APM errors). */
  type?: string
  /** Where it happened (APM's `error.culprit`). */
  culprit?: string
  source: 'apm.error' | 'logs'
}

/** A measured part against its baseline: how many times slower than usual (`ratio`), and the change in failure share. */
export interface FlowPartDeviation extends FlowPartRef {
  label: string
  timing: FlowTiming
  baseline: FlowBaseline
  /** p95 of the window over the baseline's p95; 2 means twice as slow as usual. */
  ratio: number
  /** errorRate of the window minus the baseline's; 0 when either is unknown. */
  errorDelta: number
}

/**
 * Parts that deviate most from their usual numbers, worst first: by `ratio` when it exceeds 1, and by
 * the failure share's change. Parts without data in the window or in the baseline are left out.
 */
export function rankFlowDeviations(map: FlowMap, reading: FlowMapReading, against: 'weekly' | 'previous' = 'weekly'): FlowPartDeviation[] {
  const rows: FlowPartDeviation[] = []
  for (const m of flowMeasures(map)) {
    const timing = reading[m.of][m.key]
    const baseline = timing?.[against]
    if (!timing || timing.count === 0 || !baseline || baseline.count === 0 || baseline.p95Ms <= 0) continue
    const ratio = timing.p95Ms / baseline.p95Ms
    const errorDelta = timing.errorRate !== undefined && baseline.errorRate !== undefined ? timing.errorRate - baseline.errorRate : 0
    rows.push({ of: m.of, key: m.key, label: flowPartLabel(map, m), timing, baseline, ratio, errorDelta })
  }
  const score = (d: FlowPartDeviation) => Math.max(d.ratio - 1, 0) + Math.max(d.errorDelta, 0) * 10
  return rows.sort((a, b) => score(b) - score(a))
}

/** How much of the map the data covers: measured parts, parts without a measure, measures with no data in the window, and failed reads. */
export interface FlowCoverage {
  total: number
  measured: number
  /** Drawn, never measured: the map file gives them no `measure`. */
  unmeasured: (FlowPartRef & { label: string })[]
  /** Measured, but APM returned nothing in the window: a wrong name, or a part no longer called. */
  noData: (FlowPartRef & { label: string })[]
  failed: (FlowPartRef & { label: string; error: string })[]
}

export function flowCoverage(map: FlowMap, reading?: FlowMapReading): FlowCoverage {
  const parts = flowParts(map)
  const out: FlowCoverage = { total: parts.length, measured: parts.filter((p) => p.measured).length, unmeasured: [], noData: [], failed: [] }
  for (const p of parts) {
    const ref = { of: p.of, key: p.key, label: p.label }
    if (!p.measured) out.unmeasured.push(ref)
    else if (reading?.errors[p.key]) out.failed.push({ ...ref, error: reading.errors[p.key]! })
    else if (reading && (reading[p.of][p.key]?.count ?? 0) === 0) out.noData.push(ref)
  }
  return out
}
