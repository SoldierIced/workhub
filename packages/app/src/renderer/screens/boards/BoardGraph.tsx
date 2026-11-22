import { Check, TriangleAlert } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { BoardGraphBlock, BoardNode, BoardNodeState } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { charsIn, clip, GRAPH, graphMinWidth, layoutGraph, placeLabels, type GraphOverrides } from '../../lib/boardGraph'
import { cn } from '../../lib/cn'
import { formatWorking, given, workingMs } from '../../lib/boards'
import { formatTokens } from '../../lib/home'

/** Box outline and the bar at its left, by state: the same soft fills the Flow map nodes use. */
const NODE_RECT: Record<BoardNodeState, string> = {
  idle: 'fill-surface stroke-border-strong',
  active: 'fill-surface stroke-info',
  blocked: 'fill-danger-soft stroke-danger',
  done: 'fill-surface stroke-success',
  placeholder: 'fill-transparent stroke-border-strong [stroke-dasharray:5_4]'
}
const NODE_BAR: Record<BoardNodeState, string> = { idle: 'fill-border-strong', active: 'fill-info', blocked: 'fill-danger', done: 'fill-success', placeholder: 'fill-transparent' }
const NODE_STATE: Record<BoardNodeState, MessageKey> = {
  idle: 'boards.node.idle',
  active: 'boards.node.active',
  blocked: 'boards.node.blocked',
  done: 'boards.node.done',
  placeholder: 'boards.node.placeholder'
}
const EDGE_STROKE = { idle: 'stroke-subtle', flowing: 'stroke-accent', returning: 'stroke-danger' } as const
const ARROW_FILL = { idle: 'fill-subtle', flowing: 'fill-accent', returning: 'fill-danger' } as const
/** Box text, in SVG units: the label's font and the average width of one of its characters, then the smaller lines'. */
const LABEL_CHAR = 7.4
const SMALL_FONT = 11
const SMALL_CHAR = 5.7
/** How far a box moves per arrow key, and how far a pointer must travel before a press becomes a drag (CSS px). */
const KEY_STEP = 16
const DRAG_PX = 4

export interface BoardGraphProps {
  block: BoardGraphBlock
  number?: number
  /** The screen's ticking clock: the time working of an active agent runs with it. */
  now: number
  /** The agent whose work is shown alone; null when none. */
  picked: string | null
  onPick: (node: BoardNode | null) => void
  /** Boxes the person moved on this computer. */
  overrides: GraphOverrides
  onMove: (overrides: GraphOverrides) => void
}

/** The facts of a box: its model, then tokens and time working; each only when the tool sent it, an empty line when none. */
export function nodeFacts(node: BoardNode, now: number, locale: string, tokensLabel: (n: string) => string): [string, string] {
  const parts: string[] = []
  if (node.tokens !== undefined) parts.push(tokensLabel(formatTokens(node.tokens, locale)))
  const ms = workingMs(node, now)
  if (ms !== undefined) parts.push(formatWorking(ms))
  return [node.model ?? '', parts.join(' · ')]
}

/**
 * The boxes-and-arrows diagram, drawn like the Flow maps: each box with its name, model, tokens and
 * time working. A press on a box shows only what that agent did; dragging it (or the arrow keys)
 * moves it on this computer only.
 */
