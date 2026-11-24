import type { BoardEdge, BoardNode } from '@workhub/core'

/** The size of the drawing's cells and boxes, in SVG units (the drawing scales to the width it gets). */
export const GRAPH = {
  pad: 16,
  boxW: 180,
  boxH: 88,
  gapX: 112,
  gapY: 36,
  /** First lane under the lowest row, and the distance between lanes. */
  laneStart: 24,
  laneStep: 18,
  /** Where an arrow leaves and enters a bottom side, off the centre, so going down and coming up never share a line. */
  laneShift: 12,
  corner: 8,
  /** The font size, in SVG units, of a box's label, and the smallest size it may be drawn at on screen. */
  labelFont: 13,
  minLabelPx: 11,
  /** An edge label: its font size and the width of one of its characters, in SVG units (a safe average). */
  edgeFont: 11,
  edgeCharW: 6.4,
  /** A label never gets less room than this many characters, even in a narrow gap. */
  edgeMinChars: 6
} as const

/** Where the person moved a box, in SVG units of the drawing; kept on this computer, never sent to the tool. */
export type GraphOverrides = Readonly<Record<string, { x: number; y: number }>>

export interface GraphBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface GraphEdgeShape {
  index: number
  from: string
  to: string
  /** SVG path data. */
  d: string
  /** Where the label sits: near the middle of the path. */
  labelX: number
  labelY: number
  /** Goes by a lane under the drawing instead of straight across. */
  lane: boolean
  /** The width, in SVG units, a label has along this edge before it would run into the boxes it joins. */
  room: number
}

export interface GraphLayout {
  width: number
  height: number
  boxes: GraphBox[]
  edges: GraphEdgeShape[]
}

/**
 * The narrowest the drawing may be drawn, in CSS px, for a drawing `width` units wide: the box labels (13
 * units) stay at 11 px or more, so a wide diagram scrolls sideways instead of shrinking past that. The
 * smaller texts (the detail line and the edge labels, 11 units) go down to about 9 px at that limit.
 */
export function graphMinWidth(width: number): number {
  return Math.ceil((width * GRAPH.minLabelPx) / GRAPH.labelFont)
}

const round = (n: number): number => Math.round(n * 10) / 10

/**
 * Where everything goes: a node sits in the cell (col, row) its tool chose; an edge to a node in a
 * box wholly to the right of the source's leaves its right side and enters the target's left side as a curve;
 * any other edge leaves the source's bottom, runs along a lane under the lowest row and comes up
 * into the target's bottom. Edges to a node that does not exist are left out.
 */
export function layoutGraph(nodes: readonly BoardNode[], edges: readonly BoardEdge[] = [], overrides: GraphOverrides = {}): GraphLayout {
  const { pad, boxW, boxH, gapX, gapY } = GRAPH
  const boxes: GraphBox[] = nodes.map((n) => {
    const moved = overrides[n.id]
    if (moved && Number.isFinite(moved.x) && Number.isFinite(moved.y)) return { id: n.id, x: Math.max(pad, round(moved.x)), y: Math.max(pad, round(moved.y)), w: boxW, h: boxH }
    return { id: n.id, x: pad + n.col * (boxW + gapX), y: pad + n.row * (boxH + gapY), w: boxW, h: boxH }
  })
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const lowest = boxes.reduce<number>((m, b) => Math.max(m, b.y + b.h), pad)
  const rightmost = boxes.reduce<number>((m, b) => Math.max(m, b.x + b.w), pad)

  let lanes = 0
  const shapes: GraphEdgeShape[] = []
  edges.forEach((edge, index) => {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) return
    if (b.x >= a.x + a.w) {
      // Forward: right side to left side, as an S curve.
      const x1 = a.x + a.w
      const y1 = a.y + a.h / 2
      const x2 = b.x
      const y2 = b.y + b.h / 2
      const mid = (x1 + x2) / 2
      shapes.push({ index, from: edge.from, to: edge.to, d: `M${round(x1)} ${round(y1)}C${round(mid)} ${round(y1)} ${round(mid)} ${round(y2)} ${round(x2)} ${round(y2)}`, labelX: round(mid), labelY: round((y1 + y2) / 2), lane: false, room: round(x2 - x1 - 12) })
      return
    }
    // Any other: down, along a lane of its own, and up into the target's bottom.
    const laneY = lowest + GRAPH.laneStart + lanes * GRAPH.laneStep
    lanes += 1
    const x1 = a.x + a.w / 2 + GRAPH.laneShift
    const x2 = b.x + b.w / 2 - GRAPH.laneShift
    const y1 = a.y + a.h
    const y2 = b.y + b.h
    const r = Math.min(GRAPH.corner, Math.abs(x1 - x2) / 2)
    const dir = x2 <= x1 ? -1 : 1
    const d = `M${round(x1)} ${round(y1)}V${round(laneY - r)}Q${round(x1)} ${round(laneY)} ${round(x1 + dir * r)} ${round(laneY)}H${round(x2 - dir * r)}Q${round(x2)} ${round(laneY)} ${round(x2)} ${round(laneY - r)}V${round(y2)}`
    shapes.push({ index, from: edge.from, to: edge.to, d, labelX: round((x1 + x2) / 2), labelY: round(laneY), lane: true, room: round(Math.max(Math.abs(x2 - x1), GRAPH.boxW) - 12) })
  })

  const bottom = lanes > 0 ? lowest + GRAPH.laneStart + (lanes - 1) * GRAPH.laneStep + pad : lowest + pad
  return { width: rightmost + pad, height: bottom, boxes, edges: shapes }
}

/** A text cut to `chars` characters with an ellipsis; the whole text when it fits. */
export function clip(text: string, chars: number): string {
  const n = Math.max(1, Math.floor(chars))
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

/** How many characters of a font fit in a width (SVG units), with `charW` the width of one. */
export const charsIn = (width: number, charW: number): number => Math.max(1, Math.floor(width / charW))

export interface PlacedLabel {
  /** The edge's index in the block's `edges`. */
  index: number
  x: number
  y: number
  /** What is drawn: the label, cut to the room it has. */
  text: string
  /** Whether it had to be cut (the whole label then goes in a tooltip). */
  cut: boolean
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Vertical steps tried, in SVG units, to move a label off a box or another label: nearest first. */
const LABEL_STEPS = [0, -16, 16, -32, 32, -48, 48]

/**
 * Where each edge label goes: cut to the room its edge has, then moved up or down from the edge's
 * middle until it sits on no box and on no label placed before it. A label that finds no free spot is
 * left out of the drawing (its edge still carries it as a tooltip), never drawn over a box.
 */
export function placeLabels(layout: GraphLayout, labels: readonly (string | undefined)[]): PlacedLabel[] {
  const taken: Rect[] = layout.boxes.map((b) => ({ x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }))
  const placed: PlacedLabel[] = []
  for (const shape of layout.edges) {
    const label = labels[shape.index]
    if (!label) continue
    const chars = Math.max(GRAPH.edgeMinChars, charsIn(shape.room, GRAPH.edgeCharW))
    const text = clip(label, chars)
    const w = text.length * GRAPH.edgeCharW + 8
    const h = GRAPH.edgeFont + 5
    for (const dy of LABEL_STEPS) {
      const rect = { x: shape.labelX - w / 2, y: shape.labelY + dy - h / 2, w, h }
      if (rect.y < 0 || taken.some((r) => overlaps(r, rect))) continue
      taken.push(rect)
      placed.push({ index: shape.index, x: shape.labelX, y: round(shape.labelY + dy), text, cut: text !== label })
      break
    }
  }
  return placed
}
