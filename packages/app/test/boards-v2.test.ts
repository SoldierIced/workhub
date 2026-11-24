import { describe, expect, it } from 'vitest'
import type { BoardBlock, BoardEdge, BoardNode } from '@workhub/core'
import { GRAPH, clip, layoutGraph, placeLabels } from '../src/renderer/lib/boardGraph'
import { blockIdentities, filterBlockByAgent, formatWorking, workingMs } from '../src/renderer/lib/boards'

const node = (id: string, col: number, row: number, label = id): BoardNode => ({ id, label, col, row })

describe('graph labels', () => {
  // The board that showed the overlap: a lead with five agents, long labels both ways.
  const nodes = [node('lead', 0, 1, 'Orchestrator'), node('a1', 1, 0, 'agent1'), node('a2', 1, 1, 'agent2'), node('a3', 1, 2, 'agent3'), node('rev', 2, 1, 'Reviewer')]
  const edges: BoardEdge[] = [
    { from: 'lead', to: 'a1', label: 'implements the pagination fix' },
    { from: 'lead', to: 'a2', label: 'writes the migration for the table' },
    { from: 'lead', to: 'a3', label: 'updates the user guide' },
    { from: 'a1', to: 'rev', label: 'asks for a review of the change' },
    { from: 'a2', to: 'rev', label: 'asks for a review' },
    { from: 'a3', to: 'lead', label: 'question about the wording' },
    { from: 'a2', to: 'lead', label: 'blocked: needs a decision' },
    { from: 'rev', to: 'lead', label: 'changes requested' }
  ]
  const rect = (l: { x: number; y: number; text: string }) => {
    const w = l.text.length * GRAPH.edgeCharW + 8
    return { x: l.x - w / 2, y: l.y - (GRAPH.edgeFont + 5) / 2, w, h: GRAPH.edgeFont + 5 }
  }
  const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('never draws a label over a box or over another label', () => {
    const layout = layoutGraph(nodes, edges)
    const placed = placeLabels(layout, edges.map((e) => e.label))
    expect(placed.length).toBeGreaterThan(0)
    for (const [i, l] of placed.entries()) {
      for (const b of layout.boxes) expect(hit(rect(l), b), `${l.text} on ${b.id}`).toBe(false)
      for (const other of placed.slice(i + 1)) expect(hit(rect(l), rect(other)), `${l.text} on ${other.text}`).toBe(false)
    }
  })

  it('cuts a label to the room its edge has and says it was cut', () => {
    const layout = layoutGraph(nodes, edges)
    const first = placeLabels(layout, edges.map((e) => e.label)).find((l) => l.index === 0)!
    expect(first.cut).toBe(true)
    expect(first.text.endsWith('…')).toBe(true)
    expect(first.text.length * GRAPH.edgeCharW).toBeLessThanOrEqual(GRAPH.gapX)
    expect(clip('short', 10)).toBe('short')
  })

  it('puts a moved box where the person left it and routes its edges from there', () => {
    const plain = layoutGraph(nodes, edges)
    const moved = layoutGraph(nodes, edges, { a3: { x: 900, y: 40 } })
    expect(moved.boxes.find((b) => b.id === 'a3')).toMatchObject({ x: 900, y: 40 })
    expect(moved.width).toBeGreaterThan(plain.width)
    // The edge from the lead now reaches the box where it is.
    const toA3 = moved.edges.find((e) => e.to === 'a3')!
    expect(toA3.d.endsWith('900 84')).toBe(true)
    // Never above or left of the margin.
    expect(layoutGraph(nodes, [], { a1: { x: -50, y: -5 } }).boxes.find((b) => b.id === 'a1')).toMatchObject({ x: GRAPH.pad, y: GRAPH.pad })
  })
})

describe('block identities', () => {
  it('tells apart blocks of one kind and title', () => {
    expect(blockIdentities([{ type: 'list' }, { type: 'list' }, { type: 'list', title: 'x' }])).toEqual(['list:', 'list:#2', 'list:x'])
  })
})

