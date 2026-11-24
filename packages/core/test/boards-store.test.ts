import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, boardKey, boardLiveness, boardsOf, DEFAULT_HEARTBEAT_SECONDS, EMPTY_BOARDS, parseBoard, putBoard, removeBoard, sanitizeBoardsState, summarize, type Board, type BoardsState, type BoardStatus } from '../src'

const board = (id: string, status: BoardStatus = 'finished', extra: Partial<Board> = {}): Board => ({ format: 'workhub.board', version: 1, id, title: `Board ${id}`, status, blocks: [{ type: 'text', text: 'x' }], ...extra })
const put = (s: BoardsState, b: Board, now: number, session?: string, chat?: string) => {
  const r = putBoard(s, b, now, session, chat)
  if (!r.ok) throw new Error('full')
  return r
}
const MIN = 60_000

describe('boardLiveness', () => {
  const at = 1_000_000
  it('uses 60 s by default: silent after 3 minutes', () => {
    expect(DEFAULT_HEARTBEAT_SECONDS).toBe(60)
    const stored = { board: board('a', 'live'), receivedAt: at }
    expect(boardLiveness(stored, at)).toBe('live')
    expect(boardLiveness(stored, at + 3 * MIN)).toBe('live')
    expect(boardLiveness(stored, at + 3 * MIN + 1)).toBe('silent')
  })
  it('uses the declared heartbeat', () => {
    const stored = { board: board('a', 'live', { heartbeatSeconds: 10 }), receivedAt: at }
    expect(boardLiveness(stored, at + 30_000)).toBe('live')
    expect(boardLiveness(stored, at + 30_001)).toBe('silent')
    const slow = { board: board('a', 'live', { heartbeatSeconds: 3600 }), receivedAt: at }
    expect(boardLiveness(slow, at + 3 * 3600_000)).toBe('live')
    expect(boardLiveness(slow, at + 3 * 3600_000 + 1)).toBe('silent')
  })
  it('never calls a non-live status silent', () => {
    for (const status of ['paused', 'finished', 'failed'] as const) expect(boardLiveness({ board: board('a', status), receivedAt: at }, at + 1e12)).toBe(status)
  })
})

describe('putBoard', () => {
  it('replaces the same id and keeps firstReceivedAt', () => {
    const first = put(EMPTY_BOARDS, board('a', 'live'), 100, 's1')
    const second = put(first.state, board('a', 'finished', { title: 'New' }), 500, 's2')
    expect(second.state.boards).toEqual([{ board: board('a', 'finished', { title: 'New' }), receivedAt: 500, firstReceivedAt: 100, sessionId: 's2' }])
    expect(second.dropped).toEqual([])
    expect(first.state.boards[0]?.receivedAt).toBe(100)
  })

  const fill = (statuses: BoardStatus[], receivedAt: (i: number) => number): BoardsState => {
    let s = EMPTY_BOARDS
    statuses.forEach((st, i) => (s = put(s, board(`b${i}`, st, { heartbeatSeconds: 3600 }), receivedAt(i)).state))
    return s
  }

  it('at the cap drops the not-live board that arrived longest ago', () => {
    const now = 10_000
    const statuses: BoardStatus[] = Array.from({ length: BOARD_LIMITS.boardsPerProfile }, () => 'live')
    statuses[3] = 'finished'
    statuses[7] = 'failed'
    const state = fill(statuses, (i) => (i === 3 ? 900 : i === 7 ? 100 : 5000 + i))
    const r = put(state, board('new', 'live'), now)
    expect(r.dropped.map((d) => d.board.id)).toEqual(['b7'])
    expect(r.state.boards).toHaveLength(BOARD_LIMITS.boardsPerProfile)
    expect(r.state.boards.some((s) => s.board.id === 'new')).toBe(true)
  })

  it('counts a silent live board as droppable', () => {
    const state = fill(Array.from({ length: BOARD_LIMITS.boardsPerProfile }, () => 'live'), (i) => 1000 + i)
    const now = 1000 + 3 * 3600_000 + 5
    const r = put(state, board('new'), now)
    expect(r.dropped.map((d) => d.board.id)).toEqual(['b0'])
  })

  it('is full when every board is live, and a replace still works', () => {
    const state = fill(Array.from({ length: BOARD_LIMITS.boardsPerProfile }, () => 'live'), (i) => 1000 + i)
    expect(putBoard(state, board('new'), 2000)).toEqual({ ok: false, reason: 'full' })
    expect(putBoard(state, board('b4', 'finished'), 2000).ok).toBe(true)
  })
})

