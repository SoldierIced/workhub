import type { HistoryMessage } from '@workhub/core'
import type { RemoteHistoryPage } from '../../shared/remote-api'

/** One page of a session's conversation stays well under the relay's frame once sealed. */
export const HISTORY_PAGE_BYTES = 160 * 1024
/** And holds at most this many messages, so the phone renders a page at once. */
export const HISTORY_PAGE_MAX = 150
/** A single message larger than this loses its bulk (tool output and diffs, then long text). */
const ONE_MAX_BYTES = 24 * 1024
const TEXT_MAX_CHARS = 12_000

export type HistoryPage = RemoteHistoryPage

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const cut = (text: string): string => (text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text)

/** A message as the phone needs it: no image bytes, and nothing so large it crowds out the rest of the page. */
export function slimMessage(m: HistoryMessage): HistoryMessage {
  if (m.kind === 'user') {
    const { imageData: _images, ...rest } = m
    return { ...rest, text: cut(m.text) }
  }
  if (sizeOf(m) <= ONE_MAX_BYTES) return m
  switch (m.kind) {
    case 'agent':
      return { ...m, text: cut(m.text) }
    case 'notice':
      return { ...m, text: cut(m.text) }
    case 'compaction':
      return m.summary === undefined ? m : { ...m, summary: cut(m.summary) }
    case 'tool': {
      const { result: _result, view, ...rest } = m
      const lean = { ...rest, ...(m.detail ? { detail: cut(m.detail) } : {}) }
      return view && sizeOf({ ...lean, view }) <= ONE_MAX_BYTES ? { ...lean, view } : lean
    }
    default:
      return m
  }
}

/**
 * The newest messages before `before` (the whole conversation when omitted) that fit one page.
 * The phone asks for the last page when it opens a chat and for the one before `start` as the
 * person scrolls up. Indexes count from the conversation's first message, which only grows.
 */
export function pageHistory(all: readonly HistoryMessage[], before?: number): HistoryPage {
  const end = before === undefined ? all.length : Math.max(0, Math.min(all.length, Math.floor(before)))
  const page: HistoryMessage[] = []
  let bytes = 0
  let start = end
  while (start > 0 && page.length < HISTORY_PAGE_MAX) {
    const m = slimMessage(all[start - 1]!)
    const size = sizeOf(m)
    if (page.length > 0 && bytes + size > HISTORY_PAGE_BYTES) break
    page.push(m)
    bytes += size
    start--
  }
  return { messages: page.reverse(), start, total: all.length }
}
