import type { BoardBlock, BoardLogEntry, BoardSummary, BoardTone, BoardColumn } from '@workhub/core'
import type { Tone } from '../components/atoms/Badge'

/**
 * Which board a chat's panel shows (decision 16): the one the person picked while it still exists,
 * else the newest (the first of the list, which arrives newest first).
 */
export function selectedBoardId(boards: readonly Pick<BoardSummary, 'key'>[], picked: string | null): string | null {
  if (picked !== null && boards.some((b) => b.key === picked)) return picked
  return boards[0]?.key ?? null
}

const sameDay = (a: number, b: number): boolean => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** How a time reads: just the hour today, with its date on another day. */
export function boardTimeOptions(at: number, now: number): Intl.DateTimeFormatOptions {
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  return sameDay(at, now) ? time : { day: 'numeric', month: 'short', ...time }
}

/** The tone of a status badge, by what the screen shows (`boardLiveness`). */
export const LIVENESS_TONE: Record<'live' | 'silent' | 'paused' | 'finished' | 'failed', Tone> = {
  live: 'info',
  silent: 'warning',
  paused: 'neutral',
  finished: 'success',
  failed: 'danger'
}

/** A board tone as the app's own semantic colours: text, dot, and the tint of a row. */
export const TONE_TEXT: Record<BoardTone, string> = {
  neutral: 'text-text',
  info: 'text-info',
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-muted'
}
export const TONE_DOT: Record<BoardTone, Tone> = { neutral: 'neutral', info: 'info', good: 'success', warn: 'warning', bad: 'danger', muted: 'neutral' }
export const TONE_ROW: Record<BoardTone, string> = {
  neutral: '',
  info: 'bg-info-soft',
  good: 'bg-success-soft',
  warn: 'bg-warning-soft',
  bad: 'bg-danger-soft',
  muted: ''
}

export interface LogRow {
  /** Stable across updates: the same entry keeps its key when others arrive, so the view can hold its place. */
  key: string
  entry: BoardLogEntry
}

/** The log as drawn: newest first (a tie keeps the order sent), detail entries only when asked, and only what contains the search. */
export function logRows(entries: readonly BoardLogEntry[], query: string, showDetail: boolean): LogRow[] {
  const needle = query.trim().toLocaleLowerCase()
  const seen = new Map<string, number>()
  const keyed = entries.map((entry, index) => {
    const base = `${entry.at}|${entry.text}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { key: n ? `${base}|${n}` : base, entry, index }
  })
  return keyed
    .filter(({ entry }) => (showDetail || !entry.detail) && (!needle || entry.text.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => b.entry.at - a.entry.at || a.index - b.index)
    .map(({ key, entry }) => ({ key, entry }))
}

/** Whether the log has a detail entry, which is what makes the checkbox appear. */
export const hasDetailEntries = (entries: readonly BoardLogEntry[]): boolean => entries.some((e) => e.detail === true)

/** Column widths as percentages of the table, from the proportions the tool sent (1 when absent). */
export function columnPercents(columns: readonly BoardColumn[]): number[] {
  const weights = columns.map((c) => c.width ?? 1)
  const total = weights.reduce((a, b) => a + b, 0) || 1
  return weights.map((w) => Math.round((w / total) * 10000) / 100)
}

/** What the person chose to remove: kept with its title, so the question stays about that board whatever is shown behind it. */
export interface RemoveTarget {
  /** The board's key (`BoardSummary.key`). */
  key: string
  title: string
}

/** The removal to keep asking about: it is dropped when its board is no longer in the list. */
export function keptRemoval(boards: readonly Pick<BoardSummary, 'key'>[], target: RemoveTarget | null): RemoveTarget | null {
  return target !== null && boards.some((b) => b.key === target.key) ? target : null
}

/**
 * Removes one board and says what went wrong, or null when it is gone (also when it was already gone:
 * the panel re-reads the list either way). The failure is said to the person, never swallowed.
 */
export async function removeBoard(remove: (profileId: string, key: string) => Promise<boolean>, profileId: string, key: string, failed: (message: string) => string): Promise<string | null> {
  try {
    await remove(profileId, key)
    return null
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e))
  }
}

/** A string the tool sent, or undefined when it is absent or empty: an empty string is treated as not sent. */
export const given = (s: string | undefined): string | undefined => (s ? s : undefined)

/**
 * For each block, its number among the blocks of its kind that have no title, or undefined when it has a
 * title or is the only untitled one of its kind. Controls of untitled blocks take this number in their
 * accessible name, so two of them are not announced the same.
 */
export function untitledNumbers(blocks: readonly BoardBlock[]): (number | undefined)[] {
  const total = new Map<string, number>()
  for (const b of blocks) if (!b.title) total.set(b.type, (total.get(b.type) ?? 0) + 1)
  const seen = new Map<string, number>()
  return blocks.map((b) => {
    if (b.title) return undefined
    const n = (seen.get(b.type) ?? 0) + 1
    seen.set(b.type, n)
    return (total.get(b.type) ?? 0) > 1 ? n : undefined
  })
}

/** The React key of a list item: its id when it has one, else its position; the two can never be equal ("id:1" is not "at:1"). */
export const itemKey = (item: { id?: string }, index: number): string => (item.id !== undefined ? `id:${item.id}` : `at:${index}`)

/** A block's identity (its moved boxes are kept under it): its kind and title, numbered when several share them ("list:", "list:#2"). */
export function blockIdentities(blocks: readonly Pick<BoardBlock, 'type' | 'title'>[]): string[] {
  const seen = new Map<string, number>()
  return blocks.map((b) => {
    const base = `${b.type}:${b.title ?? ''}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base}#${n}` : base
  })
}

