/**
 * Session history of Kiro: lists the ACP sessions (`cli/<id>.json`) and the chat sessions
 * (`<hash>/sess_<id>/session.json`) found under `~/.kiro/sessions`. Listing only; Kiro sessions
 * cannot be resumed from Workhub yet.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry, HistoryMessage, SessionHistorySource } from '@workhub/core'
import { arr, isDirectory, isFile, obj, oneLine, parseLine, str } from '../shared/reader-utils'
import { parseKiroCliMeta, parseKiroSessionJson } from './parser'
import { defaultKiroDir } from './reader'

export interface KiroHistoryOptions {
  kiroDir?: string
  /** Most sessions listed (newest first). */
  limit?: number
}

/** The first user prompt of an ACP session, from the head of its jsonl. */
async function firstCliPrompt(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      const entry = parseLine(line)
      if (entry?.['kind'] !== 'Prompt') continue
      const text = arr(obj(entry['data'])?.['content']).map((c) => str(obj(c)?.['data'])).find(Boolean)
      if (text) return text
    }
  } finally {
    await handle.close()
  }
  return undefined
}

export class KiroSessionHistory implements SessionHistorySource {
  private readonly sessionsDir: string
  private readonly limit: number

  constructor(options: KiroHistoryOptions = {}) {
    this.sessionsDir = join(options.kiroDir ?? defaultKiroDir(), 'sessions')
    this.limit = options.limit ?? 400
  }

  async list(account: { agentId: string; accountId: string | null }): Promise<HistoryEntry[]> {
    const [cli, chat] = await Promise.all([this.listCli(account), this.listChat(account)])
    return [...cli, ...chat].sort((a, b) => b.lastModified - a.lastModified).slice(0, this.limit)
  }

  /** Not supported: Kiro sessions are listed only. */
  async messages(): Promise<HistoryMessage[]> {
    return []
  }

  private async listCli(account: { agentId: string; accountId: string | null }): Promise<HistoryEntry[]> {
    const dir = join(this.sessionsDir, 'cli')
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const entries = await Promise.all(
      names.map(async (name): Promise<HistoryEntry | null> => {
        const id = name.slice(0, -'.json'.length)
        try {
          const meta = parseKiroCliMeta(await readFile(join(dir, name), 'utf8'))
          const jsonl = join(dir, `${id}.jsonl`)
          const modified = await stat(jsonl).then((s) => ({ size: s.size, at: s.mtimeMs }), () => null)
          const prompt = modified?.size ? await firstCliPrompt(jsonl) : undefined
          // A session that never got a prompt is empty: nothing to list.
          if (!prompt && !meta.title) return null
          const entry: HistoryEntry = {
            agentId: account.agentId,
            accountId: account.accountId,
            agentSessionId: id,
            title: meta.title ?? oneLine(prompt ?? id),
            lastModified: meta.updatedAt ?? modified?.at ?? 0
          }
          if (prompt) entry.firstPrompt = prompt
          if (meta.cwd) entry.cwd = meta.cwd
          if (meta.createdAt !== undefined) entry.createdAt = meta.createdAt
          return entry
        } catch {
          return null
        }
      })
    )
    return entries.filter((e): e is HistoryEntry => e !== null)
  }

  private async listChat(account: { agentId: string; accountId: string | null }): Promise<HistoryEntry[]> {
    let folders: string[]
    try {
      folders = (await readdir(this.sessionsDir)).filter((f) => f !== 'cli')
    } catch {
      return []
    }
    const out: HistoryEntry[] = []
    for (const folder of folders) {
      const base = join(this.sessionsDir, folder)
      if (!(await isDirectory(base))) continue
      let names: string[]
      try {
        names = (await readdir(base)).filter((n) => n.startsWith('sess_'))
      } catch {
        continue
      }
      for (const name of names) {
        const dir = join(base, name)
        if (!(await isFile(join(dir, 'messages.jsonl')))) continue
        try {
          const info = parseKiroSessionJson(await readFile(join(dir, 'session.json'), 'utf8'))
          const modified = info.lastModifiedAt ?? (await stat(join(dir, 'messages.jsonl'))).mtimeMs
          const entry: HistoryEntry = { agentId: account.agentId, accountId: account.accountId, agentSessionId: name, title: info.title ?? name, lastModified: modified }
          if (info.cwd) entry.cwd = info.cwd
          if (info.createdAt !== undefined) entry.createdAt = info.createdAt
          out.push(entry)
        } catch {
          // A session folder without a readable session.json is skipped.
        }
      }
    }
    return out
  }
}
