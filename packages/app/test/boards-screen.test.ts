import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { boardLiveness, productBoard, type Board, type BoardLogEntry, type StoredBoard } from '@workhub/core'
import { GRAPH, graphMinWidth, layoutGraph } from '../src/renderer/lib/boardGraph'
import { boardTimeOptions, columnPercents, given, hasDetailEntries, itemKey, keptRemoval, logRows, selectedBoardId, untitledNumbers } from '../src/renderer/lib/boards'
import { BoardHeader } from '../src/renderer/screens/boards/BoardHeader'
import { BoardView } from '../src/renderer/screens/boards/BoardView'
import { allNavItems, visibleNavItems } from '../src/renderer/lib/nav'
import { ROUTE_ICON, ROUTE_LABEL } from '../src/renderer/lib/routes'
import { TooltipProvider } from '../src/renderer/components/atoms'

const NOW = new Date(2026, 10, 6, 12, 0).getTime()
const MIN = 60_000

describe('graph geometry', () => {
  const nodes = [
    { id: 'a', label: 'A', col: 0, row: 1 },
    { id: 'b', label: 'B', col: 1, row: 0 },
    { id: 'c', label: 'C', col: 1, row: 2 }
  ]

  it('puts each node in the cell its tool chose and sizes the drawing around them', () => {
    const { boxes, width, height } = layoutGraph(nodes, [])
    const [a, b, c] = boxes
    expect(a).toMatchObject({ x: GRAPH.pad, y: GRAPH.pad + GRAPH.boxH + GRAPH.gapY, w: GRAPH.boxW, h: GRAPH.boxH })
    expect(b!.x).toBe(GRAPH.pad + GRAPH.boxW + GRAPH.gapX)
    expect(c!.y).toBe(GRAPH.pad + 2 * (GRAPH.boxH + GRAPH.gapY))
    expect(width).toBe(b!.x + GRAPH.boxW + GRAPH.pad)
    expect(height).toBe(c!.y + GRAPH.boxH + GRAPH.pad)
  })

  it('draws an edge to a column further right from the right side to the left side', () => {
    const { boxes, edges } = layoutGraph(nodes, [{ from: 'a', to: 'b' }])
    const [a, b] = boxes
    expect(edges).toHaveLength(1)
    expect(edges[0]!.lane).toBe(false)
    expect(edges[0]!.d.startsWith(`M${a!.x + a!.w} ${a!.y + a!.h / 2}C`)).toBe(true)
    expect(edges[0]!.d.endsWith(`${b!.x} ${b!.y + b!.h / 2}`)).toBe(true)
    // The label sits midway between the two sides.
    expect(edges[0]!.labelX).toBe((a!.x + a!.w + b!.x) / 2)
  })

  it('sends any other edge along a lane under the lowest row, a lane of its own each, and grows the drawing for them', () => {
    const plain = layoutGraph(nodes, [])
    const { boxes, edges, height } = layoutGraph(nodes, [
      { from: 'c', to: 'a' },
      { from: 'b', to: 'c' },
      { from: 'b', to: 'b2-missing' }
    ])
    // Straight down in the same column is not "further right": it is a lane too.
    expect(edges.map((e) => e.lane)).toEqual([true, true])
    const lowest = Math.max(...boxes.map((b) => b.y + b.h))
    expect(edges[0]!.labelY).toBe(lowest + GRAPH.laneStart)
    expect(edges[1]!.labelY).toBe(lowest + GRAPH.laneStart + GRAPH.laneStep)
    expect(height).toBe(plain.height - GRAPH.pad + GRAPH.laneStart + GRAPH.laneStep + GRAPH.pad)
    // It leaves the source's bottom and comes up into the target's bottom.
    const c = boxes[2]!
    const a = boxes[0]!
    expect(edges[0]!.d.startsWith(`M${c.x + c.w / 2 + GRAPH.laneShift} ${c.y + c.h}V`)).toBe(true)
    expect(edges[0]!.d.endsWith(`V${a.y + a.h}`)).toBe(true)
  })

  it('never lets the labels fall below a readable size: the minimum width follows the drawing, and a wide one scrolls', () => {
    const wide = (columns: number) => layoutGraph(Array.from({ length: columns }, (_, c) => ({ id: `n${c}`, label: `N${c}`, col: c, row: 0 })), [])
    for (const columns of [1, 4, 6, 12]) {
      const { width } = wide(columns)
      const min = graphMinWidth(width)
      // Drawn at its narrowest, a box label (GRAPH.labelFont units) is still at least minLabelPx on screen.
      expect((min / width) * GRAPH.labelFont).toBeGreaterThanOrEqual(GRAPH.minLabelPx)
      expect(min).toBeLessThanOrEqual(width)
    }
    // 6 columns: about 1.5k units wide, so it cannot be squeezed under about 1.25k px (it used to be 800).
    expect(wide(6).width).toBe(2 * GRAPH.pad + 6 * GRAPH.boxW + 5 * GRAPH.gapX)
    expect(graphMinWidth(wide(6).width)).toBeGreaterThan(1200)
    // 12 columns: three thousand units, at least 2.5k px (it used to be 800, which drew the labels at about 5 px).
    expect(graphMinWidth(wide(12).width)).toBeGreaterThan(2500)
    // The sample's four columns fit a normal window, next to the list of chats, without scrolling.
    expect(graphMinWidth(wide(4).width)).toBeLessThan(950)
  })

  it('leaves out an edge whose end is not a node', () => {
    expect(layoutGraph(nodes, [{ from: 'a', to: 'zzz' }]).edges).toEqual([])
  })
})