describe('removeBoard, boardsOf, summarize', () => {
  it('removes by id', () => {
    const s = put(put(EMPTY_BOARDS, board('a'), 1).state, board('b'), 2).state
    expect(removeBoard(s, 'a').removed).toBe(true)
    expect(removeBoard(s, 'a').state.boards.map((x) => x.board.id)).toEqual(['b'])
    const none = removeBoard(s, 'zz')
    expect(none.removed).toBe(false)
    expect(none.state).toBe(s)
  })
  it('lists newest first by firstReceivedAt, not by update', () => {
    let s = put(EMPTY_BOARDS, board('a'), 1).state
    s = put(s, board('b'), 2).state
    s = put(s, board('a', 'live'), 99).state
    expect(boardsOf(s).map((x) => x.board.id)).toEqual(['b', 'a'])
  })
  it('summarizes without the blocks', () => {
    const s = put(EMPTY_BOARDS, board('a', 'live', { heartbeatSeconds: 30 }), 7).state.boards[0]!
    expect(summarize(s)).toEqual({ key: 'a', id: 'a', title: 'Board a', status: 'live', heartbeatSeconds: 30, receivedAt: 7, firstReceivedAt: 7 })
    expect('heartbeatSeconds' in summarize(put(EMPTY_BOARDS, board('b'), 7).state.boards[0]!)).toBe(false)
  })
})

describe('sanitizeBoardsState', () => {
  it('turns anything that is not the shape into empty', () => {
    for (const v of [null, undefined, 3, 'x', [], {}, { boards: 'x' }, { boards: {} }]) expect(sanitizeBoardsState(v)).toEqual(EMPTY_BOARDS)
  })
  it('keeps good boards and drops damaged ones', () => {
    const good = { board: board('good'), receivedAt: 5, firstReceivedAt: 3, sessionId: 's' }
    const raw = {
      version: 1,
      boards: [
        good,
        { board: { ...board('bad'), status: 'nope' }, receivedAt: 5, firstReceivedAt: 3 },
        { board: board('t1'), receivedAt: 'x', firstReceivedAt: 3 },
        { board: board('t2'), receivedAt: 5, firstReceivedAt: -1 },
        { board: board('t3'), receivedAt: Infinity, firstReceivedAt: 3 },
        { board: board('t4'), firstReceivedAt: 3 },
        null,
        'x',
        { board: board('good'), receivedAt: 9, firstReceivedAt: 9 }
      ]
    }
    const s = sanitizeBoardsState(raw)
    expect(s).toEqual({ version: 1, boards: [good] })
    expect(parseBoard(s.boards[0]!.board).ok).toBe(true)
  })
})

describe('boards of a chat', () => {
  it('keeps the same id from two chats apart, and replaces within one chat whatever its session', () => {
    let s = put(EMPTY_BOARDS, board('release', 'live'), 100, 's1', 'chatA').state
    s = put(s, board('release', 'live', { title: 'B' }), 200, 's2', 'chatB').state
    expect(s.boards.map(boardKey)).toEqual(['chatA/release', 'chatB/release'])
    // The chat was resumed: a new session, the same identity.
    s = put(s, board('release', 'finished'), 300, 's3', 'chatA').state
    expect(s.boards).toHaveLength(2)
    expect(s.boards[0]).toMatchObject({ chat: 'chatA', sessionId: 's3', firstReceivedAt: 100, receivedAt: 300 })
    expect(summarize(s.boards[1]!)).toMatchObject({ key: 'chatB/release', id: 'release', chat: 'chatB' })
    expect(removeBoard(s, 'chatB/release').state.boards.map(boardKey)).toEqual(['chatA/release'])
    expect(removeBoard(s, 'release').removed).toBe(false)
  })

  it('lets the first chat that sends its id take over a board kept from before, and says which key went', () => {
    const old = put(EMPTY_BOARDS, board('release', 'live'), 100, 'gone-session').state
    const r = put(old, board('release', 'live'), 200, 's9', 'chatA')
    expect(r.state.boards).toEqual([{ board: board('release', 'live'), receivedAt: 200, firstReceivedAt: 100, sessionId: 's9', chat: 'chatA' }])
    expect(r.retired).toBe('release')
    expect(r.dropped).toEqual([])
    // The demo board has no session: a chat never takes it over.
    const demo = put(EMPTY_BOARDS, board('release'), 100).state
    expect(put(demo, board('release'), 200, 's', 'chatA').state.boards.map(boardKey)).toEqual(['release', 'chatA/release'])
  })

  it('reads the chat back from storage, and keeps the same id of two chats', () => {
    const a = { board: board('x'), receivedAt: 5, firstReceivedAt: 3, sessionId: 's', chat: 'A' }
    const b = { board: board('x'), receivedAt: 5, firstReceivedAt: 3, chat: 'B' }
    expect(sanitizeBoardsState({ boards: [a, b, { ...b, receivedAt: 9 }, { ...b, chat: 'x/y' }] }).boards).toEqual([a, b, { board: board('x'), receivedAt: 5, firstReceivedAt: 3 }])
  })
})
