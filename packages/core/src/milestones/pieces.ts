/**
 * Pieces of a milestone: the tracker tickets, local tasks (Plan inbox items) and plain links it is
 * made of, each with a weight. Progress is the weight of the done pieces over the weight of all of
 * them. Pure: the main process reads the tickets' states and keeps them (`planner-state.json`).
 */
import type { InboxItem } from '../inbox/types'
import type { StatusCategory } from '../tickets/types'

export const PIECE_KINDS = ['ticket', 'task', 'link'] as const
export type PieceKind = (typeof PIECE_KINDS)[number]

/** Weights are whole numbers from 1 to 10; a piece added without one weighs 5. */
export const PIECE_WEIGHT = { min: 1, max: 10, default: 5 } as const
export const PIECE_LIMITS = { items: 100, id: 200, connectionId: 64, label: 200, url: 2000 } as const

/**
 * - ticket: a tracker issue by key, read from the profile's tracker (or `connectionId`);
 * - task: a Plan inbox item of the same profile, by id; only `done` counts as done;
 * - link: any web page, marked done by hand.
 */
export type MilestonePiece =
  | { kind: 'ticket'; key: string; connectionId?: string; weight: number }
  | { kind: 'task'; itemId: string; weight: number }
  | { kind: 'link'; url: string; label: string; done: boolean; weight: number }

const TICKET_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/

/** A Jira or Linear key as typed (`abc-12 ` → `ABC-12`); null when it is not one. */
export function parseTicketKey(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const key = text.trim().toUpperCase()
  return TICKET_KEY.test(key) ? key : null
}

/** What makes two pieces the same: the ticket (with its connection), the item, or the address. */
export function pieceId(p: MilestonePiece): string {
  return p.kind === 'ticket' ? `ticket:${p.connectionId ?? ''}|${p.key}` : p.kind === 'task' ? `task:${p.itemId}` : `link:${p.url}`
}

const isWebUrl = (url: string) => /^https?:\/\/\S+$/i.test(url) && url.length <= PIECE_LIMITS.url

/**
 * A list of pieces from untrusted input; a string says what is wrong. A missing weight is
 * `PIECE_WEIGHT.default`; a weight must be a whole number from 1 to 10. The same piece twice is refused.
 */
export function parsePieces(value: unknown): MilestonePiece[] | string {
  if (!Array.isArray(value)) return '"items" must be a list of pieces'
  if (value.length > PIECE_LIMITS.items) return `a milestone has at most ${PIECE_LIMITS.items} pieces`
  const out: MilestonePiece[] = []
  const seen = new Set<string>()
  for (const [i, raw] of value.entries()) {
    const at = `piece ${i + 1}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at}: every piece must be an object`
    const r = raw as Record<string, unknown>
    const weight = r['weight'] === undefined ? PIECE_WEIGHT.default : r['weight']
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < PIECE_WEIGHT.min || weight > PIECE_WEIGHT.max) return `${at}: "weight" must be a whole number from ${PIECE_WEIGHT.min} to ${PIECE_WEIGHT.max}`
    let piece: MilestonePiece
    if (r['kind'] === 'ticket') {
      const key = parseTicketKey(r['key'])
      if (!key) return `${at}: "key" must be a ticket key such as ABC-12`
      const conn = r['connectionId']
      if (conn !== undefined && conn !== null && (typeof conn !== 'string' || conn.trim().length > PIECE_LIMITS.connectionId)) return `${at}: "connectionId" must be a connection id`
      const connectionId = typeof conn === 'string' ? conn.trim() : ''
      piece = { kind: 'ticket', key, ...(connectionId ? { connectionId } : {}), weight }
    } else if (r['kind'] === 'task') {
      const itemId = typeof r['itemId'] === 'string' ? r['itemId'].trim() : ''
      if (!itemId || itemId.length > PIECE_LIMITS.id) return `${at}: "itemId" must be the id of an inbox item`
      piece = { kind: 'task', itemId, weight }
    } else if (r['kind'] === 'link') {
      const url = typeof r['url'] === 'string' ? r['url'].trim() : ''
      if (!isWebUrl(url)) return `${at}: "url" must be an http(s) address of at most ${PIECE_LIMITS.url} characters`
      if (r['label'] !== undefined && typeof r['label'] !== 'string') return `${at}: "label" must be a string`
      const label = typeof r['label'] === 'string' ? r['label'].replace(/\s+/g, ' ').trim() : ''
      if (label.length > PIECE_LIMITS.label) return `${at}: "label" is longer than ${PIECE_LIMITS.label} characters`
      if (r['done'] !== undefined && typeof r['done'] !== 'boolean') return `${at}: "done" must be true or false`
      piece = { kind: 'link', url, label: label || url, done: r['done'] === true, weight }
    } else return `${at}: "kind" must be ticket, task or link`
    const id = pieceId(piece)
    if (seen.has(id)) return `${at}: the same piece is in the list twice`
    seen.add(id)
    out.push(piece)
  }
  return out
}

