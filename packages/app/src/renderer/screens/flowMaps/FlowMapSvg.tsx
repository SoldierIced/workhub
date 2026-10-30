import { useEffect, useMemo, useRef, type Ref } from 'react'
import { edgeId, formatMs, layoutFlowMap, placeFlowLabels, routeFlowEdge, type FlowCoverage, type FlowLabelSpot, type FlowMap, type FlowMapReading, type FlowNodeKind, type FlowPartRank, type FlowPartRef, type FlowTrace } from '@workhub/core'

/** Stroke per node kind; fixed colours so the map reads the same in both themes. */
export const KIND_COLOR: Record<FlowNodeKind, string> = { app: '#22d3ee', orchestrator: '#2dd4bf', service: '#f59e0b', worker: '#a78bfa', datastore: '#60a5fa', queue: '#f472b6', external: '#94a3b8' }
export const WAIT = '#fb7185'
const HEAT = '#f97316'
const PICK = '#2dd4bf'

export interface FlowMapSvgProps {
  map: FlowMap
  reading?: FlowMapReading
  /** One execution laid over the map: labels show what each part took in it, parts it never touched fade. */
  trace?: FlowTrace | null
  flow: boolean
  picked: FlowPartRef | null
  onPick: (p: FlowPartRef | null) => void
  /** Measured parts slowest first (see `rankFlowParts`): the top three carry a rank, every one a thickness by share. */
  ranks?: readonly FlowPartRank[]
  coverage?: FlowCoverage
  /** Drawn size over the natural one (the viewBox never changes, so the picture scales as a whole). */
  scale?: number
  svgRef?: Ref<SVGSVGElement>
}

const sameRef = (a: FlowPartRef | null, b: FlowPartRef): boolean => a !== null && a.of === b.of && a.key === b.key

/**
 * The Archify-style diagram: lanes, nodes, orthogonal edges with their p50 as label, stage chips, and
 * comets along the edges in Flow mode. A picked part lights up and the rest dims; the slowest parts
 * get a warmer, thicker outline; parts without a measure are faded, measured parts without data hatched.
 */
