import { useEffect, useMemo, useRef, type Ref } from 'react'
import { edgeId, flowColumns, formatMs, type FlowCoverage, type FlowMap, type FlowMapReading, type FlowPartRank, type FlowPartRef, type FlowTrace } from '@workhub/core'
import { KIND_COLOR, WAIT } from './FlowMapSvg'

const PICK = '#2dd4bf'
const HEAT = '#f97316'
const G = { left: 30, top: 24, colW: 160, headW: 140, headH: 40, firstRow: 100, rowH: 36, bottom: 30 }

export interface SequenceLayout {
  width: number
  height: number
  /** Node ids left to right, with the x of their lifeline. */
  participants: { id: string; x: number }[]
  /** Edges in the order they are drawn, top to bottom: the file's order, or the execution's when a trace is shown. */
  messages: { index: number; key: string; y: number }[]
}

/**
 * The sequence view's geometry: one lifeline per node, ordered as the map flows (column, then the
 * order of the file), and one row per edge. With a trace, rows follow when each hop started.
 */
export function sequenceLayout(map: FlowMap, trace?: FlowTrace | null): SequenceLayout {
  const columns = flowColumns(map)
  const order = map.nodes.map((n, i) => ({ id: n.id, col: columns[n.id] ?? 0, i })).sort((a, b) => a.col - b.col || a.i - b.i)
  const participants = order.map((n, i) => ({ id: n.id, x: G.left + G.headW / 2 + i * G.colW }))
  const keyed = map.edges.map((_, index) => ({ index, key: edgeId(map, index) }))
  const sorted = trace ? [...keyed].sort((a, b) => (trace.hops[a.key]?.startMs ?? Infinity) - (trace.hops[b.key]?.startMs ?? Infinity) || a.index - b.index) : keyed
  const messages = sorted.map((m, row) => ({ ...m, y: G.firstRow + row * G.rowH }))
  return { width: G.left * 2 + Math.max(1, participants.length) * G.colW - (G.colW - G.headW), height: G.firstRow + Math.max(1, messages.length) * G.rowH + G.bottom, participants, messages }
}

export interface FlowSequenceSvgProps {
  map: FlowMap
  reading?: FlowMapReading
  trace?: FlowTrace | null
  /** Flow mode: a comet runs along each arrow in order, top to bottom. */
  flow?: boolean
  picked: FlowPartRef | null
  onPick: (p: FlowPartRef | null) => void
  ranks?: readonly FlowPartRank[]
  coverage?: FlowCoverage
  scale?: number
  svgRef?: Ref<SVGSVGElement>
}

const sameRef = (a: FlowPartRef | null, b: FlowPartRef): boolean => a !== null && a.of === b.of && a.key === b.key

/**
 * The same flow as a sequence diagram: the services as lifelines, every hop as an arrow in order,
 * labelled with the hop's name and its p50 (or what it took in the chosen execution). Picks, dimming,
 * ranks and the trace's fading behave as in the map view.
 */