describe('which board is shown (decision 16)', () => {
  const list = [{ key: 'new' }, { key: 'mid' }, { key: 'old' }]
  it('follows the newest until one is picked', () => {
    expect(selectedBoardId(list, null)).toBe('new')
    expect(selectedBoardId([{ key: 'newer' }, ...list], null)).toBe('newer')
  })
  it('stays on the picked one when a newer arrives', () => {
    expect(selectedBoardId([{ key: 'newer' }, ...list], 'mid')).toBe('mid')
  })
  it('goes back to the newest when the picked one is gone, and the pick is dropped', () => {
    const without = list.filter((b) => b.key !== 'mid')
    expect(selectedBoardId(without, 'mid')).toBe('new')
  })
  it('shows nothing when there are no boards', () => {
    expect(selectedBoardId([], null)).toBeNull()
    expect(selectedBoardId([], 'x')).toBeNull()
  })
})

describe('the question before removing a board', () => {
  const list = [{ key: 'new' }, { key: 'old' }]
  it('stays about the board it was opened for, whatever else arrives', () => {
    const target = { key: 'old', title: 'Old one' }
    expect(keptRemoval(list, target)).toBe(target)
    expect(keptRemoval([{ key: 'newer' }, ...list], target)).toBe(target)
  })
  it('closes when that board is gone, and when there is no question', () => {
    expect(keptRemoval([{ key: 'new' }], { key: 'old', title: 'Old one' })).toBeNull()
    expect(keptRemoval([], { key: 'old', title: 'Old one' })).toBeNull()
    expect(keptRemoval(list, null)).toBeNull()
  })
})

describe('time and table helpers', () => {
  it('shows only the hour today and the date on another day', () => {
    expect(boardTimeOptions(NOW - 30 * MIN, NOW)).toEqual({ hour: '2-digit', minute: '2-digit' })
    const earlier = boardTimeOptions(NOW - 30 * 60 * MIN, NOW)
    expect(earlier).toMatchObject({ day: 'numeric', month: 'short', hour: '2-digit' })
    // 23:59 yesterday is another day even though it is minutes ago at 00:01.
    const lateNight = new Date(2026, 10, 6, 0, 1).getTime()
    expect(boardTimeOptions(lateNight - 2 * MIN, lateNight)).toHaveProperty('day')
  })

  it('turns widths into proportions, 1 when absent', () => {
    expect(columnPercents([{ label: 'a', width: 0.5 }, { label: 'b', width: 3 }, { label: 'c', width: 1 }])).toEqual([11.11, 66.67, 22.22])
    expect(columnPercents([{ label: 'a' }, { label: 'b' }])).toEqual([50, 50])
  })
})

