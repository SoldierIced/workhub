/**
 * Session history of Codex: the newest rollout files under `<codex home>/sessions`, each read only
 * as far as its first prompt. Listing only; Codex sessions cannot be resumed from Workhub yet.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry, HistoryMessage, SessionHistorySource } from '@workhub/core'
import { obj, oneLine, parseLine, str } from '../shared/reader-utils'
import { defaultCodexHome, readRolloutHead, rolloutFiles, rolloutId } from './files'
import { readSessionMeta, userItemText, userMessageText } from './parser'

export interface CodexHistoryOptions {
  /** The Codex home of an account without one. */
  defaultHome?: string
  /** Most sessions listed (newest first). */
  limit?: number
}

/** A rollout's first line is its `session_meta`, which carries the instructions: allow for it. */
const HEAD_BYTES = 256 * 1024

export class CodexSessionHistory implements SessionHistorySource {
  constructor(private readonly options: CodexHistoryOptions = {}) {}

  async list(account: { agentId: string; accountId: string | null; configDir?: string }): Promise<HistoryEntry[]> {
    const sessionsDir = join(account.configDir || this.options.defaultHome || defaultCodexHome(), 'sessions')
    const limit = this.options.limit ?? 400
    const entries: HistoryEntry[] = []
    for await (const path of rolloutFiles(sessionsDir)) {
      const entry = await this.entry(path, account)
      if (entry) entries.push(entry)
      if (entries.length >= limit) break
    }
    return entries.sort((a, b) => b.lastModified - a.lastModified)
  }

  /** Not supported: Codex sessions are listed only. */
  async messages(): Promise<HistoryMessage[]> {
    return []
  }

  private async entry(path: string, account: { agentId: string; accountId: string | null }): Promise<HistoryEntry | null> {
    const head = await readRolloutHead(path, HEAD_BYTES)
    let meta = readSessionMeta(undefined)
    let prompt: string | undefined
    // Newer rollouts write the prompt as an `item_completed` UserMessage; the user `message`
    // response item is the last resort.
    let fallback: string | undefined
    for (const line of head.split('\n')) {
      const entry = parseLine(line)
      const payload = obj(entry?.['payload'])
      if (!entry || !payload) continue
      if (entry['type'] === 'session_meta') meta = readSessionMeta(payload)
      else if (entry['type'] === 'event_msg' && payload['type'] === 'user_message') prompt = str(payload['message'])
      else if (entry['type'] === 'event_msg' && payload['type'] === 'item_completed') prompt = userItemText(obj(payload['item']))
      else if (entry['type'] === 'response_item') fallback ??= userMessageText(payload)
      if (prompt) break
    }
    prompt ??= fallback
    // A subagent's rollout belongs to its parent session.
    if (meta.subagent) return null
    const id = meta.id ?? rolloutId(path.split(/[\\/]/).pop() ?? '')
    if (!id) return null
    const modified = await stat(path).then((s) => s.mtimeMs, () => null)
    if (modified === null) return null
    const entry: HistoryEntry = { agentId: account.agentId, accountId: account.accountId, agentSessionId: id, title: prompt ? oneLine(prompt) : id, lastModified: modified }
    if (prompt) entry.firstPrompt = prompt
    if (meta.cwd) entry.cwd = meta.cwd
    if (meta.branch) entry.gitBranch = meta.branch
    if (meta.createdAt !== undefined) entry.createdAt = meta.createdAt
    return entry
  }
}
