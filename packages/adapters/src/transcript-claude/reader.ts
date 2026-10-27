/**
 * TranscriptReader for Claude Code (PLAN D9): finds `<config>/projects/<folder>/<session>.jsonl`
 * of the session's account and reads only what was appended since the last read, together with
 * the session's subagent transcripts. Missing or unreadable files hide data, never throw.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mergeMonitor, type Money, type SessionMonitorSnapshot, type SubagentSummary, type TranscriptQuery, type TranscriptReader } from '@workhub/core'
import {
  ClaudeTranscriptParser,
  parseSubagentMeta,
  SubagentParser,
  subagentStatus,
  subagentSummary,
  sumTokens,
  type SubagentMeta
} from './parser'

/** Appends whole lines to a parser; an unfinished last line waits for the next read. */
class Tail {
  private offset = 0
  private partial = ''
  constructor(readonly path: string) {}

  async read(onLine: (line: string) => void): Promise<boolean> {
    let handle
    try {
      handle = await open(this.path, 'r')
    } catch {
      return false
    }
    try {
      const { size } = await handle.stat()
      // A file that shrank was rewritten: start over is not possible without the parser, so skip.
      if (size < this.offset) return true
      const length = size - this.offset
      if (length > 0) {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.offset)
        this.offset = size
        const lines = (this.partial + buffer.toString('utf8')).split('\n')
        this.partial = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line)
      }
      return true
    } finally {
      await handle.close()
    }
  }
}

interface SubagentState {
  tail: Tail
  parser: SubagentParser
  meta: SubagentMeta
  modified: number
}

interface SessionState {
  tail: Tail
  parser: ClaudeTranscriptParser
  subagents: Map<string, SubagentState>
}

export interface ClaudeTranscriptReaderOptions {
  /** The config folder of an account without one: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  defaultConfigDir?: string
  now?: () => number
}

/** A session id becomes a file name: only the characters Claude Code uses in its ids. */
function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

export function defaultClaudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

export class ClaudeTranscriptReader implements TranscriptReader {
  readonly id = 'claude'
  private readonly sessions = new Map<string, SessionState>()
  private readonly now: () => number

  constructor(private readonly options: ClaudeTranscriptReaderOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async exists(query: TranscriptQuery): Promise<boolean> {
    return (await this.locate(query)) !== null
  }

  forget(agentSessionId: string): void {
    this.sessions.delete(agentSessionId)
  }

  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    let state = this.sessions.get(query.agentSessionId)
    if (!state) {
      const path = await this.locate(query)
      if (!path) return null
      state = { tail: new Tail(path), parser: new ClaudeTranscriptParser({ ticketPrefixes: query.ticketPrefixes, now: this.now }), subagents: new Map() }
      this.sessions.set(query.agentSessionId, state)
    }
    const parser = state.parser
    if (!(await state.tail.read((line) => parser.ingest(line)))) return null
    const snap = parser.snapshot()
    const subagents = await this.readSubagents(state, snap.model)
    if (!subagents.length) return snap
    // Whole-session totals: the main conversation plus every subagent, each at its own model's prices.
    const tokens = sumTokens([snap.tokens ?? {}, ...subagents.map((s) => s.tokens ?? {})])
    const costs = [snap.cost, ...subagents.map((s) => s.cost)].filter((c): c is Money => !!c)
    const patch: SessionMonitorSnapshot = { subagents, tokens }
    if (costs.length) patch.cost = { amount: costs.reduce((sum, c) => sum + c.amount, 0), currency: 'USD' }
    return mergeMonitor(snap, patch)
  }

  /** The transcript path: `<config>/projects/*\/<id>.jsonl`, the cwd-derived folder tried first. */
  private async locate(query: TranscriptQuery): Promise<string | null> {
    const id = safeId(query.agentSessionId)
    if (!id) return null
    const projects = join(query.configDir || this.options.defaultConfigDir || defaultClaudeConfigDir(), 'projects')
    const name = `${id}.jsonl`
    // Claude Code names the folder after the cwd with every non-alphanumeric character as "-".
    const guess = join(projects, query.cwd.replace(/[^A-Za-z0-9]/g, '-'), name)
    if (await isFile(guess)) return guess
    let folders: string[]
    try {
      folders = await readdir(projects)
    } catch {
      return null
    }
    for (const folder of folders) {
      const candidate = join(projects, folder, name)
      if (await isFile(candidate)) return candidate
    }
    return null
  }

  private async readSubagents(state: SessionState, mainModel: string | undefined): Promise<SubagentSummary[]> {
    const dir = join(state.tail.path.replace(/\.jsonl$/, ''), 'subagents')
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const parents = state.parser.parentCalls()
    const out: SubagentSummary[] = []
    for (const file of files.sort()) {
      const path = join(dir, file)
      let sub = state.subagents.get(file)
      if (!sub) {
        const meta = await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8').then(parseSubagentMeta, () => ({}))
        sub = { tail: new Tail(path), parser: new SubagentParser(this.now), meta, modified: 0 }
        state.subagents.set(file, sub)
      }
      const parser = sub.parser
      await sub.tail.read((line) => parser.ingest(line))
      sub.modified = await stat(path).then((s) => s.mtimeMs, () => sub.modified)
      const parent = sub.meta.toolUseId ? parents.get(sub.meta.toolUseId) : undefined
      const status = subagentStatus(parser.isTerminal, this.now() - Math.max(sub.modified, parser.lastActivityAt ?? 0), parent)
      out.push(subagentSummary(basename(file, '.jsonl').replace(/^agent-/, ''), sub.meta, parser, status, mainModel))
    }
    return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
