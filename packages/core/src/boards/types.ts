/**
 * Live boards: a document an orchestrating tool sends to follow a job done by several agents while
 * it happens. Workhub validates it (`parseBoard`), keeps it per profile and draws it; every string
 * in it is drawn as plain text. See `docs/user-guide/live-boards.md`.
 */
export const BOARD_FORMAT = 'workhub.board'
export const BOARD_VERSION = 1

/** Every limit of the format, in one place: the schema reads them, nothing else writes the numbers. */
export const BOARD_LIMITS = {
  /** Boards kept per profile. */
  boardsPerProfile: 12,
  id: 100,
  title: 120,
  subtitle: 200,
  heartbeatMin: 5,
  heartbeatMax: 3600,
  blocks: 20,
  blockTitle: 120,
  // steps
  steps: 30,
  stepLabel: 60,
  stepsNote: 300,
  // graph
  nodes: 60,
  nodeId: 60,
  nodeLabel: 40,
  nodeDetail: 60,
  nodeHint: 300,
  nodeModel: 40,
  nodeTokensMax: 1_000_000_000_000,
  gridMax: 11,
  edges: 120,
  edgeLabel: 40,
  // list
  items: 60,
  itemId: 100,
  itemLabel: 80,
  itemDetail: 200,
  itemStateLabel: 60,
  itemText: 2000,
  listEmpty: 200,
  // table
  columns: 8,
  columnLabel: 60,
  columnWidthMin: 0.5,
  columnWidthMax: 4,
  rows: 100,
  cell: 500,
  tableNote: 600,
  // log
  entries: 300,
  entryText: 500,
  detailLabel: 60,
  // text
  text: 2000
} as const

export type BoardTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'muted'
export type BoardStatus = 'live' | 'paused' | 'finished' | 'failed'
export type BoardStepState = 'done' | 'current' | 'skipped' | 'upcoming'
export type BoardNodeState = 'idle' | 'active' | 'blocked' | 'done' | 'placeholder'
export type BoardEdgeState = 'idle' | 'flowing' | 'returning'

export interface BoardStep { label: string; state: BoardStepState; at?: number }
export interface BoardStepsBlock { type: 'steps'; title?: string; steps: BoardStep[]; note?: string }

export interface BoardNode {
  id: string
  label: string
  detail?: string
  hint?: string
  state?: BoardNodeState
  col: number
  row: number
  /** The model the agent runs on, as the tool names it. */
  model?: string
  /** Tokens the agent spent so far; absent when the tool does not know (never read as 0). */
  tokens?: number
  /** When the agent started and, once it stopped, when it did (ms): the box shows the time working. */
  startedAt?: number
  endedAt?: number
}
export interface BoardEdge { from: string; to: string; label?: string; state?: BoardEdgeState }
export interface BoardGraphBlock { type: 'graph'; title?: string; nodes: BoardNode[]; edges?: BoardEdge[] }

export interface BoardListItemState { label: string; tone?: BoardTone; busy?: boolean }
export interface BoardListItem { id?: string; agent?: string; label: string; detail?: string; state?: BoardListItemState; text?: string; at?: number }
export interface BoardListBlock { type: 'list'; title?: string; items: BoardListItem[]; empty?: string }

export interface BoardColumn { label: string; width?: number }
export interface BoardRow { cells: string[]; tone?: BoardTone; struck?: boolean; agent?: string }
export interface BoardTableBlock { type: 'table'; title?: string; columns: BoardColumn[]; rows: BoardRow[]; note?: string }

export interface BoardLogEntry { at: number; text: string; tone?: BoardTone; detail?: boolean; agent?: string }
export interface BoardLogBlock { type: 'log'; title?: string; entries: BoardLogEntry[]; detailLabel?: string }

export interface BoardTextBlock { type: 'text'; title?: string; text: string; tone?: BoardTone }

export type BoardBlock = BoardStepsBlock | BoardGraphBlock | BoardListBlock | BoardTableBlock | BoardLogBlock | BoardTextBlock

export interface Board {
  format: typeof BOARD_FORMAT
  version: typeof BOARD_VERSION
  id: string
  title: string
  subtitle?: string
  status: BoardStatus
  heartbeatSeconds?: number
  blocks: BoardBlock[]
}

/**
 * A board as Workhub keeps it: when it last arrived, when its id first did, who sent it last, and the
 * chat it belongs to (the session's identity, which a restart or a resume keeps; absent on the demo
 * board and on boards stored before boards belonged to a chat).
 */
export interface StoredBoard { board: Board; receivedAt: number; firstReceivedAt: number; sessionId?: string; chat?: string }

/** `key` addresses the board (`boardKey`); `chat` is the chat it belongs to. */
export interface BoardSummary { key: string; id: string; chat?: string; title: string; status: BoardStatus; heartbeatSeconds?: number; receivedAt: number; firstReceivedAt: number }

/** One profile's boards (one `kv_state` row per profile). */
export interface BoardsState { version: 1; boards: StoredBoard[] }