describe('what one agent did', () => {
  const agent = { id: 'a3', label: 'agent3' }
  const ids = new Set(['lead', 'a1', 'a3'])

  it('trusts the agent the tool named, and the list item ids that are nodes', () => {
    const list: BoardBlock = { type: 'list', items: [{ id: 'a1', label: 'agent1' }, { id: 'a3', label: 'agent3' }, { label: 'other', agent: 'a3' }] }
    const out = filterBlockByAgent(list, agent, ids)
    expect(out.match).toBe('agent')
    expect(out.block.type === 'list' && out.block.items.map((i) => i.label)).toEqual(['agent3', 'other'])
    const log: BoardBlock = { type: 'log', entries: [{ at: 1, text: 'agent3 did x', agent: 'a1' }, { at: 2, text: 'y', agent: 'a3' }] }
    expect(filterBlockByAgent(log, agent, ids).block).toMatchObject({ entries: [{ text: 'y' }] })
  })

  it('falls back to entries that mention the agent, and says so', () => {
    const table: BoardBlock = { type: 'table', columns: [{ label: 'Decision' }, { label: 'Who' }], rows: [{ cells: ['Ship', 'Agent3'] }, { cells: ['Wait', 'agent1'] }] }
    const out = filterBlockByAgent(table, agent, ids)
    expect(out.match).toBe('mention')
    expect(out.block.type === 'table' && out.block.rows.map((r) => r.cells[0])).toEqual(['Ship'])
  })

  it('leaves the stages, the graph and texts alone', () => {
    const steps: BoardBlock = { type: 'steps', steps: [{ label: 'x', state: 'done' }] }
    expect(filterBlockByAgent(steps, agent, ids)).toEqual({ block: steps, match: 'none' })
  })
})

describe('time working', () => {
  it('runs until the agent stops and is unknown without a start', () => {
    expect(workingMs({ startedAt: 1000 }, 61_000)).toBe(60_000)
    expect(workingMs({ startedAt: 1000, endedAt: 11_000 }, 99_000)).toBe(10_000)
    expect(workingMs({}, 5)).toBeUndefined()
    expect([formatWorking(45_000), formatWorking(250_000), formatWorking(7_500_000)]).toEqual(['45s', '4m', '2h 05m'])
  })
})

describe('moved boxes, kept on this computer', () => {
  it('keeps one entry per graph, newest last, forgets the oldest past the cap and on reset', async () => {
    const { boardLayoutKey, layoutOf, withLayout } = await import('../src/renderer/lib/boards')
    const k = (n: number) => boardLayoutKey('p', `s/b${n}`, 'graph:Who asks whom')
    let saved = withLayout([], k(1), { a: { x: 1, y: 2 } }, 2)
    saved = withLayout(saved, k(2), { a: { x: 3, y: 4 } }, 2)
    saved = withLayout(saved, k(1), { a: { x: 5, y: 6 } }, 2)
    expect(saved.map((l) => l.key)).toEqual([k(2), k(1)])
    expect(layoutOf(saved, k(1))).toEqual({ a: { x: 5, y: 6 } })
    expect(withLayout(saved, k(3), { a: { x: 0, y: 0 } }, 2).map((l) => l.key)).toEqual([k(1), k(3)])
    expect(withLayout(saved, k(1), null, 2).map((l) => l.key)).toEqual([k(2)])
    expect(layoutOf([], 'x')).toEqual({})
  })
  it('reads only sane positions back from storage', async () => {
    const { parsePrefs } = await import('../src/renderer/lib/prefs')
    const p = parsePrefs(JSON.stringify({ boardLayouts: [{ key: 'k', boxes: { a: { x: 10, y: -4 }, b: { x: 'no' } } }, { key: '', boxes: {} }, 'junk'] }))
    expect(p.boardLayouts).toEqual([{ key: 'k', boxes: { a: { x: 10, y: 0 } } }])
  })
  it('loads prefs saved by the version that let blocks be reordered, and keeps the panel width in range', async () => {
    const { DEFAULT_PREFS, parsePrefs } = await import('../src/renderer/lib/prefs')
    const p = parsePrefs(JSON.stringify({ boardBlockOrder: ['table:Decisions', 'list:Agents'], boardPanelWidth: 5000 }))
    expect('boardBlockOrder' in p).toBe(false)
    expect(p.boardPanelWidth).toBe(1200)
    expect(parsePrefs(JSON.stringify({ boardPanelWidth: 'wide' })).boardPanelWidth).toBe(DEFAULT_PREFS.boardPanelWidth)
  })
})