export function FlowMapSvg({ map, reading, trace, flow, picked, onPick, ranks, coverage, scale = 1, svgRef }: FlowMapSvgProps) {
  const layout = useMemo(() => layoutFlowMap(map), [map])
  const names = useMemo(() => new Map(map.nodes.map((n) => [n.id, n.label])), [map])
  const kinds = useMemo(() => new Map(map.nodes.map((n) => [n.id, n.kind])), [map])
  const heat = useMemo(() => new Map((ranks ?? []).map((r, i) => [`${r.of}:${r.key}`, { rank: i + 1, share: r.share }])), [ranks])
  const noData = useMemo(() => new Set((coverage?.noData ?? []).map((p) => `${p.of}:${p.key}`)), [coverage])
  const unmeasured = useMemo(() => new Set((coverage?.unmeasured ?? []).map((p) => `${p.of}:${p.key}`)), [coverage])
  const edges = useMemo(() => {
    const pairs = new Map<string, number>()
    return map.edges.map((e, i) => {
      const pair = `${e.from}|${e.to}`
      const n = pairs.get(pair) ?? 0
      pairs.set(pair, n + 1)
      const key = edgeId(map, i)
      const timing = reading?.edges[key]
      const hop = trace?.hops[key]
      const label = trace ? (hop ? formatMs(hop.durationMs) : e.label) : (e.label ?? (timing ? formatMs(timing.p50Ms) : undefined))
      return { e, key, d: routeFlowEdge(layout.nodes[e.from]!, layout.nodes[e.to]!, n, e.entry), timing, hop, label }
    })
  }, [map, layout, reading, trace])
  // Label pills sit where they cover no node: the stage chips and every node box are obstacles.
  const labelSpots = useMemo(() => {
    const obstacles = [...Object.values(layout.nodes), ...Object.values(layout.stages?.chips ?? {})]
    return placeFlowLabels(edges.map((x) => ({ d: x.d, width: labelWidth(x.label ?? '') })), obstacles)
  }, [edges, layout])
  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const cometRefs = useRef<(SVGCircleElement | null)[]>([])
  // Flow mode: one comet per edge, in edge order, each hop lasting a share of a 6 s loop; no timers are kept when Still.
  useEffect(() => {
    if (!flow) {
      cometRefs.current.forEach((c) => c?.setAttribute('opacity', '0'))
      return
    }
    let raf = 0
    const start = performance.now()
    const loop = 6000, hop = loop / Math.max(1, edges.length + 1)
    const frame = (now: number) => {
      const t = (now - start) % loop
      edges.forEach((_, i) => {
        const p = pathRefs.current[i], c = cometRefs.current[i]
        if (!p || !c) return
        const local = (t - i * hop) / hop
        if (local < 0 || local > 1) return c.setAttribute('opacity', '0')
        const pt = p.getPointAtLength(p.getTotalLength() * local)
        c.setAttribute('cx', String(pt.x))
        c.setAttribute('cy', String(pt.y))
        c.setAttribute('opacity', String(1 - Math.abs(local - 0.5) * 0.8))
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [flow, edges])

  // Dimming: with a pick, everything but the picked part and (for a node) the edges touching it fades.
  const pickedNode = picked?.of === 'nodes' ? picked.key : null
  const dim = (ref: FlowPartRef, touches?: boolean): number => {
    if (!picked) return 1
    if (sameRef(picked, ref) || touches) return 1
    return 0.3
  }
  // A trace: measured parts it never touched fade, so the path it took stands out.
  const traced = (ref: FlowPartRef): number => (trace && trace.missing.includes(ref.key) ? 0.25 : 1)
  const heatOf = (ref: FlowPartRef) => heat.get(`${ref.of}:${ref.key}`)
  const widthOf = (ref: FlowPartRef, base: number) => base + (heatOf(ref)?.share ?? 0) * 5
  const fillOf = (ref: FlowPartRef) => (noData.has(`${ref.of}:${ref.key}`) ? 'url(#fm-hatch)' : 'currentColor')
  const outlineOpacity = (ref: FlowPartRef) => (unmeasured.has(`${ref.of}:${ref.key}`) ? 0.4 : 1)
  const dash = (ref: FlowPartRef, fallback?: string) => (unmeasured.has(`${ref.of}:${ref.key}`) ? '2 3' : fallback)

  const rankBadge = (ref: FlowPartRef, x: number, y: number) => {
    const h = heatOf(ref)
    if (!h || h.rank > 3) return null
    return (
      <g pointerEvents="none">
        <circle cx={x} cy={y} r={8} fill={HEAT} />
        <text x={x} y={y + 3.5} fontSize={10} fontWeight={700} textAnchor="middle" fill="#fff">{h.rank}</text>
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
      data-testid="flow-map-svg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onPick(null)
      }}
    >
      <defs>
        {(['arrow', 'emph', 'wait'] as const).map((k) => (
          <marker key={k} id={`fm-${k}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={k === 'wait' ? WAIT : k === 'emph' ? PICK : '#64748b'} />
          </marker>
        ))}
        <pattern id="fm-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="currentColor" className="text-surface" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#64748b" strokeWidth="1.2" strokeOpacity="0.5" />
        </pattern>
        <filter id="fm-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {layout.phases.map((p) => (
        <g key={p.label}>
          <line x1={p.x1} y1={48} x2={p.x2} y2={48} stroke="currentColor" className="text-border" />
          <rect x={(p.x1 + p.x2) / 2 - p.label.length * 3.2 - 8} y={40} width={p.label.length * 6.4 + 16} height={16} rx={8} fill="currentColor" className="text-surface" stroke="#64748b" strokeWidth={0.6} />
          <text x={(p.x1 + p.x2) / 2} y={51.5} fontSize={10} textAnchor="middle" fill="currentColor" className="text-muted">{p.label}</text>
        </g>
      ))}
      {layout.lanes.map((l) => (
        <g key={l.id} onClick={() => onPick(null)}>
          <rect x={40} y={l.y} width={layout.width - 80} height={l.h} rx={10} fill="currentColor" className="text-surface" fillOpacity={0.5} stroke="#334155" strokeDasharray={l.kind === 'exception' ? '6 5' : undefined} />
          <text x={52} y={l.y + 15} fontSize={11} fill="currentColor" className="text-muted">{l.label}</text>
        </g>
      ))}
      {layout.stages && (
        <g>
          <rect x={layout.stages.box.x} y={layout.stages.box.y} width={layout.stages.box.w} height={layout.stages.box.h} rx={10} fill="none" stroke="#475569" />
          {map.stages.map((s) => {
            const c = layout.stages!.chips[s.id]!
            const ref: FlowPartRef = { of: 'stages', key: s.id }
            const timing = reading?.stages[s.id]
            const hop = trace?.hops[s.id]
            const active = sameRef(picked, ref)
            const second = trace ? (hop ? formatMs(hop.durationMs) : undefined) : timing ? formatMs(timing.p50Ms) : undefined
            return (
              <g key={s.id} className="cursor-pointer" opacity={dim(ref) * traced(ref)} onClick={() => onPick(ref)} data-part={`stages:${s.id}`}>
                <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={7} fill={fillOf(ref)} className="text-surface" stroke={active ? PICK : '#475569'} strokeWidth={active ? 2 : widthOf(ref, 1)} strokeOpacity={outlineOpacity(ref)} strokeDasharray={dash(ref)} filter={active ? 'url(#fm-glow)' : undefined} />
                <text x={c.x + c.w / 2} y={c.y + (second ? 13 : 19)} fontSize={9.5} textAnchor="middle" fill="currentColor" className="text-text">{s.label}</text>
                {second && <text x={c.x + c.w / 2} y={c.y + 25} fontSize={9} textAnchor="middle" fill="currentColor" className="text-muted">{second}</text>}
                {rankBadge(ref, c.x + c.w - 2, c.y + 2)}
              </g>
            )
          })}
        </g>
      )}
      {edges.map((x, i) => {
        const ref: FlowPartRef = { of: 'edges', key: x.key }
        const wait = x.e.kind === 'wait'
        const active = sameRef(picked, ref)
        const touches = pickedNode !== null && (x.e.from === pickedNode || x.e.to === pickedNode)
        const color = active ? PICK : wait ? WAIT : x.e.emphasis ? PICK : x.hop?.failed ? WAIT : '#64748b'
        return (
          <g key={x.key} className="cursor-pointer" opacity={dim(ref, touches) * traced(ref)} onClick={() => onPick(ref)} data-part={`edges:${x.key}`}>
            <path
              ref={(el) => void (pathRefs.current[i] = el)}
              d={x.d}
              fill="none"
              stroke={color}
              strokeWidth={active ? 2.6 : widthOf(ref, x.e.emphasis ? 2 : 1.4)}
              strokeOpacity={outlineOpacity(ref)}
              strokeDasharray={wait ? '3 4' : x.e.kind === 'async' ? '5 4' : dash(ref)}
              markerEnd={`url(#fm-${wait ? 'wait' : active || x.e.emphasis ? 'emph' : 'arrow'})`}
              filter={active ? 'url(#fm-glow)' : undefined}
            />
            <path d={x.d} fill="none" stroke="transparent" strokeWidth={10} />
            <circle ref={(el) => void (cometRefs.current[i] = el)} r={3.2} fill={wait ? WAIT : '#67e8f9'} opacity={0} style={{ filter: `drop-shadow(0 0 4px ${wait ? WAIT : '#22d3ee'})` }} />
          </g>
        )
      })}
      {map.nodes.map((n) => {
        const b = layout.nodes[n.id]!
        const ref: FlowPartRef = { of: 'nodes', key: n.id }
        const timing = reading?.nodes[n.id]
        const hop = trace?.hops[n.id]
        const color = KIND_COLOR[kinds.get(n.id) ?? 'service']
        const active = sameRef(picked, ref)
        const second = trace
          ? hop
            ? `${formatMs(hop.durationMs)} · +${formatMs(hop.startMs)}${hop.failed ? ' · ✕' : ''}`
            : n.subtitle ?? ''
          : timing
            ? `p50 ${formatMs(timing.p50Ms)} · p95 ${formatMs(timing.p95Ms)}`
            : n.subtitle ?? ''
        return (
          <g key={n.id} className="cursor-pointer" opacity={dim(ref) * traced(ref)} onClick={() => onPick(ref)} data-part={`nodes:${n.id}`}>
            <title>{[n.label, n.subtitle, n.note, timing ? `p50 ${formatMs(timing.p50Ms)} · p95 ${formatMs(timing.p95Ms)} · ${timing.count}` : undefined].filter(Boolean).join('\n')}</title>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={9}
              fill={fillOf(ref)}
              className="text-surface"
              stroke={active ? PICK : hop?.failed ? WAIT : color}
              strokeWidth={active ? 2.4 : widthOf(ref, 1.3)}
              strokeOpacity={outlineOpacity(ref)}
              strokeDasharray={dash(ref)}
              filter={active ? 'url(#fm-glow)' : undefined}
            />
            <circle cx={b.x + 12} cy={b.y + 13} r={3} fill={color} />
            <text x={b.x + 22} y={b.y + 17} fontSize={11.5} fontWeight={600} fill="currentColor" className="text-text">{n.label}</text>
            <text x={b.x + 12} y={b.y + 34} fontSize={9} fill="currentColor" className="text-muted">{second}</text>
            {rankBadge(ref, b.x + b.w - 2, b.y + 2)}
          </g>
        )
      })}
      {/* Edge labels last, so a short hop between neighbouring nodes keeps its pill readable over their borders. */}
      {edges.map((x, i) => {
        if (!x.label) return null
        const ref: FlowPartRef = { of: 'edges', key: x.key }
        const wait = x.e.kind === 'wait'
        const active = sameRef(picked, ref)
        const touches = pickedNode !== null && (x.e.from === pickedNode || x.e.to === pickedNode)
        const spot = labelSpots[i]!
        return (
          <g key={`label:${x.key}`} className="cursor-pointer" opacity={dim(ref, touches) * traced(ref)} onClick={() => onPick(ref)}>
            <EdgeLabel spot={spot} text={x.label} color={wait ? WAIT : active ? PICK : x.hop?.failed ? WAIT : undefined} />
            {rankBadge(ref, spot.x, spot.y + 15)}
          </g>
        )
      })}
    </svg>
  )
}

/** The width of a label pill for its text (monospace-ish estimate, see `placeFlowLabels`). */
export const labelWidth = (text: string): number => text.length * 6.2 + 16

/** A pill on the edge (see `placeFlowLabels`); a pill that had to leave the path gets a thin leader back to it. */
function EdgeLabel({ spot, text, color }: { spot: FlowLabelSpot; text: string; color?: string }) {
  const w = labelWidth(text)
  return (
    <g>
      {spot.anchor && Math.abs(spot.anchor.y - spot.y) < 1 && <line x1={spot.x + (spot.anchor.x > spot.x ? w / 2 : -w / 2)} y1={spot.y} x2={spot.anchor.x} y2={spot.anchor.y} stroke={color ?? '#475569'} strokeWidth={0.8} strokeDasharray="2 2" />}
      {spot.anchor && Math.abs(spot.anchor.y - spot.y) >= 1 && <line x1={spot.x} y1={spot.y + (spot.anchor.y > spot.y ? 8 : -8)} x2={spot.anchor.x} y2={spot.anchor.y} stroke={color ?? '#475569'} strokeWidth={0.8} strokeDasharray="2 2" />}
      <rect x={spot.x - w / 2} y={spot.y - 8} width={w} height={16} rx={6} fill="currentColor" className="text-surface" stroke={color ?? '#475569'} strokeWidth={0.8} />
      <text x={spot.x} y={spot.y + 3.5} fontSize={9.5} textAnchor="middle" fill={color ?? 'currentColor'} className="text-muted">{text}</text>
    </g>
  )
}

/**
 * The diagram as a PNG data URL, for the clipboard: the SVG is cloned with every colour that came
 * from a class (`currentColor`, `text-*`) written as an attribute, drawn on a canvas at 2x over the
 * page background. Needs a document: never called from tests.
 */
export async function flowMapToPng(svg: SVGSVGElement, scale = 2): Promise<string> {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const originals = svg.querySelectorAll<SVGElement>('*')
  const copies = clone.querySelectorAll<SVGElement>('*')
  originals.forEach((el, i) => {
    const copy = copies[i]
    if (!copy) return
    const cs = getComputedStyle(el)
    for (const prop of ['fill', 'stroke'] as const) {
      const attr = copy.getAttribute(prop)
      if (attr === 'currentColor' || (attr === null && el.tagName === 'text')) copy.setAttribute(prop, cs.color)
    }
    if (el.tagName === 'text') {
      copy.setAttribute('font-family', cs.fontFamily)
      if (cs.fontWeight !== 'normal' && !copy.getAttribute('font-weight')) copy.setAttribute('font-weight', cs.fontWeight)
    }
    copy.removeAttribute('class')
  })
  clone.removeAttribute('class')
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const page = getComputedStyle(document.body)
  const width = svg.viewBox.baseVal.width
  const height = svg.viewBox.baseVal.height
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('width', String(width))
  bg.setAttribute('height', String(height))
  bg.setAttribute('fill', page.backgroundColor && page.backgroundColor !== 'rgba(0, 0, 0, 0)' ? page.backgroundColor : '#0f172a')
  clone.insertBefore(bg, clone.firstChild)
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('the diagram could not be rasterised'))
      i.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