export function BoardGraph({ block, number, now, picked, onPick, overrides, onMove }: BoardGraphProps) {
  const { t, locale } = useI18n()
  const svg = useRef<SVGSVGElement>(null)
  type Drag = { id: string; startX: number; startY: number; box: { x: number; y: number }; moved: boolean; pos: { x: number; y: number } }
  // The drag lives in a ref (read by the next pointer event even before React renders) and in state (to draw it).
  const dragRef = useRef<Drag | null>(null)
  const [drag, setDragState] = useState<Drag | null>(null)
  const setDrag = (d: Drag | null) => {
    dragRef.current = d
    setDragState(d)
  }
  const live: GraphOverrides = drag?.moved ? { ...overrides, [drag.id]: drag.pos } : overrides
  const layout = layoutGraph(block.nodes, block.edges, live)
  const edges = block.edges ?? []
  const labels = placeLabels(layout, edges.map((e) => e.label))
  const nodeById = new Map(block.nodes.map((n) => [n.id, n]))
  const name = given(block.title) ?? (number ? t('boards.graph.untitledNumbered', { n: number }) : t('boards.graph.untitled'))
  const touches = (from: string, to: string) => picked === null || from === picked || to === picked

  /** CSS px to drawing units: the drawing scales to the width it gets. */
  const scale = () => {
    const w = svg.current?.getBoundingClientRect().width
    return w ? layout.width / w : 1
  }
  const down = (e: PointerEvent, id: string) => {
    if (e.button !== 0) return
    const box = layout.boxes.find((b) => b.id === id)
    if (!box) return
        try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      // A pointer the element cannot capture still drags while it stays over the box.
    }
    setDrag({ id, startX: e.clientX, startY: e.clientY, box: { x: box.x, y: box.y }, moved: false, pos: { x: box.x, y: box.y } })
  }
  const move = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return
    const k = scale()
    setDrag({ ...drag, moved: true, pos: { x: drag.box.x + dx * k, y: drag.box.y + dy * k } })
  }
  const up = (node: BoardNode, e: PointerEvent) => {
    move(e)
    const drag = dragRef.current
    if (!drag) return
    if (drag.moved) onMove({ ...overrides, [drag.id]: { x: Math.max(GRAPH.pad, Math.round(drag.pos.x)), y: Math.max(GRAPH.pad, Math.round(drag.pos.y)) } })
    else onPick(picked === node.id ? null : node)
    setDrag(null)
  }
  const key = (e: KeyboardEvent, node: BoardNode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(picked === node.id ? null : node)
      return
    }
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
    if (!step) return
    e.preventDefault()
    const box = layout.boxes.find((b) => b.id === node.id)
    if (box) onMove({ ...overrides, [node.id]: { x: Math.max(GRAPH.pad, box.x + step[0]! * KEY_STEP), y: Math.max(GRAPH.pad, box.y + step[1]! * KEY_STEP) } })
  }

  return (
    <div className="overflow-x-auto">
      <svg
        ref={svg}
        role="group"
        aria-label={name}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="mx-auto block h-auto w-full select-none text-text"
        style={{ maxWidth: layout.width, minWidth: graphMinWidth(layout.width), touchAction: drag ? 'none' : undefined }}
      >
        <defs>
          {(Object.keys(ARROW_FILL) as (keyof typeof ARROW_FILL)[]).map((s) => (
            <marker key={s} id={`board-arrow-${s}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 1L10 5L0 9z" className={ARROW_FILL[s]} />
            </marker>
          ))}
        </defs>
        {layout.edges.map((shape) => {
          const edge = edges[shape.index]!
          const state = edge.state ?? 'idle'
          return (
            <path
              key={shape.index}
              d={shape.d}
              fill="none"
              strokeWidth={1.75}
              strokeLinecap="round"
              markerEnd={`url(#board-arrow-${state})`}
              opacity={touches(shape.from, shape.to) ? 1 : 0.2}
              className={cn(EDGE_STROKE[state], state === 'flowing' && 'board-edge-flowing', state === 'returning' && 'board-edge-returning')}
            >
              <title>
                {t('boards.graph.edge', { from: nodeById.get(shape.from)?.label ?? shape.from, to: nodeById.get(shape.to)?.label ?? shape.to })}
                {edge.label ? `: ${edge.label}` : ''}
              </title>
            </path>
          )
        })}
        {layout.boxes.map((box, i) => {
          const node = block.nodes[i]!
          const state = node.state ?? 'idle'
          const facts = nodeFacts(node, now, locale, (n) => t('boards.node.tokens', { n }))
          const isPicked = picked === node.id
          const textX = box.x + 14
          const room = box.w - 14 - 24
          // Model, then tokens and time, then the detail: on their own lines, so a long model name never hides the time.
          const lines = [...facts, node.detail ?? ''].filter(Boolean)
          const top = box.y + box.h / 2 - (19 + lines.length * 14) / 2
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-pressed={isPicked}
              aria-label={t('boards.node.aria', { label: node.label, state: t(NODE_STATE[state]), facts: lines.length > 0 ? `. ${lines.join(', ')}` : '' })}
              data-node={node.id}
              opacity={picked === null || isPicked ? 1 : 0.45}
              className={cn('cursor-grab outline-none [&:focus-visible>rect:first-of-type]:stroke-accent', drag?.id === node.id && drag.moved && 'cursor-grabbing')}
              onPointerDown={(e) => down(e, node.id)}
              onPointerMove={move}
              onPointerUp={(e) => up(node, e)}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => key(e, node)}
            >
              <title>{[node.label, ...lines, node.hint].filter(Boolean).join('\n')}</title>
              <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={9} strokeWidth={isPicked ? 2.5 : 1.25} className={cn(NODE_RECT[state], isPicked && 'stroke-accent')} />
              <rect x={box.x + 1} y={box.y + 8} width={3} height={box.h - 16} rx={1.5} className={NODE_BAR[state]} />
              <text x={textX} y={top} fontSize={GRAPH.labelFont} fontWeight={600} dominantBaseline="hanging" fill="currentColor" className={state === 'placeholder' ? 'text-muted' : 'text-text'}>
                {clip(node.label, charsIn(room, LABEL_CHAR))}
              </text>
              {lines.map((line, n) => (
                <text key={n} x={textX} y={top + 18 + n * 14} fontSize={SMALL_FONT} dominantBaseline="hanging" fill="currentColor" className="text-muted">
                  {clip(line, charsIn(box.w - 24, SMALL_CHAR))}
                </text>
              ))}
              {state === 'done' && <Check x={box.x + box.w - 22} y={box.y + 8} width={14} height={14} className="text-success" aria-hidden />}
              {state === 'blocked' && <TriangleAlert x={box.x + box.w - 22} y={box.y + 8} width={14} height={14} className="text-danger" aria-hidden />}
              {state === 'active' && <circle cx={box.x + box.w - 15} cy={box.y + 15} r={4} className="board-node-pulse fill-info" />}
            </g>
          )
        })}
        {labels.map((l) => {
          const edge = edges[l.index]!
          const w = l.text.length * GRAPH.edgeCharW + 8
          return (
            <g key={l.index} opacity={touches(edge.from, edge.to) ? 1 : 0.2} aria-hidden>
              <rect x={l.x - w / 2} y={l.y - 8} width={w} height={16} rx={8} strokeWidth={0.8} className={cn('fill-surface', edge.state === 'returning' ? 'stroke-danger' : 'stroke-border')} />
              <text x={l.x} y={l.y} textAnchor="middle" dominantBaseline="central" fontSize={GRAPH.edgeFont} className={edge.state === 'returning' ? 'fill-danger' : 'fill-muted'}>
                {l.text}
                {l.cut && <title>{edge.label}</title>}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