describe('blocks are drawn in the order the tool sent them', () => {
  it('keeps the sent order, whatever the kinds', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { TooltipProvider } = await import('../src/renderer/components/atoms')
    const { BoardView } = await import('../src/renderer/screens/boards/BoardView')
    const blocks = [
      { type: 'list' as const, title: 'What each does', items: [{ label: 'Lead' }] },
      { type: 'table' as const, title: 'Decisions', columns: [{ label: 'Decision' }], rows: [{ cells: ['Ship'] }] },
      { type: 'text' as const, text: 'Note' }
    ]
    const stored = { receivedAt: 1, firstReceivedAt: 1, board: { format: 'workhub.board' as const, version: 1 as const, id: 'b', title: 'B', status: 'finished' as const, blocks } }
    const out = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored, now: 2 })))
    expect([...out.matchAll(/data-block="(\w+)"/g)].map((m) => m[1])).toEqual(['list', 'table', 'text'])
  })
})

describe('mentions are whole words', () => {
  const ids = new Set<string>()
  const log = (texts: string[]): BoardBlock => ({ type: 'log', entries: texts.map((text, i) => ({ at: i + 1, text })) })
  const shown = (agent: { id: string; label: string }, texts: string[]) => {
    const b = filterBlockByAgent(log(texts), agent, ids).block
    return b.type === 'log' ? b.entries.map((e) => e.text) : []
  }
  it('does not take agent30 for agent3, nor rapid for api', () => {
    expect(shown({ id: 'a3', label: 'agent3' }, ['agent3: done.', 'agent30 started', '(Agent3) asked', 'xagent3'])).toEqual(['agent3: done.', '(Agent3) asked'])
    expect(shown({ id: 'api', label: 'Builder: api' }, ['api: tests green', 'rapid change', 'the api.'])).toEqual(['api: tests green', 'the api.'])
    expect(shown({ id: 'web', label: 'Builder: web' }, ['web: copy done', 'acme-web deployed', 'read web/settings.tsx', 'web-ui', '(web)'])).toEqual(['web: copy done', '(web)'])
  })
})

describe('what the board draws', () => {
  it('shows name, model, tokens and time working on a box, and the stages on one line with how far the job is', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { TooltipProvider } = await import('../src/renderer/components/atoms')
    const { BoardView } = await import('../src/renderer/screens/boards/BoardView')
    const NOW = 1_800_000_000_000
    const stored = {
      receivedAt: NOW,
      firstReceivedAt: NOW,
      board: {
        format: 'workhub.board' as const,
        version: 1 as const,
        id: 'b',
        title: 'B',
        status: 'live' as const,
        blocks: [
          { type: 'steps' as const, steps: [{ label: 'Plan', state: 'done' as const }, { label: 'Build', state: 'current' as const }, { label: 'Ship', state: 'upcoming' as const }] },
          { type: 'graph' as const, nodes: [{ id: 'a3', label: 'agent3', model: 'opus', tokens: 12_300, startedAt: NOW - 250_000, state: 'active' as const, col: 0, row: 0 }, { id: 'a4', label: 'agent4', col: 1, row: 0 }] }
        ]
      }
    }
    const out = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored, now: NOW })))
    expect(out).toContain('>opus</text>')
    expect(out).toContain('12K tokens · 4m')
    expect(out).toContain('Stage 2 of 3')
    expect(out).toContain('aria-current="step"')
    // A box without facts shows only its name: nothing reads as 0.
    expect(out).not.toMatch(/agent4[^<]*·/)
    // A finished board stops the clock at its last arrival.
    const done = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored: { ...stored, board: { ...stored.board, status: 'finished' as const } }, now: NOW + 3_600_000 })))
    expect(done).toContain('12K tokens · 4m')
  })
})