describe('log rows', () => {
  const entries: BoardLogEntry[] = [
    { at: 100, text: 'Old line' },
    { at: 300, text: 'Newest line' },
    { at: 200, text: 'Tool call: read FILE', detail: true },
    { at: 200, text: 'Same time' }
  ]
  it('is newest first, a tie in the order sent, and hides detail entries by default', () => {
    expect(logRows(entries, '', false).map((r) => r.entry.text)).toEqual(['Newest line', 'Same time', 'Old line'])
    expect(logRows(entries, '', true).map((r) => r.entry.text)).toEqual(['Newest line', 'Tool call: read FILE', 'Same time', 'Old line'])
  })
  it('filters by text, ignoring case and surrounding spaces, within what is shown', () => {
    expect(logRows(entries, '  LINE ', false).map((r) => r.entry.text)).toEqual(['Newest line', 'Old line'])
    expect(logRows(entries, 'file', false)).toEqual([])
    expect(logRows(entries, 'file', true)).toHaveLength(1)
    expect(logRows(entries, 'nothing', true)).toEqual([])
  })
  it('keeps the key of an entry when others arrive, and tells identical entries apart', () => {
    const before = logRows(entries, '', true).find((r) => r.entry.text === 'Old line')!.key
    const after = logRows([{ at: 400, text: 'Brand new' }, ...entries], '', true).find((r) => r.entry.text === 'Old line')!.key
    expect(after).toBe(before)
    const twins = logRows([{ at: 1, text: 'x' }, { at: 1, text: 'x' }], '', false)
    expect(new Set(twins.map((r) => r.key)).size).toBe(2)
  })
  it('offers the details checkbox only when some entry is a detail', () => {
    expect(hasDetailEntries(entries)).toBe(true)
    expect(hasDetailEntries(entries.filter((e) => !e.detail))).toBe(false)
  })
})

describe('the board view', () => {
  const stored = (board: Board, receivedAt = NOW): StoredBoard => ({ board, receivedAt, firstReceivedAt: receivedAt })
  const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored: stored(productBoard(NOW)), now: NOW })))

  it('draws every kind of block of the sample board under its title', () => {
    for (const kind of ['steps', 'graph', 'list', 'table', 'log', 'text']) expect(html).toContain(`data-block="${kind}"`)
    for (const title of ['Stages', 'Who asks whom', 'Agents', 'Decisions', 'Log']) expect(html).toContain(`>${title}</h3>`)
    // Steps, graph (an accessible name, nodes, edge labels), list, table, text.
    expect(html).toContain('Review')
    expect(html).toContain('aria-label="Who asks whom"')
    expect(html).toContain('Builder: jobs')
    expect(html).toContain('>question<')
    expect(html).toContain('board-edge-returning')
    expect(html).toContain('coordinating')
    expect(html).toContain('2 minutes ago')
    expect(html).toContain('Skip the load test: no traffic-facing change')
    expect(html).toContain('<del>Run the load test before deploy</del>')
    expect(html).toContain('aria-label="Search the log: Log"')
  })

  it('tells the steps apart by more than colour', () => {
    expect(html).toContain('line-through')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('(done)')
    expect(html).toContain('(not started)')
  })

  it('hides the detail entries of a log by default and offers the checkbox with the tool\'s own label', () => {
    expect(html).toContain('Show tool calls')
    expect(html).toContain('type="checkbox"')
    expect(html).not.toContain('api: pagination fix started.')
    expect(html).not.toContain('reviewer: read web/settings.tsx')
    expect(html).toContain('api: tests green.')
  })

  it('draws every string as text and keeps line breaks where the format says so', () => {
    const board: Board = {
      format: 'workhub.board',
      version: 1,
      id: 'x',
      title: 'T',
      status: 'live',
      blocks: [
        { type: 'text', text: 'line one\nline <b>two</b>' },
        { type: 'table', columns: [{ label: '<i>Col</i>' }], rows: [{ cells: ['a\nb <script>x</script>'] }] },
        { type: 'list', items: [{ label: '<u>who</u>', text: 'x\ny' }] }
      ]
    }
    const out = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored: stored(board), now: NOW })))
    expect(out).toContain('line &lt;b&gt;two&lt;/b&gt;')
    expect(out).toContain('&lt;i&gt;Col&lt;/i&gt;')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&lt;u&gt;who&lt;/u&gt;')
    for (const tag of ['b', 'i', 'u', 'script']) expect(out.toLowerCase()).not.toContain(`<${tag}>`)
    expect(out).toContain('whitespace-pre-wrap')
  })

  it('draws nothing for what the tool did not send, and the empty texts for empty blocks', () => {
    const board: Board = {
      format: 'workhub.board',
      version: 1,
      id: 'x',
      title: 'T',
      status: 'live',
      blocks: [
        { type: 'list', items: [{ label: 'Only a label' }] },
        { type: 'list', items: [] },
        { type: 'list', items: [], empty: 'No agents yet.' },
        { type: 'table', columns: [{ label: 'A' }, { label: 'B' }], rows: [] },
        { type: 'log', entries: [] },
        { type: 'graph', nodes: [{ id: 'n', label: 'Solo', col: 0, row: 0 }] }
      ]
    }
    const out = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored: stored(board), now: NOW })))
    expect(out).not.toContain('undefined')
    expect(out).toContain('Nothing here yet')
    expect(out).toContain('No agents yet.')
    expect(out).toContain('Nothing yet')
    expect(out).not.toContain('type="checkbox"')
    expect(out).toContain('aria-label="Solo, waiting. Press to show only what it did; arrow keys move the box."')
  })
})