export function FlowSequenceSvg({ map, reading, trace, flow = false, picked, onPick, ranks, coverage, scale = 1, svgRef }: FlowSequenceSvgProps) {
  const layout = useMemo(() => sequenceLayout(map, trace), [map, trace])
  const nodes = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map])
  const xOf = useMemo(() => new Map(layout.participants.map((p) => [p.id, p.x])), [layout])
  const heat = useMemo(() => new Map((ranks ?? []).map((r, i) => [`${r.of}:${r.key}`, i + 1])), [ranks])
  const unmeasured = useMemo(() => new Set((coverage?.unmeasured ?? []).map((p) => `${p.of}:${p.key}`)), [coverage])
  const cometRefs = useRef<(SVGCircleElement | null)[]>([])
  const rowRefs = useRef<(SVGLineElement | null)[]>([])
  // Flow mode: the comets run the arrows one after another over a 6 s loop; the arrow being run brightens.
  useEffect(() => {
    if (!flow) {
      cometRefs.current.forEach((c) => c?.setAttribute('opacity', '0'))
      rowRefs.current.forEach((l) => l?.removeAttribute('stroke-opacity'))
      return
    }
    let raf = 0
    const start = performance.now()
    const loop = 6000, hop = loop / Math.max(1, layout.messages.length + 1)
    const frame = (now: number) => {
      const t = (now - start) % loop
      layout.messages.forEach((m, i) => {
        const c = cometRefs.current[i], l = rowRefs.current[i]
        if (!c || !l) return
        const local = (t - i * hop) / hop
        if (local < 0 || local > 1) {
          c.setAttribute('opacity', '0')
          l.removeAttribute('stroke-opacity')
          return
        }
        const x1 = Number(l.getAttribute('x1')), x2 = Number(l.getAttribute('x2'))
        c.setAttribute('cx', String(x1 + (x2 - x1) * local))
        c.setAttribute('cy', String(m.y))
        c.setAttribute('opacity', String(1 - Math.abs(local - 0.5) * 0.8))
        l.setAttribute('stroke-opacity', '1')
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [flow, layout])
  const pickedNode = picked?.of === 'nodes' ? picked.key : null
  const dim = (ref: FlowPartRef, touches?: boolean): number => (!picked || sameRef(picked, ref) || touches ? 1 : 0.3)
  const traced = (ref: FlowPartRef): number => (trace && trace.missing.includes(ref.key) ? 0.25 : 1)
  const lifelineTop = G.top + G.headH
  const lifelineBottom = layout.height - G.bottom + 10
  const rank = (ref: FlowPartRef, x: number, y: number) => {
    const r = heat.get(`${ref.of}:${ref.key}`)
    if (!r || r > 3) return null
    return (
      <g pointerEvents="none">
        <circle cx={x} cy={y} r={8} fill={HEAT} />
        <text x={x} y={y + 3.5} fontSize={10} fontWeight={700} textAnchor="middle" fill="#fff">{r}</text>
      </g>
    )
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width * scale}
      height={layout.height * scale}
      className="block select-none text-text"
      role="img"
      aria-label={map.name}
      data-testid="flow-sequence-svg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onPick(null)
      }}
    >
      <defs>
        {(['arrow', 'emph', 'wait'] as const).map((k) => (
          <marker key={k} id={`fs-${k}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={k === 'wait' ? WAIT : k === 'emph' ? PICK : '#64748b'} />
          </marker>
        ))}
        <filter id="fs-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {layout.participants.map((p) => {
        const n = nodes.get(p.id)!
        const ref: FlowPartRef = { of: 'nodes', key: p.id }
        const timing = reading?.nodes[p.id]
        const hop = trace?.hops[p.id]
        const color = KIND_COLOR[n.kind]
        const active = sameRef(picked, ref)
        const second = trace ? (hop ? `${formatMs(hop.durationMs)} · +${formatMs(hop.startMs)}` : '') : timing ? `p50 ${formatMs(timing.p50Ms)} · p95 ${formatMs(timing.p95Ms)}` : n.subtitle ?? ''
        return (
          <g key={p.id} className="cursor-pointer" opacity={dim(ref) * traced(ref)} onClick={() => onPick(ref)} data-part={`nodes:${p.id}`}>
            <title>{[n.label, n.subtitle, n.note].filter(Boolean).join('\n')}</title>
            <line x1={p.x} y1={lifelineTop} x2={p.x} y2={lifelineBottom} stroke={active ? PICK : '#475569'} strokeDasharray="4 4" strokeWidth={active ? 1.5 : 1} />
            <rect x={p.x - G.headW / 2} y={G.top} width={G.headW} height={G.headH} rx={9} fill="currentColor" className="text-surface" stroke={active ? PICK : hop?.failed ? WAIT : color} strokeWidth={active ? 2.4 : 1.3} strokeOpacity={unmeasured.has(`nodes:${p.id}`) ? 0.4 : 1} strokeDasharray={unmeasured.has(`nodes:${p.id}`) ? '2 3' : undefined} filter={active ? 'url(#fs-glow)' : undefined} />
            <circle cx={p.x - G.headW / 2 + 12} cy={G.top + 13} r={3} fill={color} />
            <text x={p.x - G.headW / 2 + 22} y={G.top + 17} fontSize={11.5} fontWeight={600} fill="currentColor" className="text-text">{n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}</text>
            <text x={p.x - G.headW / 2 + 12} y={G.top + 31} fontSize={8.5} fill="currentColor" className="text-muted">{second}</text>
            {rank(ref, p.x + G.headW / 2 - 2, G.top + 2)}
          </g>
        )
      })}
      {layout.messages.map((m, i) => {
        const e = map.edges[m.index]!
        const ref: FlowPartRef = { of: 'edges', key: m.key }
        const x1 = xOf.get(e.from)!, x2 = xOf.get(e.to)!
        const wait = e.kind === 'wait'
        const active = sameRef(picked, ref)
        const touches = pickedNode !== null && (e.from === pickedNode || e.to === pickedNode)
        const timing = reading?.edges[m.key]
        const hop = trace?.hops[m.key]
        const number = trace ? (hop ? formatMs(hop.durationMs) : undefined) : timing ? formatMs(timing.p50Ms) : undefined
        const text = [e.label, number].filter(Boolean).join(' · ')
        const color = active ? PICK : wait || hop?.failed ? WAIT : e.emphasis ? PICK : '#64748b'
        const dir = x2 >= x1 ? 1 : -1
        const left = Math.min(x1, x2), right = Math.max(x1, x2)
        return (
          <g key={m.key} className="cursor-pointer" opacity={dim(ref, touches) * traced(ref)} onClick={() => onPick(ref)} data-part={`edges:${m.key}`}>
            <line ref={(el) => void (rowRefs.current[i] = el)} x1={x1} y1={m.y} x2={x2 - dir * 6} y2={m.y} stroke={color} strokeWidth={active ? 2.4 : e.emphasis ? 2 : 1.4} strokeDasharray={wait ? '3 4' : e.kind === 'async' ? '5 4' : unmeasured.has(`edges:${m.key}`) ? '2 3' : undefined} markerEnd={`url(#fs-${wait ? 'wait' : active || e.emphasis ? 'emph' : 'arrow'})`} filter={active ? 'url(#fs-glow)' : undefined} />
            <line x1={left} y1={m.y} x2={right} y2={m.y} stroke="transparent" strokeWidth={14} />
            <circle cx={x1} cy={m.y} r={3} fill={color} />
            <circle ref={(el) => void (cometRefs.current[i] = el)} r={3.6} fill={wait ? WAIT : '#67e8f9'} opacity={0} style={{ filter: `drop-shadow(0 0 4px ${wait ? WAIT : '#22d3ee'})` }} />
            {text && (
              <text x={(x1 + x2) / 2} y={m.y - 6} fontSize={10.5} textAnchor="middle" fill={wait || hop?.failed ? WAIT : 'currentColor'} className="text-muted">
                {text}
              </text>
            )}
            {trace && hop && <text x={left} y={m.y + 12} fontSize={8} textAnchor="start" fill="currentColor" className="text-subtle">{`+${formatMs(hop.startMs)}`}</text>}
            {rank(ref, right - 14, m.y + 12)}
          </g>
        )
      })}
    </svg>
  )
}