/** The agent the person picked on the graph: its node id and the name it shows. */
export interface PickedAgent {
  id: string
  label: string
}

/** How a block was filtered: by the `agent` its tool set, by item id, by mention of the name, or not at all (a kind that is not filtered). */
export type AgentMatch = 'agent' | 'mention' | 'none'

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A matcher of the agent's name or id as a whole word: "agent3" is not part of "agent30", "api" not of "rapid". */
function mentionOf(agent: PickedAgent): (text: string | undefined) => boolean {
  const needles = [...new Set([agent.label, agent.id].map((s) => s.trim()).filter((s) => s.length >= 2))]
  if (needles.length === 0) return () => false
  // The name stands alone: on neither side a word character, nor ".", ":", "-" or "/" joining it to one
  // ("agent3:" and "(api)" match; "acme-web", "web-ui", "api.v2" and "web/settings" do not).
  const re = new RegExp(`(?<![\\p{L}\\p{N}_]|[\\p{L}\\p{N}_][.:/-])(?:${needles.map(escape).join('|')})(?![\\p{L}\\p{N}_]|[.:/-][\\p{L}\\p{N}_])`, 'iu')
  return (text) => text !== undefined && re.test(text)
}
const mentions = (texts: readonly (string | undefined)[], agent: PickedAgent): boolean => {
  const test = mentionOf(agent)
  return texts.some(test)
}

/**
 * A block with only what belongs to the picked agent. When any entry of the block names its `agent`
 * (or, in a list, an item id is a node id of the graph) that is trusted alone; otherwise an entry
 * belongs to the agent when its text mentions the agent's name or id, and the block says so.
 */
export function filterBlockByAgent(block: BoardBlock, agent: PickedAgent, nodeIds: ReadonlySet<string>): { block: BoardBlock; match: AgentMatch } {
  switch (block.type) {
    case 'list': {
      const linked = block.items.some((i) => i.agent !== undefined || (i.id !== undefined && nodeIds.has(i.id)))
      const items = linked ? block.items.filter((i) => (i.agent ?? i.id) === agent.id) : block.items.filter((i) => mentions([i.label, i.detail, i.text, i.state?.label], agent))
      return { block: { ...block, items }, match: linked ? 'agent' : 'mention' }
    }
    case 'table': {
      const linked = block.rows.some((r) => r.agent !== undefined)
      const rows = linked ? block.rows.filter((r) => r.agent === agent.id) : block.rows.filter((r) => mentions(r.cells, agent))
      return { block: { ...block, rows }, match: linked ? 'agent' : 'mention' }
    }
    case 'log': {
      const linked = block.entries.some((e) => e.agent !== undefined)
      const entries = linked ? block.entries.filter((e) => e.agent === agent.id) : block.entries.filter((e) => mentions([e.text], agent))
      return { block: { ...block, entries }, match: linked ? 'agent' : 'mention' }
    }
    default:
      return { block, match: 'none' }
  }
}

/**
 * How long an agent has worked (ms): until it stopped; else until now while the board is live, or until
 * the board last arrived when it is not (a finished or silent board does not keep counting). Undefined
 * when its start is unknown.
 */
export function workingMs(node: { startedAt?: number; endedAt?: number }, until: number): number | undefined {
  if (node.startedAt === undefined) return undefined
  return Math.max(0, (node.endedAt ?? until) - node.startedAt)
}

/** A working time, short: 45s, 4m, 2h 05m (no seconds past a minute: the screen's clock ticks every few seconds). */
export function formatWorking(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

type SavedLayouts = ReadonlyArray<{ key: string; boxes: Record<string, { x: number; y: number }> }>

/** The key under which a graph's moved boxes are kept: the profile, the board (its chat and id) and the block's identity (`blockIdentities`). */
export const boardLayoutKey = (profileId: string, boardKey: string, blockIdentity: string): string => `${profileId}|${boardKey}|${blockIdentity}`

/** The boxes the person moved on one graph; none when it was never touched. */
export const layoutOf = (saved: SavedLayouts, key: string): Record<string, { x: number; y: number }> => saved.find((l) => l.key === key)?.boxes ?? {}

/** The saved layouts with this graph's boxes replaced (it becomes the newest), or forgotten when `boxes` is null; the oldest go past `max`. */
export function withLayout(saved: SavedLayouts, key: string, boxes: Record<string, { x: number; y: number }> | null, max: number): SavedLayouts {
  const rest = saved.filter((l) => l.key !== key)
  return (boxes && Object.keys(boxes).length > 0 ? [...rest, { key, boxes }] : rest).slice(-max)
}