describe('names of controls and fields sent empty', () => {
  const stored = (blocks: Board['blocks']): StoredBoard => ({ board: { format: 'workhub.board', version: 1, id: 'x', title: 'T', status: 'live', blocks }, receivedAt: NOW, firstReceivedAt: NOW })
  const draw = (blocks: Board['blocks']) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored: stored(blocks), now: NOW })))
  const log = (extra: object = {}) => ({ type: 'log' as const, entries: [{ at: 1, text: 'a' }, { at: 2, text: 'b', detail: true }], ...extra })
  const node = { id: 'n', label: 'N', col: 0, row: 0 }

  it('names the details checkbox for its block, with the label the tool chose or the default', () => {
    const out = draw([log({ title: 'Build log', detailLabel: 'Show tool calls' }), log({ title: 'Deploy log' })])
    expect(out).toContain('aria-label="Show tool calls: Build log"')
    expect(out).toContain('aria-label="Show details: Deploy log"')
    // The visible label is not replaced.
    expect(out).toContain('Show tool calls</label>')
    expect(out).toContain('Show details</label>')
  })

  it('numbers blocks without a title only when there are several of that kind', () => {
    expect(untitledNumbers([{ type: 'log', entries: [] }, { type: 'text', text: 'x' }, { type: 'graph', nodes: [node] }, { type: 'log', entries: [], title: 'Named' }, { type: 'log', entries: [] }, { type: 'graph', nodes: [node], title: '' }])).toEqual([1, undefined, 1, undefined, 2, 2])
    expect(untitledNumbers([{ type: 'log', entries: [] }, { type: 'log', entries: [], title: 'Named' }])).toEqual([undefined, undefined])
    const out = draw([log(), log(), { type: 'graph', nodes: [node] }, { type: 'graph', nodes: [node] }])
    expect(out).toContain('aria-label="Search the log 1"')
    expect(out).toContain('aria-label="Search the log 2"')
    expect(out).toContain('aria-label="Show details: Log 1"')
    expect(out).toContain('aria-label="Show details: Log 2"')
    expect(out).toContain('aria-label="Diagram of who asks whom 1"')
    expect(out).toContain('aria-label="Diagram of who asks whom 2"')
    // A single untitled block keeps the plain name.
    const one = draw([log(), { type: 'graph', nodes: [node] }])
    expect(one).toContain('aria-label="Search the log"')
    expect(one).toContain('aria-label="Show details: Log"')
    expect(one).toContain('aria-label="Diagram of who asks whom"')
  })

  it('treats a field sent as an empty string as absent', () => {
    const out = draw([
      log({ title: '', detailLabel: '' }),
      { type: 'list', title: '', items: [], empty: '' },
      { type: 'list', items: [{ label: 'Who', detail: '', text: '' }] },
      { type: 'steps', steps: [{ label: 'S', state: 'done' }], note: '' },
      { type: 'table', columns: [{ label: 'A' }], rows: [{ cells: ['x'] }], note: '' },
      { type: 'graph', title: '', nodes: [{ ...node, detail: '', hint: '' }] }
    ])
    expect(out).toContain('Show details</label>')
    expect(out).toContain('aria-label="Search the log"')
    expect(out).toContain('Nothing here yet')
    expect(out).toContain('aria-label="Diagram of who asks whom"')
    expect(out).not.toMatch(/<h3/)
    expect(out).not.toContain('text-sm text-muted"></p>')
    expect(out).not.toContain('<title></title>')
    expect(out).not.toMatch(/<p[^>]*><\/p>/)
    expect(given('')).toBeUndefined()
    expect(given('x')).toBe('x')
  })

  it('gives list items keys that cannot collide, with or without an id', () => {
    const keys = [{ id: '1' }, {}, { id: 'at:1' }, { id: '2' }].map((item, i) => itemKey(item, i))
    expect(new Set(keys).size).toBe(4)
    expect(itemKey({ id: '1' }, 1)).not.toBe(itemKey({}, 1))
  })
})

