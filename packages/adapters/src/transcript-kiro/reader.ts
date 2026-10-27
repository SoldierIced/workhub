/**
 * TranscriptReader for Kiro (PLAN D9): finds the session by its id under `~/.kiro/sessions` and
 * reads only what was appended since the last read. ACP sessions live in `cli/<id>.json(l)`, chat
 * sessions in `<hash>/sess_<id>/`. Missing or unreadable files hide data, never throw.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mergeMonitor, type SessionMonitorSnapshot, type TranscriptQuery, type TranscriptReader } from '@workhub/core'
import { isDirectory, isFile, LineTail, safeId } from '../shared/reader-utils'
import {
  KiroChatParser,
  KiroCliParser,
  KiroSubExecutionParser,
  parseKiroCliMeta,
  parseKiroSessionJson,
  type KiroSessionInfo,
  type SubExecutionActivity
} from './parser'

/**
 * Kiro's data folder. `~/.kiro` on macOS and Linux (verified on macOS, Kiro 2.33.1); the same
 * folder under the user profile on Windows is expected but not verified.
 */
export function defaultKiroDir(): string {
  return join(homedir(), '.kiro')
}

export interface KiroTranscriptReaderOptions {
  kiroDir?: string
}

type Located = { kind: 'cli'; json: string; jsonl: string } | { kind: 'chat'; dir: string }

interface CliState {
  kind: 'cli'
  json: string
  tail: LineTail
  parser: KiroCliParser
  meta?: { key: string; value: ReturnType<typeof parseKiroCliMeta> }
}

interface ChatState {
  kind: 'chat'
  dir: string
  tail: LineTail
  parser: KiroChatParser
  info?: { key: string; value: KiroSessionInfo }
  subs: Map<string, { tail: LineTail; parser: KiroSubExecutionParser }>
}

/** A file's size and mtime, to skip re-parsing a metadata file that did not change. */
async function fileKey(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return null
  }
}

export async function locateKiroSession(sessionsDir: string, id: string): Promise<Located | null> {
  const safe = safeId(id)
  if (!safe) return null
  const json = join(sessionsDir, 'cli', `${safe}.json`)
  if (await isFile(json)) return { kind: 'cli', json, jsonl: join(sessionsDir, 'cli', `${safe}.jsonl`) }
  let folders: string[]
  try {
    folders = await readdir(sessionsDir)
  } catch {
    return null
  }
  for (const folder of folders) {
    if (folder === 'cli') continue
    for (const name of new Set([safe, `sess_${safe}`])) {
      const dir = join(sessionsDir, folder, name)
      if ((await isDirectory(dir)) && ((await isFile(join(dir, 'messages.jsonl'))) || (await isFile(join(dir, 'session.json'))))) return { kind: 'chat', dir }
    }
  }
  return null
}

export class KiroTranscriptReader implements TranscriptReader {
  readonly id = 'kiro'
  private readonly sessions = new Map<string, CliState | ChatState>()
  private readonly sessionsDir: string

  constructor(options: KiroTranscriptReaderOptions = {}) {
    this.sessionsDir = join(options.kiroDir ?? defaultKiroDir(), 'sessions')
  }

  async exists(query: TranscriptQuery): Promise<boolean> {
    return (await locateKiroSession(this.sessionsDir, query.agentSessionId)) !== null
  }

  forget(agentSessionId: string): void {
    this.sessions.delete(agentSessionId)
  }

  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    let state = this.sessions.get(query.agentSessionId)
    if (!state) {
      const found = await locateKiroSession(this.sessionsDir, query.agentSessionId)
      if (!found) return null
      const options = { ticketPrefixes: query.ticketPrefixes }
      state =
        found.kind === 'cli'
          ? { kind: 'cli', json: found.json, tail: new LineTail(found.jsonl), parser: new KiroCliParser(options) }
          : { kind: 'chat', dir: found.dir, tail: new LineTail(join(found.dir, 'messages.jsonl')), parser: new KiroChatParser(options), subs: new Map() }
      this.sessions.set(query.agentSessionId, state)
    }
    return state.kind === 'cli' ? this.readCli(state) : this.readChat(state)
  }

  private async readCli(state: CliState): Promise<SessionMonitorSnapshot> {
    const parser = state.parser
    await state.tail.read((line) => parser.ingest(line))
    const key = await fileKey(state.json)
    if (key && state.meta?.key !== key) {
      const text = await readFile(state.json, 'utf8').catch(() => '')
      state.meta = { key, value: parseKiroCliMeta(text) }
    }
    const { cwd: _cwd, updatedAt: _updatedAt, createdAt: _createdAt, ...meta } = state.meta?.value ?? {}
    return mergeMonitor(parser.snapshot(), meta)
  }

  private async readChat(state: ChatState): Promise<SessionMonitorSnapshot> {
    const parser = state.parser
    await state.tail.read((line) => parser.ingest(line))
    const infoPath = join(state.dir, 'session.json')
    const key = await fileKey(infoPath)
    if (key && state.info?.key !== key) {
      const text = await readFile(infoPath, 'utf8').catch(() => '')
      state.info = { key, value: parseKiroSessionJson(text) }
    }
    const activity = new Map<string, SubExecutionActivity>()
    for (const id of parser.subSessionIds()) {
      const safe = safeId(id)
      if (!safe) continue
      let sub = state.subs.get(safe)
      if (!sub) {
        sub = { tail: new LineTail(join(state.dir, 'sub-executions', `${safe}.jsonl`)), parser: new KiroSubExecutionParser() }
        state.subs.set(safe, sub)
      }
      const p = sub.parser
      if (await sub.tail.read((line) => p.ingest(line))) activity.set(id, p.activity())
    }
    return parser.snapshot(state.info?.value ?? {}, activity)
  }
}
