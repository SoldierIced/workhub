/**
 * TranscriptReader for OpenCode (PLAN D9): reads the session from OpenCode's SQLite database,
 * opened read-only for each poll, and only the messages added since the last one (plus the ones
 * that were still running). A missing, locked or unreadable database hides data, never throws.
 */
import type { SessionMonitorSnapshot, TranscriptQuery, TranscriptReader } from '@workhub/core'
import { safeId } from '../shared/reader-utils'
import { defaultOpenCodeDbPath, withDatabase } from './db'
import { OpenCodeMessages } from './parser'

export interface OpenCodeTranscriptReaderOptions {
  /** Path of `opencode.db`; the OpenCode default when unset. */
  dbPath?: string
  now?: () => number
}

interface SessionState {
  messages: OpenCodeMessages
  /** Highest `seq` read so far. */
  afterSeq: number
  /** Messages read while they were still running; read again. */
  open: Set<number>
}

export class OpenCodeTranscriptReader implements TranscriptReader {
  readonly id = 'opencode'
  private readonly sessions = new Map<string, SessionState>()
  private readonly now: () => number

  constructor(private readonly options: OpenCodeTranscriptReaderOptions = {}) {
    this.now = options.now ?? Date.now
  }

  private get dbPath(): string {
    return this.options.dbPath ?? defaultOpenCodeDbPath()
  }

  async exists(query: TranscriptQuery): Promise<boolean> {
    const id = safeId(query.agentSessionId)
    if (!id) return false
    return (await withDatabase(this.dbPath, (q) => q('SELECT 1 AS found FROM session_v2 WHERE id = ?', id).length > 0)) ?? false
  }

  forget(agentSessionId: string): void {
    this.sessions.delete(agentSessionId)
  }

  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    const id = safeId(query.agentSessionId)
    if (!id) return null
    let state = this.sessions.get(id)
    if (!state) {
      state = { messages: new OpenCodeMessages(query.ticketPrefixes), afterSeq: 0, open: new Set() }
      this.sessions.set(id, state)
    }
    const s = state
    return withDatabase(this.dbPath, (q) => {
      const row = q('SELECT * FROM session_v2 WHERE id = ?', id)[0]
      if (!row) return null
      const reopen = [...s.open]
      const marks = reopen.map(() => '?').join(', ')
      const fresh = q(
        `SELECT seq, type, data FROM session_message WHERE session_id = ? AND (seq > ?${reopen.length ? ` OR seq IN (${marks})` : ''}) ORDER BY seq`,
        id,
        s.afterSeq,
        ...reopen
      )
      for (const m of fresh) {
        const seq = Number(m['seq'])
        if (!Number.isFinite(seq)) continue
        const running = s.messages.ingest(seq, String(m['type']), String(m['data']))
        if (running) s.open.add(seq)
        else s.open.delete(seq)
        s.afterSeq = Math.max(s.afterSeq, seq)
      }
      const children = q('SELECT * FROM session_v2 WHERE parent_id = ? ORDER BY time_created', id)
      return s.messages.snapshot(row, children, this.now())
    })
  }
}