describe('the board header', () => {
  const stored = (over: Partial<Board>, receivedAt: number): StoredBoard => ({ board: { ...productBoard(NOW), ...over }, receivedAt, firstReceivedAt: receivedAt })
  const header = (s: StoredBoard, now: number) => renderToStaticMarkup(createElement(BoardHeader, { stored: s, now }))

  it('shows the title, the subtitle, the status and when it was updated', () => {
    const out = header(stored({ heartbeatSeconds: 60 }, NOW - MIN), NOW)
    expect(out).toContain('Release 4.2')
    expect(out).toContain('Sample board')
    expect(out).toContain('>Live<')
    expect(out).toMatch(/Updated \d/)
  })

  it('turns a live board into "No news since" by the clock alone, and says the time once', () => {
    const s = stored({ heartbeatSeconds: 60 }, NOW)
    expect(boardLiveness(s, NOW + 2 * MIN)).toBe('live')
    const later = header(s, NOW + 4 * MIN)
    expect(later).toContain('No news since')
    expect(later).not.toContain('Updated')
    expect(later).not.toContain('>Live<')
  })

  it('shows the date of a time that is not today', () => {
    const out = header(stored({ status: 'finished' }, NOW - 3 * 24 * 60 * MIN), NOW)
    expect(out).toContain('>Finished<')
    expect(out).toMatch(/Nov|3/)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('the board header with empty fields', () => {
  it('draws no subtitle when it was sent empty', () => {
    const s: StoredBoard = { board: { ...productBoard(NOW), subtitle: '' }, receivedAt: NOW, firstReceivedAt: NOW }
    expect(renderToStaticMarkup(createElement(BoardHeader, { stored: s, now: NOW }))).not.toMatch(/<p[ >]/)
  })
})

describe('the route', () => {
  it('is gone: boards live in the chat that sent them, so no screen of their own is listed', () => {
    const on = { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: true, boards: true }
    expect(visibleNavItems(on).map((i) => i.route)).toEqual(['home', 'pullRequests', 'tickets', 'history', 'plan', 'usage'])
    expect(allNavItems(on).map((i) => i.route)).not.toContain('boards')
    expect('boards' in ROUTE_LABEL).toBe(false)
    expect('boards' in ROUTE_ICON).toBe(false)
  })
})
