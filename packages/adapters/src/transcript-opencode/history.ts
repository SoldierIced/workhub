/**
 * Session history of OpenCode: the top-level, non-archived sessions of `opencode.db` (child
 * sessions are subagents of their parent). Listing only; OpenCode sessions cannot be resumed
 * from Workhub yet.
 */
import type { HistoryEntry, HistoryMessage, SessionHistorySource } from '@workhub/core'
import { num, oneLine, str } from '../shared/reader-utils'
import { defaultOpenCodeDbPath, withDatabase } from './db'

export interface OpenCodeHistoryOptions {
  dbPath?: string
  /** Most sessions listed (newest first). */
  limit?: number
}

export class OpenCodeSessionHistory implements SessionHistorySource {
  constructor(private readonly options: OpenCodeHistoryOptions = {}) {}

  async list(account: { agentId: string; accountId: string | null }): Promise<HistoryEntry[]> {
    const rows = await withDatabase(this.options.dbPath ?? defaultOpenCodeDbPath(), (q) =>
      q(
        `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
                (SELECT json_extract(m.data, '$.text') FROM session_message m
                  WHERE m.session_id = s.id AND m.type = 'user' ORDER BY m.seq LIMIT 1) AS first_prompt
           FROM session_v2 s
          WHERE s.parent_id IS NULL AND s.time_archived IS NULL
          ORDER BY s.time_updated DESC LIMIT ?`,
        this.options.limit ?? 400
      )
    )
    return (rows ?? []).flatMap((r): HistoryEntry[] => {
      const id = str(r['id'])
      if (!id) return []
      const prompt = str(r['first_prompt'])
      const entry: HistoryEntry = {
        agentId: account.agentId,
        accountId: account.accountId,
        agentSessionId: id,
        title: str(r['title']) ?? (prompt ? oneLine(prompt) : id),
        lastModified: num(r['time_updated']) ?? 0
      }
      if (prompt) entry.firstPrompt = prompt
      const cwd = str(r['directory'])
      if (cwd) entry.cwd = cwd
      const created = num(r['time_created'])
      if (created !== undefined) entry.createdAt = created
      return [entry]
    })
  }

  /** Not supported: OpenCode sessions are listed only. */
  async messages(): Promise<HistoryMessage[]> {
    return []
  }
}