describe('the examples tools read', () => {
  it('every JSON example of the workhub-board skill is a valid board', async () => {
    const { readFileSync } = await import('node:fs')
    const { parseBoard } = await import('@workhub/core')
    const text = readFileSync(new URL('../../../skills/workhub-board/SKILL.md', import.meta.url), 'utf8')
    const examples = [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as unknown)
    expect(examples.length).toBeGreaterThan(1)
    for (const doc of examples) expect(parseBoard(doc)).toMatchObject({ ok: true })
  })
})

describe('a filter that leaves a block empty', () => {
  it('says the agent has nothing there instead of "nothing yet"', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { TooltipProvider } = await import('../src/renderer/components/atoms')
    const { BoardView } = await import('../src/renderer/screens/boards/BoardView')
    // Rendered without a pick: the empty block keeps the tool's own text.
    const stored = { receivedAt: 1, firstReceivedAt: 1, board: { format: 'workhub.board' as const, version: 1 as const, id: 'b', title: 'B', status: 'finished' as const, blocks: [{ type: 'list' as const, items: [], empty: 'No agents yet.' }] } }
    const out = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BoardView, { profileId: 'p', boardKey: 'k', stored, now: 2 })))
    expect(out).toContain('No agents yet.')
    expect(out).not.toContain('board-agent-empty')
  })
})

describe('the board panel of a chat', () => {
  it('starts closed, opens and closes per session, and tells its listeners', async () => {
    const { boardPanelOpen, closeBoardPanel, toggleBoardPanel, subscribeBoardPanel } = await import('../src/renderer/lib/boardPanel')
    let calls = 0
    const off = subscribeBoardPanel(() => calls++)
    expect(boardPanelOpen('s1')).toBe(false)
    toggleBoardPanel('s1')
    expect([boardPanelOpen('s1'), boardPanelOpen('s2')]).toEqual([true, false])
    toggleBoardPanel('s1')
    expect(boardPanelOpen('s1')).toBe(false)
    toggleBoardPanel('s1')
    closeBoardPanel('s1')
    closeBoardPanel('s1')
    expect(boardPanelOpen('s1')).toBe(false)
    expect(calls).toBe(4)
    off()
    toggleBoardPanel('s2')
    expect(calls).toBe(4)
  })
})

describe('removing a board from its chat panel', () => {
  const failed = (message: string) => `could not: ${message}`
  it('says nothing when the board is gone, also when it was already gone', async () => {
    const { removeBoard } = await import('../src/renderer/lib/boards')
    const calls: string[] = []
    expect(await removeBoard(async (p, k) => (calls.push(`${p}:${k}`), true), 'p', 'chat/a', failed)).toBeNull()
    expect(await removeBoard(async () => false, 'p', 'chat/a', failed)).toBeNull()
    expect(calls).toEqual(['p:chat/a'])
  })
  it('says why when the removal fails, instead of swallowing it', async () => {
    const { removeBoard } = await import('../src/renderer/lib/boards')
    expect(await removeBoard(async () => { throw new Error('disk full') }, 'p', 'chat/a', failed)).toBe('could not: disk full')
  })
  it('has the failure text in both languages', async () => {
    const { en } = await import('../src/renderer/i18n/en')
    const { es } = await import('../src/renderer/i18n/es')
    expect(en['boards.remove.failed']).toContain('{message}')
    expect(es['boards.remove.failed']).toContain('{message}')
  })
})