/** A piece as text with its fields in a fixed order, to compare two pieces whatever order their fields came in. */
const canonical = (p: unknown) => (p && typeof p === 'object' ? JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))) : JSON.stringify(p))

/** Whether a stored list of pieces is well formed (what `parsePieces` would keep as it is). */
export function piecesOk(pieces: unknown): boolean {
  const parsed = parsePieces(pieces)
  return typeof parsed !== 'string' && Array.isArray(pieces) && parsed.every((p, i) => canonical(p) === canonical(pieces[i]))
}

/** Each piece's share of the milestone, 0 to 100 (rounded): its weight over the sum of all weights. */
export function pieceShares(pieces: readonly Pick<MilestonePiece, 'weight'>[]): number[] {
  const total = pieces.reduce((s, p) => s + p.weight, 0)
  return pieces.map((p) => (total > 0 ? Math.round((p.weight / total) * 100) : 0))
}

/** What the tracker last said about a ticket, and when (`planner-state.json`, by `ticketStateKey`). */
export interface TrackedTicket {
  key: string
  title?: string
  /** The tracker's own status name, e.g. `In Review`. */
  status?: string
  category?: StatusCategory
  url?: string
  /** Epoch ms of the last read (good or not). */
  checkedAt: number
  /** The tracker answered and does not know the key. */
  missing?: true
  /** The tracker cannot read tickets by key: the state stays unknown. */
  unsupported?: true
  /** The last read failed; the other fields are those of the last good one. */
  error?: string
}

/** Where a ticket's state is kept: its connection (empty for the profile's tracker) and its key. */
export const ticketStateKey = (connectionId: string | undefined, key: string): string => `${connectionId ?? ''}|${key}`

/** Where a piece stands. A ticket the tracker could not (or cannot) read is `unknown` and never counts as done. */
export type PieceState = 'todo' | 'inProgress' | 'done' | 'unknown'

/** A ticket's state as a piece's: its category once read, else unknown. */
export function trackedState(t: TrackedTicket | undefined): PieceState {
  return t && !t.missing && !t.unsupported && t.category ? t.category : 'unknown'
}

/** A piece with what is known of it now. */
export interface PieceView {
  piece: MilestonePiece
  state: PieceState
  /** The ticket's or item's title, or the link's label; the key or id when not known. */
  title: string
  /** A ticket's status name in its tracker; a task's inbox status. */
  status?: string
  url?: string
  /** 0 to 100: the piece's weight over the sum of all weights. */
  share: number
  /** When the ticket was last read. */
  checkedAt?: number
  /** Why the last read failed, or that the ticket is unknown to the tracker. */
  error?: string
  /** A task whose inbox item no longer exists. */
  missing?: true
}

export interface PieceSources {
  ticket: (connectionId: string | undefined, key: string) => TrackedTicket | undefined
  task: (itemId: string) => Pick<InboxItem, 'title' | 'status'> | undefined
}

/** The pieces with their state, title and share. */
export function pieceViews(pieces: readonly MilestonePiece[], sources: PieceSources): PieceView[] {
  const shares = pieceShares(pieces)
  return pieces.map((piece, i) => {
    const share = shares[i] ?? 0
    if (piece.kind === 'link') return { piece, state: piece.done ? 'done' : 'todo', title: piece.label, url: piece.url, share }
    if (piece.kind === 'task') {
      const item = sources.task(piece.itemId)
      if (!item) return { piece, state: 'unknown', title: piece.itemId, share, missing: true }
      return { piece, state: item.status === 'done' ? 'done' : 'todo', title: item.title, status: item.status, share }
    }
    const t = sources.ticket(piece.connectionId, piece.key)
    return {
      piece,
      state: trackedState(t),
      title: t?.title || piece.key,
      ...(t?.status ? { status: t.status } : {}),
      ...(t?.url ? { url: t.url } : {}),
      share,
      ...(t ? { checkedAt: t.checkedAt } : {}),
      ...(t?.error ? { error: t.error } : t?.missing ? { error: 'missing' } : t?.unsupported ? { error: 'unsupported' } : {})
    }
  })
}

/** Weights of all the pieces and of the done ones, and how many pieces there are of each. */
export interface PieceTally {
  /** Sum of all weights (0 for an empty list). */
  total: number
  /** Sum of the weights of the done pieces. */
  done: number
  count: number
  doneCount: number
}

export function pieceTally(views: readonly Pick<PieceView, 'piece' | 'state'>[]): PieceTally {
  const tally: PieceTally = { total: 0, done: 0, count: views.length, doneCount: 0 }
  for (const v of views) {
    tally.total += v.piece.weight
    if (v.state === 'done') {
      tally.done += v.piece.weight
      tally.doneCount += 1
    }
  }
  return tally
}
