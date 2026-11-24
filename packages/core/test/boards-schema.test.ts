import { describe, expect, it } from 'vitest'
import example from '../../../docs/examples/boards/release.json'
import { BOARD_LIMITS as L, parseBoard, productBoard } from '../src'

const base = (blocks: unknown[] = [{ type: 'text', text: 'hi' }], over: Record<string, unknown> = {}) => ({ format: 'workhub.board', version: 1, id: 'b1', title: 'T', status: 'live', blocks, ...over })
const errorsOf = (doc: unknown) => {
  const r = parseBoard(doc)
  return r.ok ? [] : r.errors
}
const accepts = (doc: unknown) => expect(parseBoard(doc)).toMatchObject({ ok: true })
const rejects = (doc: unknown, field: string) => expect(errorsOf(doc).some((e) => e.startsWith(field))).toBe(true)
const node = (id: string, col: number, row: number, extra = {}) => ({ id, label: id, col, row, ...extra })

describe('parseBoard: accepted documents', () => {
  it('accepts each block kind', () => {
    accepts(base([{ type: 'steps', steps: [{ label: 'a', state: 'done', at: 5 }], note: 'n' }]))
    accepts(base([{ type: 'graph', nodes: [node('a', 0, 0), node('b', 1, 0)], edges: [{ from: 'a', to: 'b', state: 'flowing', label: 'x' }] }]))
    accepts(base([{ type: 'list', items: [], empty: 'none' }]))
    accepts(base([{ type: 'list', items: [{ label: 'x', state: { label: 's', tone: 'warn', busy: true }, text: 't', at: 1 }] }]))
    accepts(base([{ type: 'table', columns: [{ label: 'a', width: 1 }, { label: 'b' }], rows: [{ cells: ['1', '2'], struck: true, tone: 'bad' }] }]))
    accepts(base([{ type: 'log', entries: [{ at: 1, text: 'x', detail: true, tone: 'info' }], detailLabel: 'More' }]))
    accepts(base([{ type: 'text', text: 'x', tone: 'muted' }]))
  })

  it('keeps absent optional fields absent', () => {
    const r = parseBoard(base([{ type: 'graph', nodes: [node('a', 0, 0)] }, { type: 'text', text: 'x' }]))
    expect(r.ok && r.board).toEqual(base([{ type: 'graph', nodes: [node('a', 0, 0)] }, { type: 'text', text: 'x' }]))
    expect(r.ok && 'tone' in (r.board.blocks[1] as object)).toBe(false)
  })

  it('accepts the demo board and the example file', () => {
    accepts(productBoard(1_700_000_000_000))
    accepts(example)
  })

  it('the demo board uses every state', () => {
    const blocks = productBoard(1_700_000_000_000).blocks
    const json = JSON.stringify(blocks)
    for (const s of ['done', 'current', 'upcoming', 'skipped', 'idle', 'active', 'blocked', 'placeholder', 'flowing', 'returning', 'busy', 'struck', '"detail":true']) expect(json).toContain(s)
    expect(blocks.map((b) => b.type).sort()).toEqual(['graph', 'list', 'log', 'steps', 'table', 'text'])
  })
})

