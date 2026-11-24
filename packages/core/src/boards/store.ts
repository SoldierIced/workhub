import { boardLiveness } from './liveness'
import { parseBoard } from './schema'
import { BOARD_LIMITS, type Board, type BoardsState, type BoardSummary, type StoredBoard } from './types'

export const EMPTY_BOARDS: BoardsState = { version: 1, boards: [] }

/** How a board is addressed: its chat and its id ("<chat>/<id>"), or its id alone when it has no chat. `/` cannot be part of an id. */
export const boardKey = (stored: Pick<StoredBoard, 'chat'> & { board: Pick<Board, 'id'> }): string => (stored.chat ? `${stored.chat}/${stored.board.id}` : stored.board.id)

/**
 * Stores a board for a chat. The same id from the same chat replaces the earlier one (keeping
 * `firstReceivedAt`); the same id from another chat is another board. A board kept from before boards
 * belonged to a chat is taken over by the first chat that sends its id. A new board over the cap drops
 * the not-live board that arrived longest ago, whatever its chat; when every board is live it is refused.
 * `dropped` holds the boards the cap pushed out; `retired` the key a taken-over board had, which no longer exists.
 */
export function putBoard(state: BoardsState, board: Board, now: number, sessionId?: string, chat?: string): { ok: true; state: BoardsState; dropped: StoredBoard[]; retired?: string } | { ok: false; reason: 'full' } {
  const key = boardKey({ chat, board })
  const existing = state.boards.find((s) => boardKey(s) === key) ?? (chat ? state.boards.find((s) => s.chat === undefined && s.sessionId !== undefined && s.board.id === board.id) : undefined)
  const stored: StoredBoard = { board, receivedAt: now, firstReceivedAt: existing?.firstReceivedAt ?? now, ...(sessionId !== undefined ? { sessionId } : {}), ...(chat ? { chat } : {}) }
  if (existing) return { ok: true, state: { version: 1, boards: state.boards.map((s) => (s === existing ? stored : s)) }, dropped: [], ...(boardKey(existing) !== key ? { retired: boardKey(existing) } : {}) }
  let boards = state.boards
  const dropped: StoredBoard[] = []
  while (boards.length >= BOARD_LIMITS.boardsPerProfile) {
    let victim: StoredBoard | undefined
    for (const s of boards) if (boardLiveness(s, now) !== 'live' && (!victim || s.receivedAt < victim.receivedAt)) victim = s
    if (!victim) return { ok: false, reason: 'full' }
    dropped.push(victim)
    boards = boards.filter((s) => s !== victim)
  }
  return { ok: true, state: { version: 1, boards: [...boards, stored] }, dropped }
}

/** Removes the board with that key (`boardKey`). */
export function removeBoard(state: BoardsState, key: string): { state: BoardsState; removed: boolean } {
  const boards = state.boards.filter((s) => boardKey(s) !== key)
  return boards.length === state.boards.length ? { state, removed: false } : { state: { version: 1, boards }, removed: true }
}

/** Newest `firstReceivedAt` first. */
export function boardsOf(state: BoardsState): StoredBoard[] {
  return [...state.boards].sort((a, b) => b.firstReceivedAt - a.firstReceivedAt)
}

export function summarize(stored: StoredBoard): BoardSummary {
  const { board } = stored
  return {
    key: boardKey(stored),
    id: board.id,
    ...(stored.chat ? { chat: stored.chat } : {}),
    title: board.title,
    status: board.status,
    ...(board.heartbeatSeconds !== undefined ? { heartbeatSeconds: board.heartbeatSeconds } : {}),
    receivedAt: stored.receivedAt,
    firstReceivedAt: stored.firstReceivedAt
  }
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Reads what was stored, however damaged: a wrong shape gives no boards; a board that no longer parses or has bad times is dropped. */
export function sanitizeBoardsState(raw: unknown): BoardsState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_BOARDS
  const list = (raw as { boards?: unknown }).boards
  if (!Array.isArray(list)) return EMPTY_BOARDS
  const boards: StoredBoard[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const { board, receivedAt, firstReceivedAt, sessionId, chat } = item as Record<string, unknown>
    if (!isTime(receivedAt) || !isTime(firstReceivedAt)) continue
    const parsed = parseBoard(board)
    const owner = typeof chat === 'string' && chat !== '' && chat.length <= 200 && !chat.includes('/') ? chat : undefined
    if (!parsed.ok) continue
    const key = boardKey({ chat: owner, board: parsed.board })
    if (seen.has(key)) continue
    seen.add(key)
    boards.push({ board: parsed.board, receivedAt, firstReceivedAt, ...(typeof sessionId === 'string' ? { sessionId } : {}), ...(owner ? { chat: owner } : {}) })
    if (boards.length >= BOARD_LIMITS.boardsPerProfile) break
  }
  return { version: 1, boards }
}
