/**
 * One Claude subagent transcript (`subagents/agent-<id>.jsonl`) as a conversation: the prompt the
 * parent gave it, its text, thinking and tool calls in order, and the answer it returned. Pure:
 * lines in, view model out, so it runs against small synthetic sidechain fixtures.
 */
import type { ConversationEntry } from '@workhub/core'
import { describeTool } from '../shared/claude-tools'
import { claudeToolResult, claudeToolView } from '../shared/claude-tool-view'

type Obj = Record<string, unknown>
type ToolEntry = Extract<ConversationEntry, { kind: 'tool' }>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Most entries kept; older ones are dropped and counted. */
export const CONVERSATION_LIMIT = 2_000
/** A gap longer than this is not thinking time (the session was idle). */
const THINKING_GAP_LIMIT = 30 * 60_000

function time(v: unknown): number | undefined {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? undefined : t
}

export interface ConversationSnapshot {
  prompt?: string
  entries: ConversationEntry[]
  result?: string
  cwd?: string
  omitted?: number
}

export class SubagentConversationBuilder {
  private prompt: string | undefined
  private entries: ConversationEntry[] = []
  private readonly tools = new Map<string, ToolEntry>()
  private omitted = 0
  private lastAt: number | undefined
  private cwd: string | undefined
  private seq = 0
  private sawAssistant = false
  /** The last assistant message ended the turn: its text is the answer. */
  private terminal = false

  ingest(line: string): void {
    let entry: Obj | undefined
    try {
      entry = obj(JSON.parse(line))
    } catch {
      return
    }
    const type = entry?.['type']
    const message = obj(entry?.['message'])
    if (!entry || !message || (type !== 'assistant' && type !== 'user')) return
    const at = time(entry['timestamp'])
    const previous = this.lastAt
    if (at !== undefined) this.lastAt = at
    this.cwd ??= str(entry['cwd'])
    if (type === 'assistant') this.assistant(message, at, previous)
    else this.user(entry, message, at)
    if (this.entries.length > CONVERSATION_LIMIT) {
      const drop = this.entries.length - CONVERSATION_LIMIT
      for (const e of this.entries.slice(0, drop)) if (e.kind === 'tool') this.tools.delete(e.id)
      this.entries = this.entries.slice(drop)
      this.omitted += drop
    }
  }

  private nextId(): string {
    this.seq += 1
    return `e${this.seq}`
  }

  private assistant(message: Obj, at: number | undefined, previous: number | undefined): void {
    this.sawAssistant = true
    // A streamed message is written one block per record; only the last carries the stop reason.
    this.terminal = message['stop_reason'] === 'end_turn'
    for (const raw of arr(message['content'])) {
      const b = obj(raw)
      if (!b) continue
      if (b['type'] === 'text' && str(b['text'])) {
        this.entries.push({ kind: 'text', id: this.nextId(), text: b['text'] as string, ...(at !== undefined ? { at } : {}) })
      } else if (b['type'] === 'thinking' || b['type'] === 'redacted_thinking') {
        const text = typeof b['thinking'] === 'string' ? b['thinking'] : ''
        const thinking: ConversationEntry = { kind: 'thinking', id: this.nextId(), text }
        if (at !== undefined) thinking.at = at
        if (at !== undefined && previous !== undefined && at - previous > 0 && at - previous < THINKING_GAP_LIMIT) thinking.durationMs = at - previous
        this.entries.push(thinking)
      } else if (b['type'] === 'tool_use' && str(b['id']) && str(b['name'])) {
        const name = b['name'] as string
        const input = obj(b['input']) ?? {}
        const { title, detail } = describeTool(name, input)
        const tool: ToolEntry = { kind: 'tool', id: b['id'] as string, name, title, view: claudeToolView(name, input), status: 'in_progress' }
        if (detail) tool.detail = detail
        if (at !== undefined) tool.at = at
        this.tools.set(tool.id, tool)
        this.entries.push(tool)
        this.terminal = false
      }
    }
  }

  private user(entry: Obj, message: Obj, at: number | undefined): void {
    this.terminal = false
    const content = message['content']
    const blocks = arr(content).map(obj).filter((b): b is Obj => !!b)
    const text = typeof content === 'string' ? content : blocks.filter((b) => b['type'] === 'text').map((b) => str(b['text']) ?? '').join('\n')
    if (text.trim() && entry['isMeta'] !== true) {
      if (!this.sawAssistant && this.prompt === undefined) this.prompt = text
      else this.entries.push({ kind: 'user', id: this.nextId(), text, ...(at !== undefined ? { at } : {}) })
    }
    // The structured result belongs to the entry's only tool result; with several it is ambiguous.
    const extra = blocks.filter((b) => b['type'] === 'tool_result').length === 1 ? entry['toolUseResult'] : undefined
    for (const b of blocks) {
      if (b['type'] !== 'tool_result') continue
      const tool = this.tools.get(str(b['tool_use_id']) ?? '')
      if (!tool) continue
      const failed = b['is_error'] === true
      tool.status = failed ? 'failed' : 'completed'
      tool.result = claudeToolResult(tool.name, b['content'], failed, extra)
      if (at !== undefined) tool.endedAt = at
    }
  }

  snapshot(): ConversationSnapshot {
    const entries = this.entries.map((e) => (e.kind === 'tool' ? { ...e, ...(e.result ? { result: { ...e.result } } : {}) } : { ...e }))
    const snap: ConversationSnapshot = { entries }
    if (this.prompt !== undefined) snap.prompt = this.prompt
    if (this.cwd) snap.cwd = this.cwd
    if (this.omitted) snap.omitted = this.omitted
    // The answer is the text the finished turn ended with; it shows once, as the result.
    if (this.terminal) {
      const answer: string[] = []
      while (entries.length && entries[entries.length - 1]!.kind === 'text') answer.unshift((entries.pop() as { text: string }).text)
      if (answer.length) snap.result = answer.join('\n\n')
    }
    return snap
  }
}
