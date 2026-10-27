/**
 * Session history of Claude accounts through Workhub 1's `sessions.mjs` (the Agent SDK's
 * `listSessions` and `getSessionMessages`). One Node process per call, with the account's
 * `CLAUDE_CONFIG_DIR`, the same way `claude` itself picks the account.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { HistoryEntry, HistoryMessage, SessionHistorySource } from '@workhub/core'
import { describeTool } from '../shared/claude-tools'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export interface ClaudeHistoryOptions {
  bridgeDir: string
  nodeCommand?: string
  /** Most sessions listed per account (Workhub 1: 400). */
  limit?: number
}

/** `SDKSessionInfo` list -> history entries of one account. */
export function toHistoryEntries(raw: unknown, agentId: string, accountId: string | null): HistoryEntry[] {
  return arr(raw).flatMap((x) => {
    const s = obj(x)
    const id = str(s?.['sessionId'])
    if (!s || !id) return []
    const entry: HistoryEntry = {
      agentId,
      accountId,
      agentSessionId: id,
      title: str(s['customTitle']) ?? str(s['summary']) ?? str(s['firstPrompt']) ?? id,
      lastModified: typeof s['lastModified'] === 'number' ? s['lastModified'] : 0
    }
    const firstPrompt = str(s['firstPrompt'])
    if (firstPrompt) entry.firstPrompt = firstPrompt
    const cwd = str(s['cwd'])
    if (cwd) entry.cwd = cwd
    const branch = str(s['gitBranch'])
    if (branch) entry.gitBranch = branch
    if (typeof s['createdAt'] === 'number') entry.createdAt = s['createdAt']
    return [entry]
  })
}

/** Text a user typed, without the wrappers Claude Code adds for local commands and reminders. */
function typedText(text: string): string | undefined {
  if (text.includes('<command-name>') || text.includes('<local-command') || text.startsWith('<system-reminder>')) return undefined
  return text.trim() || undefined
}

/** `SessionMessage` list -> the conversation to replay when a past session opens in the app. */
export function toHistoryMessages(raw: unknown): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const tools = new Map<string, Extract<HistoryMessage, { kind: 'tool' }>>()
  for (const x of arr(raw)) {
    const m = obj(x)
    // Subagent turns belong to their Agent call.
    if (!m || str(m['parent_tool_use_id'])) continue
    const message = obj(m['message'])
    const content = message?.['content']
    if (m['type'] === 'user') {
      if (typeof content === 'string') {
        const text = typedText(content)
        if (text) out.push({ kind: 'user', text })
        continue
      }
      const blocks = arr(content).map(obj).filter((b): b is Obj => !!b)
      const text = typedText(blocks.filter((b) => b['type'] === 'text').map((b) => str(b['text']) ?? '').join('\n'))
      const images = blocks.filter((b) => b['type'] === 'image').length
      if (text || images) out.push(images ? { kind: 'user', text: text ?? '', images } : { kind: 'user', text: text! })
      for (const b of blocks) {
        const tool = b['type'] === 'tool_result' ? tools.get(str(b['tool_use_id']) ?? '') : undefined
        if (tool && b['is_error'] === true) tool.failed = true
      }
    } else if (m['type'] === 'assistant') {
      for (const raw of arr(content)) {
        const b = obj(raw)
        if (b?.['type'] === 'text' && str(b['text'])) {
          const last = out[out.length - 1]
          if (last?.kind === 'agent') last.text += `\n\n${b['text'] as string}`
          else out.push({ kind: 'agent', text: b['text'] as string })
        } else if (b?.['type'] === 'tool_use' && str(b['id']) && str(b['name'])) {
          const { title, detail } = describeTool(b['name'] as string, obj(b['input']) ?? {})
          const tool: Extract<HistoryMessage, { kind: 'tool' }> = { kind: 'tool', id: b['id'] as string, title }
          if (detail) tool.detail = detail
          tools.set(tool.id, tool)
          out.push(tool)
        }
      }
    }
  }
  return out
}

export class ClaudeSessionHistory implements SessionHistorySource {
  constructor(private readonly options: ClaudeHistoryOptions) {}

  async list(account: { agentId: string; accountId: string | null; configDir?: string }): Promise<HistoryEntry[]> {
    const raw = await this.run(['all', String(this.options.limit ?? 400)], account.configDir)
    return toHistoryEntries(raw, account.agentId, account.accountId)
  }

  async messages(agentSessionId: string, cwd: string, configDir?: string): Promise<HistoryMessage[]> {
    return toHistoryMessages(await this.run(['messages', agentSessionId, cwd], configDir))
  }

  private run(args: string[], configDir: string | undefined): Promise<unknown> {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir
    return new Promise((resolve, reject) => {
      execFile(
        this.options.nodeCommand ?? process.execPath,
        [join(this.options.bridgeDir, 'sessions.mjs'), ...args],
        { env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        (err, stdout) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(stdout)
          } catch {
            reject(err ?? new Error('the session list could not be read'))
            return
          }
          const error = str(obj(parsed)?.['error'])
          if (error) reject(new Error(error))
          else resolve(parsed)
        }
      )
    })
  }
}
