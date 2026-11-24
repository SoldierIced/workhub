import { z } from 'zod'
import { BOARD_FORMAT, BOARD_LIMITS as L, BOARD_VERSION, type Board } from './types'

const tone = z.enum(['neutral', 'info', 'good', 'warn', 'bad', 'muted'])
const at = z.number().int().positive()
const str = (min: number, max: number) => z.string().min(min).max(max)
const title = z.string().max(L.blockTitle).optional()
const obj = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape)

const stepsBlock = obj({
  type: z.literal('steps'),
  title,
  steps: z.array(obj({ label: str(1, L.stepLabel), state: z.enum(['done', 'current', 'skipped', 'upcoming']), at: at.optional() })).min(1).max(L.steps),
  note: z.string().max(L.stepsNote).optional()
})

const nodeId = z.string().regex(new RegExp(`^[\\w.:-]{1,${L.nodeId}}$`), `an id is 1..${L.nodeId} letters, digits, "_", ".", ":" or "-"`)

const graphBlock = obj({
  type: z.literal('graph'),
  title,
  nodes: z
    .array(
      obj({
        id: nodeId,
        label: str(1, L.nodeLabel),
        detail: z.string().max(L.nodeDetail).optional(),
        hint: z.string().max(L.nodeHint).optional(),
        state: z.enum(['idle', 'active', 'blocked', 'done', 'placeholder']).optional(),
        col: z.number().int().min(0).max(L.gridMax),
        row: z.number().int().min(0).max(L.gridMax),
        model: z.string().max(L.nodeModel).optional(),
        tokens: z.number().int().min(0).max(L.nodeTokensMax).optional(),
        startedAt: at.optional(),
        endedAt: at.optional()
      })
    )
    .min(1)
    .max(L.nodes),
  edges: z
    .array(obj({ from: z.string(), to: z.string(), label: z.string().max(L.edgeLabel).optional(), state: z.enum(['idle', 'flowing', 'returning']).optional() }))
    .max(L.edges)
    .optional()
}).superRefine((g, ctx) => {
  const ids = new Set<string>()
  const cells = new Map<string, string>()
  g.nodes.forEach((n, i) => {
    if (ids.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `duplicate node id "${n.id}"` })
    ids.add(n.id)
    const cell = `${n.col}:${n.row}`
    const other = cells.get(cell)
    if (other !== undefined) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'col'], message: `node "${n.id}" sits in the same cell (col ${n.col}, row ${n.row}) as "${other}"` })
    else cells.set(cell, n.id)
    if (n.startedAt !== undefined && n.endedAt !== undefined && n.endedAt < n.startedAt) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'endedAt'], message: 'endedAt is before startedAt' })
  })
  g.edges?.forEach((e, i) => {
    if (!ids.has(e.from)) ctx.addIssue({ code: 'custom', path: ['edges', i, 'from'], message: `no node with id "${e.from}"` })
    if (!ids.has(e.to)) ctx.addIssue({ code: 'custom', path: ['edges', i, 'to'], message: `no node with id "${e.to}"` })
    if (e.from === e.to) ctx.addIssue({ code: 'custom', path: ['edges', i, 'to'], message: 'an edge needs two different nodes' })
  })
})

const listBlock = obj({
  type: z.literal('list'),
  title,
  items: z
    .array(
      obj({
        id: z.string().max(L.itemId).optional(),
        agent: nodeId.optional(),
        label: str(1, L.itemLabel),
        detail: z.string().max(L.itemDetail).optional(),
        state: obj({ label: str(1, L.itemStateLabel), tone: tone.optional(), busy: z.boolean().optional() }).optional(),
        text: z.string().max(L.itemText).optional(),
        at: at.optional()
      })
    )
    .max(L.items),
  empty: z.string().max(L.listEmpty).optional()
}).superRefine((l, ctx) => {
  const ids = new Set<string>()
  l.items.forEach((item, i) => {
    if (item.id === undefined) return
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: `duplicate item id "${item.id}"` })
    ids.add(item.id)
  })
})

const tableBlock = obj({
  type: z.literal('table'),
  title,
  columns: z.array(obj({ label: str(1, L.columnLabel), width: z.number().min(L.columnWidthMin).max(L.columnWidthMax).optional() })).min(1).max(L.columns),
  rows: z.array(obj({ cells: z.array(z.string().max(L.cell)), tone: tone.optional(), struck: z.boolean().optional(), agent: nodeId.optional() })).max(L.rows),
  note: z.string().max(L.tableNote).optional()
}).superRefine((t, ctx) => {
  t.rows.forEach((r, i) => {
    if (r.cells.length !== t.columns.length) ctx.addIssue({ code: 'custom', path: ['rows', i, 'cells'], message: `a row has ${r.cells.length} cells but the table has ${t.columns.length} columns` })
  })
})

const logBlock = obj({
  type: z.literal('log'),
  title,
  entries: z.array(obj({ at, text: str(1, L.entryText), tone: tone.optional(), detail: z.boolean().optional(), agent: nodeId.optional() })).max(L.entries),
  detailLabel: z.string().max(L.detailLabel).optional()
})

const textBlock = obj({ type: z.literal('text'), title, text: str(1, L.text), tone: tone.optional() })

export const boardSchema = obj({
  format: z.literal(BOARD_FORMAT),
  version: z.literal(BOARD_VERSION),
  id: z.string().regex(new RegExp(`^[\\w.:-]{1,${L.id}}$`), `an id is 1..${L.id} letters, digits, "_", ".", ":" or "-"`),
  title: str(1, L.title),
  subtitle: z.string().max(L.subtitle).optional(),
  status: z.enum(['live', 'paused', 'finished', 'failed']),
  heartbeatSeconds: z.number().int().min(L.heartbeatMin).max(L.heartbeatMax).optional(),
  blocks: z.array(z.discriminatedUnion('type', [stepsBlock, graphBlock, listBlock, tableBlock, logBlock, textBlock])).min(1).max(L.blocks)
})

function pathOf(path: PropertyKey[]): string {
  let out = ''
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : out ? `.${String(p)}` : String(p)
  return out || '(root)'
}

/** Validates a board document; every error names the field (`blocks[2].nodes[1].col: ...`). Nothing is filled in or cut. */
export function parseBoard(input: unknown): { ok: true; board: Board } | { ok: false; errors: string[] } {
  const parsed = boardSchema.safeParse(input)
  if (parsed.success) return { ok: true, board: parsed.data as Board }
  const errors: string[] = []
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) errors.push(`${pathOf([...issue.path, key])}: unknown key`)
    else errors.push(`${pathOf(issue.path)}: ${issue.message}`)
  }
  return { ok: false, errors }
}