describe('parseBoard: limits', () => {
  it.each([
    ['format', { format: 'x' }],
    ['version', { version: 2 }],
    ['id', { id: 'a b' }],
    ['id', { id: 'x'.repeat(L.id + 1) }],
    ['title', { title: '' }],
    ['title', { title: 'x'.repeat(L.title + 1) }],
    ['subtitle', { subtitle: 'x'.repeat(L.subtitle + 1) }],
    ['status', { status: 'done' }],
    ['heartbeatSeconds', { heartbeatSeconds: L.heartbeatMin - 1 }],
    ['heartbeatSeconds', { heartbeatSeconds: L.heartbeatMax + 1 }],
    ['heartbeatSeconds', { heartbeatSeconds: 10.5 }],
    ['blocks', { blocks: [] }],
    ['blocks', { blocks: Array.from({ length: L.blocks + 1 }, () => ({ type: 'text', text: 'x' })) }]
  ])('rejects %s', (field, over) => rejects(base(undefined, over), field))

  it('accepts the boundary values', () => {
    accepts(base(undefined, { heartbeatSeconds: L.heartbeatMin }))
    accepts(base(undefined, { heartbeatSeconds: L.heartbeatMax, title: 'x'.repeat(L.title) }))
    accepts(base(Array.from({ length: L.blocks }, () => ({ type: 'text', text: 'x' }))))
  })

  const long = (n: number) => 'x'.repeat(n + 1)
  it.each([
    ['blocks[0].title', { type: 'text', text: 'x', title: long(L.blockTitle) }],
    ['blocks[0].text', { type: 'text', text: '' }],
    ['blocks[0].text', { type: 'text', text: long(L.text) }],
    ['blocks[0].steps', { type: 'steps', steps: [] }],
    ['blocks[0].steps', { type: 'steps', steps: Array.from({ length: L.steps + 1 }, () => ({ label: 'a', state: 'done' })) }],
    ['blocks[0].steps[0].label', { type: 'steps', steps: [{ label: long(L.stepLabel), state: 'done' }] }],
    ['blocks[0].steps[0].state', { type: 'steps', steps: [{ label: 'a', state: 'x' }] }],
    ['blocks[0].steps[0].at', { type: 'steps', steps: [{ label: 'a', state: 'done', at: -1 }] }],
    ['blocks[0].steps[0].at', { type: 'steps', steps: [{ label: 'a', state: 'done', at: 1.5 }] }],
    ['blocks[0].note', { type: 'steps', steps: [{ label: 'a', state: 'done' }], note: long(L.stepsNote) }],
    ['blocks[0].nodes', { type: 'graph', nodes: [] }],
    ['blocks[0].nodes', { type: 'graph', nodes: Array.from({ length: L.nodes + 1 }, (_, i) => node(`n${i}`, i % 12, Math.floor(i / 12))) }],
    ['blocks[0].nodes[0].id', { type: 'graph', nodes: [node('a b', 0, 0)] }],
    ['blocks[0].nodes[0].label', { type: 'graph', nodes: [node(long(0), 0, 0, { label: long(L.nodeLabel) })] }],
    ['blocks[0].nodes[0].detail', { type: 'graph', nodes: [node('a', 0, 0, { detail: long(L.nodeDetail) })] }],
    ['blocks[0].nodes[0].hint', { type: 'graph', nodes: [node('a', 0, 0, { hint: long(L.nodeHint) })] }],
    ['blocks[0].nodes[0].state', { type: 'graph', nodes: [node('a', 0, 0, { state: 'busy' })] }],
    ['blocks[0].nodes[0].col', { type: 'graph', nodes: [node('a', L.gridMax + 1, 0)] }],
    ['blocks[0].nodes[0].row', { type: 'graph', nodes: [node('a', 0, -1)] }],
    ['blocks[0].edges[0].label', { type: 'graph', nodes: [node('a', 0, 0), node('b', 1, 0)], edges: [{ from: 'a', to: 'b', label: long(L.edgeLabel) }] }],
    ['blocks[0].edges[0].state', { type: 'graph', nodes: [node('a', 0, 0), node('b', 1, 0)], edges: [{ from: 'a', to: 'b', state: 'x' }] }],
    ['blocks[0].edges', { type: 'graph', nodes: [node('a', 0, 0), node('b', 1, 0)], edges: Array.from({ length: L.edges + 1 }, () => ({ from: 'a', to: 'b' })) }],
    ['blocks[0].items', { type: 'list', items: Array.from({ length: L.items + 1 }, () => ({ label: 'x' })) }],
    ['blocks[0].items[0].label', { type: 'list', items: [{ label: '' }] }],
    ['blocks[0].items[0].detail', { type: 'list', items: [{ label: 'x', detail: long(L.itemDetail) }] }],
    ['blocks[0].items[0].text', { type: 'list', items: [{ label: 'x', text: long(L.itemText) }] }],
    ['blocks[0].items[0].state.label', { type: 'list', items: [{ label: 'x', state: { label: long(L.itemStateLabel) } }] }],
    ['blocks[0].items[0].state.tone', { type: 'list', items: [{ label: 'x', state: { label: 's', tone: 'red' } }] }],
    ['blocks[0].empty', { type: 'list', items: [], empty: long(L.listEmpty) }],
    ['blocks[0].columns', { type: 'table', columns: [], rows: [] }],
    ['blocks[0].columns', { type: 'table', columns: Array.from({ length: L.columns + 1 }, () => ({ label: 'c' })), rows: [] }],
    ['blocks[0].columns[0].width', { type: 'table', columns: [{ label: 'c', width: 0.4 }], rows: [] }],
    ['blocks[0].columns[0].width', { type: 'table', columns: [{ label: 'c', width: 4.5 }], rows: [] }],
    ['blocks[0].rows', { type: 'table', columns: [{ label: 'c' }], rows: Array.from({ length: L.rows + 1 }, () => ({ cells: ['x'] })) }],
    ['blocks[0].rows[0].cells[0]', { type: 'table', columns: [{ label: 'c' }], rows: [{ cells: [long(L.cell)] }] }],
    ['blocks[0].note', { type: 'table', columns: [{ label: 'c' }], rows: [], note: long(L.tableNote) }],
    ['blocks[0].entries', { type: 'log', entries: Array.from({ length: L.entries + 1 }, () => ({ at: 1, text: 'x' })) }],
    ['blocks[0].entries[0].text', { type: 'log', entries: [{ at: 1, text: '' }] }],
    ['blocks[0].entries[0].text', { type: 'log', entries: [{ at: 1, text: long(L.entryText) }] }],
    ['blocks[0].entries[0].at', { type: 'log', entries: [{ at: 0, text: 'x' }] }],
    ['blocks[0].detailLabel', { type: 'log', entries: [], detailLabel: long(L.detailLabel) }],
    ['blocks[0].type', { type: 'image' }]
  ])('rejects %s', (field, block) => rejects(base([block]), field))
})

