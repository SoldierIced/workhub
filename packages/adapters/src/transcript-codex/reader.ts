/**
 * TranscriptReader for Codex (PLAN D9): finds the session's rollout file under
 * `<codex home>/sessions/YYYY/MM/DD/` and reads only what was appended since the last read.
 * A compressed rollout (`.jsonl.zst`) is read whole when it changes. Missing or unreadable files
 * hide data, never throw.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionMonitorSnapshot, TranscriptQuery, TranscriptReader } from '@workhub/core'
import { LineTail } from '../shared/reader-utils'
import { defaultCodexHome, findRollout, isCompressed, readRollout } from './files'
import { CodexRolloutParser } from './parser'

export interface CodexTranscriptReaderOptions {
  /** The Codex home of an account without one: `CODEX_HOME`, else `~/.codex`. */
  defaultHome?: string
}

interface SessionState {
  path: string
  parser: CodexRolloutParser
  tail?: LineTail
  /** Size and mtime of a compressed rollout at the last read. */
  key?: string
}

export class CodexTranscriptReader implements TranscriptReader {
  readonly id = 'codex'
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly options: CodexTranscriptReaderOptions = {}) {}

  private sessionsDir(query: TranscriptQuery): string {
    return join(query.configDir || this.options.defaultHome || defaultCodexHome(), 'sessions')
  }

  async exists(query: TranscriptQuery): Promise<boolean> {
    return (await findRollout(this.sessionsDir(query), query.agentSessionId)) !== null
  }

  forget(agentSessionId: string): void {
    this.sessions.delete(agentSessionId)
  }

  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    let state = this.sessions.get(query.agentSessionId)
    if (!state) {
      const path = await findRollout(this.sessionsDir(query), query.agentSessionId)
      if (!path) return null
      state = { path, parser: new CodexRolloutParser({ ticketPrefixes: query.ticketPrefixes }) }
      if (!isCompressed(path)) state.tail = new LineTail(path)
      this.sessions.set(query.agentSessionId, state)
    }
    if (state.tail) {
      const parser = state.parser
      if (!(await state.tail.read((line) => parser.ingest(line)))) return null
    } else {
      const s = await stat(state.path).catch(() => null)
      if (!s) return null
      const key = `${s.size}:${s.mtimeMs}`
      if (key !== state.key) {
        state.key = key
        state.parser = new CodexRolloutParser({ ticketPrefixes: query.ticketPrefixes })
        for (const line of (await readRollout(state.path)).split('\n')) if (line.trim()) state.parser.ingest(line)
      }
    }
    return state.parser.snapshot()
  }
}
