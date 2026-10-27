/**
 * What OpenCode sessions cost, per assistant message, from its database (read-only). OpenCode
 * records each message's cost as the provider bills it by API key; a subscription or a local model
 * records 0, so only messages with a positive cost are returned. Checked on a real `opencode.db`
 * (2026-10-27): `session_message` rows of `type` `assistant`, `data` JSON with `cost` (USD),
 * `tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and `time.completed`.
 */
import { num, obj } from '../shared/reader-utils'
import { defaultOpenCodeDbPath, withDatabase } from './db'

export interface OpenCodeCostEntry {
  /** When the message ended (epoch ms). */
  at: number
  usd: number
  /** Fresh tokens: input, cache writes, output and reasoning. */
  tokens: number
}

/** The cost of one `session_message.data`; null when it has none. */
export function openCodeMessageCost(data: string, createdAt: number | undefined): OpenCodeCostEntry | null {
  let d: Record<string, unknown> | undefined
  try {
    d = obj(JSON.parse(data))
  } catch {
    return null
  }
  const usd = num(d?.['cost'])
  if (!d || usd === undefined || !(usd > 0)) return null
  const at = num(obj(d['time'])?.['completed']) ?? num(obj(d['time'])?.['created']) ?? createdAt
  if (at === undefined) return null
  const t = obj(d['tokens'])
  const tokens = (num(t?.['input']) ?? 0) + (num(t?.['output']) ?? 0) + (num(t?.['reasoning']) ?? 0) + (num(obj(t?.['cache'])?.['write']) ?? 0)
  return { at, usd, tokens }
}

/** Assistant messages with a cost, created at or after `since`. Empty when there is no database. */
export async function readOpenCodeCosts(options: { since: number; dbPath?: string }): Promise<OpenCodeCostEntry[]> {
  const rows = await withDatabase(options.dbPath ?? defaultOpenCodeDbPath(), (q) =>
    q("SELECT time_created, data FROM session_message WHERE type = 'assistant' AND time_created >= ? AND data LIKE '%\"cost\"%'", options.since)
  )
  return (rows ?? []).flatMap((r) => {
    const e = typeof r['data'] === 'string' ? openCodeMessageCost(r['data'], num(r['time_created'])) : null
    return e ? [e] : []
  })
}