describe('parseBoard: cross-field rules', () => {
  it('limits the length of a list item id and refuses a list that repeats one, naming the item', () => {
    accepts(base([{ type: 'list', items: [{ id: 'x'.repeat(L.itemId), label: 'a' }, { label: 'b' }, { label: 'c' }] }]))
    rejects(base([{ type: 'list', items: [{ id: 'x'.repeat(L.itemId + 1), label: 'a' }] }]), 'blocks[0].items[0].id')
    expect(errorsOf(base([{ type: 'text', text: 'x' }, { type: 'list', items: [{ id: 'a', label: 'a' }, { label: 'no id' }, { id: 'b', label: 'b' }, { id: 'a', label: 'again' }] }]))).toEqual(['blocks[1].items[3].id: duplicate item id "a"'])
    // Items without an id never count as repeats, and the same id in two lists is fine.
    accepts(base([{ type: 'list', items: [{ label: 'a' }, { label: 'a' }] }, { type: 'list', items: [{ id: 'q', label: 'a' }] }, { type: 'list', items: [{ id: 'q', label: 'a' }] }]))
  })

  it('rejects duplicate node ids, naming the node', () => {
    expect(errorsOf(base([{ type: 'text', text: 'x' }, { type: 'graph', nodes: [node('a', 0, 0), node('a', 1, 0)] }]))).toEqual(['blocks[1].nodes[1].id: duplicate node id "a"'])
  })
  it('rejects two nodes in one cell', () => {
    rejects(base([{ type: 'graph', nodes: [node('a', 2, 3), node('b', 2, 3)] }]), 'blocks[0].nodes[1].col')
  })
  it('rejects an edge to a missing node and an edge to itself', () => {
    const nodes = [node('a', 0, 0), node('b', 1, 0)]
    rejects(base([{ type: 'graph', nodes, edges: [{ from: 'a', to: 'zz' }] }]), 'blocks[0].edges[0].to')
    rejects(base([{ type: 'graph', nodes, edges: [{ from: 'zz', to: 'b' }] }]), 'blocks[0].edges[0].from')
    rejects(base([{ type: 'graph', nodes, edges: [{ from: 'a', to: 'a' }] }]), 'blocks[0].edges[0].to')
  })
  it('rejects a row whose cells differ from the columns', () => {
    rejects(base([{ type: 'table', columns: [{ label: 'a' }, { label: 'b' }], rows: [{ cells: ['1', '2'] }, { cells: ['1'] }] }]), 'blocks[0].rows[1].cells')
  })
})

describe('parseBoard: strictness', () => {
  it('rejects unknown keys at every level, naming the key', () => {
    expect(errorsOf(base(undefined, { extra: 1 }))).toEqual(['extra: unknown key'])
    expect(errorsOf(base([{ type: 'text', text: 'x', colour: 'red' }]))).toEqual(['blocks[0].colour: unknown key'])
    rejects(base([{ type: 'graph', nodes: [node('a', 0, 0, { x: 1 })] }]), 'blocks[0].nodes[0].x')
  })
  it('rejects null as a field value', () => {
    rejects(base(undefined, { subtitle: null }), 'subtitle')
    rejects(base([{ type: 'text', text: 'x', tone: null }]), 'blocks[0].tone')
    rejects(base(undefined, { heartbeatSeconds: null }), 'heartbeatSeconds')
  })
  it('rejects things that are not documents', () => {
    for (const v of [null, 'x', 3, [], undefined]) expect(parseBoard(v).ok).toBe(false)
  })
})

describe('parseBoard: agent facts and links', () => {
  it('accepts model, tokens and times on a node, and an agent on list items, rows and log entries', () => {
    accepts(base([{ type: 'graph', nodes: [node('a', 0, 0, { model: 'opus', tokens: 0, startedAt: 10, endedAt: 10 }), node('b', 1, 0, { tokens: L.nodeTokensMax, startedAt: 5 })] }]))
    accepts(base([{ type: 'list', items: [{ label: 'x', agent: 'a' }] }]))
    accepts(base([{ type: 'table', columns: [{ label: 'a' }], rows: [{ cells: ['1'], agent: 'a' }] }]))
    accepts(base([{ type: 'log', entries: [{ at: 1, text: 'x', agent: 'a.b:c-d' }] }]))
  })
  it.each([
    ['blocks[0].nodes[0].model', { model: 'x'.repeat(L.nodeModel + 1) }],
    ['blocks[0].nodes[0].tokens', { tokens: -1 }],
    ['blocks[0].nodes[0].tokens', { tokens: 1.5 }],
    ['blocks[0].nodes[0].tokens', { tokens: L.nodeTokensMax + 1 }],
    ['blocks[0].nodes[0].startedAt', { startedAt: 0 }],
    ['blocks[0].nodes[0].endedAt', { startedAt: 10, endedAt: 9 }]
  ])('rejects %s %j', (field, extra) => rejects(base([{ type: 'graph', nodes: [node('a', 0, 0, extra)] }]), field))
  it('rejects an agent that is not a node id', () => {
    rejects(base([{ type: 'list', items: [{ label: 'x', agent: 'a b' }] }]), 'blocks[0].items[0].agent')
    rejects(base([{ type: 'table', columns: [{ label: 'a' }], rows: [{ cells: ['1'], agent: '' }] }]), 'blocks[0].rows[0].agent')
    rejects(base([{ type: 'log', entries: [{ at: 1, text: 'x', agent: 'x'.repeat(L.nodeId + 1) }] }]), 'blocks[0].entries[0].agent')
  })
})
