/**
 * Maps OpenCode's database rows into the common monitor model (PLAN "Session monitor", checked
 * on a real OpenCode database). `session_v2` holds the totals (`cost`, `tokens_*`, `parent_id` for
 * subagent sessions); `session_message.data` is JSON per message `type`: `user`, `assistant`
 * (with `content` parts: `text`, `reasoning`, `tool`) and `shell`. Unknown data is skipped.
 */
import type { SessionMonitorSnapshot, SubagentSummary, TokenUsage, ToolCallSummary } from '@workhub/core'
import { pullRequestUrls, ticketKeys } from '../shared/claude-tools'
import { arr, fileBase, num, obj, oneLine, str, toMillis, type Obj } from '../shared/reader-utils'
import type { Row } from './db'

/** The model id out of the `model` column (`{"id":"...","providerID":"...","variant":"..."}`). */
export function modelName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    return str(obj(JSON.parse(raw))?.['id'])
  } catch {
    return str(raw)
  }
}

/** Tokens of a `session_v2` row. Reasoning tokens are output the model produced, so they count as output. */
export function rowTokens(row: Row): TokenUsage | undefined {
  const input = num(row['tokens_input']) ?? 0
  const output = (num(row['tokens_output']) ?? 0) + (num(row['tokens_reasoning']) ?? 0)
  const cacheRead = num(row['tokens_cache_read']) ?? 0
  const cacheWrite = num(row['tokens_cache_write']) ?? 0
  const total = input + output + cacheRead + cacheWrite
  if (total <= 0) return undefined
  const tokens: TokenUsage = { total }
  if (input) tokens.input = input
  if (output) tokens.output = output
  if (cacheRead) tokens.cacheRead = cacheRead
  if (cacheWrite) tokens.cacheWrite = cacheWrite
  return tokens
}

/** ACP-style kind of an OpenCode tool. */
export function openCodeToolKind(name: string): string {
  switch (name) {
    case 'shell':
    case 'execute':
      return 'execute'
    case 'read':
      return 'read'
    case 'edit':
    case 'write':
      return 'edit'
    case 'grep':
    case 'glob':
      return 'search'
    case 'webfetch':
      return 'fetch'
    default:
      return 'other'
  }
}

/** A tool call in words, with the command, path or URL behind it. */
export function describeOpenCodeTool(name: string, input: Obj): { title: string; detail?: string } {
  const path = str(input['path']) ?? str(input['filePath'])
  const file = path ? fileBase(path) : ''
  const detail = (d: string | undefined) => (d ? { detail: d } : {})
  switch (name) {
    case 'shell': {
      const command = str(input['command'])
      return { title: str(input['description']) ?? 'Ran a command', ...detail(command && `$ ${command}`) }
    }
    case 'execute':
      return { title: 'Ran code' }
    case 'read':
      return { title: file ? `Read ${file}` : 'Read a file', ...detail(path) }
    case 'edit':
      return { title: file ? `Edited ${file}` : 'Edited a file', ...detail(path) }
    case 'write':
      return { title: file ? `Wrote ${file}` : 'Wrote a file', ...detail(path) }
    case 'grep':
    case 'glob': {
      const pattern = str(input['pattern']) ?? str(input['query'])
      return { title: pattern ? `Searched the code for "${pattern}"` : 'Searched the code', ...detail(path) }
    }
    case 'webfetch': {
      const url = str(input['url'])
      return { title: url ? `Fetched ${url.replace(/^[a-z]+:\/\//i, '').split('/')[0]}` : 'Fetched a page', ...detail(url) }
    }
    case 'skill':
      return { title: `Loaded the ${str(input['name']) ?? ''} skill`.replace('  ', ' ') }
    case 'subagent':
      return { title: 'Started a subagent', ...detail(str(input['description']) ?? str(input['prompt'])) }
    case 'question':
      return { title: 'Asked you a question' }
    default:
      return { title: name.replaceAll('_', ' ') }
  }
}

/** Text a message's tool output holds, bounded, to look for pull request links in. */
function toolOutput(state: Obj): string {
  return arr(state['content'])
    .map((c) => str(obj(c)?.['text']))
    .filter(Boolean)
    .join('\n')
    .slice(0, 20_000)
}

/**
 * Accumulates one session's messages. Messages arrive in `seq` order and a message can be
 * ingested again while it is still running: tool calls are keyed by id and replaced.
 */
export class OpenCodeMessages {
  private readonly tools = new Map<string, ToolCallSummary>()
  private readonly activeMs = new Map<number, number>()
  private readonly prs: string[] = []
  private readonly tickets: string[] = []
  private firstPrompt: string | undefined
  private model: string | undefined

  constructor(private readonly ticketPrefixes: readonly string[] = []) {}

  /** Whether the message may still change (a running turn or tool), so it is read again next time. */
  ingest(seq: number, type: string, data: string): boolean {
    let message: Obj | undefined
    try {
      message = obj(JSON.parse(data))
    } catch {
      return false
    }
    if (!message) return false
    if (type === 'user') {
      const text = str(message['text'])
      this.firstPrompt ??= text
      this.scan(text)
      return false
    }
    if (type === 'shell') {
      const id = str(message['shellID']) ?? `shell-${seq}`
      const command = str(message['command'])
      const status = str(message['status'])
      const call: ToolCallSummary = { id, title: 'Ran a command', kind: 'execute', status: status === 'completed' || message['exit'] === 0 ? 'completed' : num(message['exit']) ? 'failed' : 'in_progress' }
      if (command) call.detail = `$ ${command}`
      const started = toMillis(obj(message['time'])?.['created'])
      if (started !== undefined) call.startedAt = started
      this.tools.set(id, call)
      this.scan(command)
      this.scan(str(obj(message['output'])?.['output'])?.slice(0, 20_000))
      return call.status === 'in_progress'
    }
    if (type !== 'assistant') return false

    const time = obj(message['time'])
    const created = num(time?.['created'])
    const completed = num(time?.['completed'])
    if (created !== undefined && completed !== undefined && completed >= created) this.activeMs.set(seq, completed - created)
    this.model = str(obj(message['model'])?.['id']) ?? this.model
    let running = completed === undefined
    for (const part of arr(message['content'])) {
      const p = obj(part)
      if (p?.['type'] !== 'tool') continue
      const id = str(p['id'])
      const name = str(p['name'])
      if (!id || !name) continue
      const state = obj(p['state']) ?? {}
      const input = obj(state['input']) ?? {}
      const status = str(state['status'])
      const call: ToolCallSummary = {
        id,
        kind: openCodeToolKind(name),
        status: status === 'completed' ? 'completed' : status === 'error' ? 'failed' : 'in_progress',
        ...describeOpenCodeTool(name, input)
      }
      const t = obj(p['time'])
      const started = toMillis(t?.['created'])
      if (started !== undefined) call.startedAt = started
      const ended = toMillis(t?.['completed'])
      if (ended !== undefined) call.endedAt = ended
      this.tools.set(id, call)
      if (call.status === 'in_progress') running = true
      this.scan(str(input['command']))
      this.scan(toolOutput(state))
    }
    return running
  }

  private scan(text: string | undefined): void {
    if (!text) return
    for (const url of pullRequestUrls(text)) if (!this.prs.includes(url)) this.prs.push(url)
    for (const key of ticketKeys(text, this.ticketPrefixes)) if (!this.tickets.includes(key)) this.tickets.push(key)
  }

  snapshot(row: Row, children: Row[], now: number): SessionMonitorSnapshot {
    const out: SessionMonitorSnapshot = {}
    const title = str(row['title']) ?? (this.firstPrompt ? oneLine(this.firstPrompt) : undefined)
    if (title) out.title = title
    const model = modelName(row['model']) ?? this.model
    if (model) out.model = model
    const tokens = rowTokens(row)
    if (tokens) out.tokens = tokens
    // A subscription or a local model has no per-token cost: 0 hides the field.
    const cost = num(row['cost'])
    if (cost && cost > 0) out.cost = { amount: cost, currency: 'USD' }
    const active = [...this.activeMs.values()].reduce((a, b) => a + b, 0)
    if (active > 0) out.activeTimeMs = active
    if (this.tools.size) out.toolCalls = [...this.tools.values()]
    if (children.length) out.subagents = children.map((c) => subagentOf(c, now))
    if (this.prs.length) out.pullRequests = [...this.prs]
    if (this.tickets.length) out.ticketKeys = [...this.tickets]
    return out
  }
}

/** A child session (`parent_id` set) as a subagent. */
export function subagentOf(row: Row, now: number): SubagentSummary {
  const updated = num(row['time_updated'])
  const idle = num(row['time_idle'])
  const sub: SubagentSummary = { id: str(row['id']) ?? '', status: idle !== undefined ? 'completed' : updated !== undefined && now - updated < 60_000 ? 'running' : 'stopped' }
  const title = str(row['title'])
  if (title) sub.description = title
  const type = str(row['agent'])
  if (type) sub.type = type
  const model = modelName(row['model'])
  if (model) sub.model = model
  const tokens = rowTokens(row)
  if (tokens) sub.tokens = tokens
  const cost = num(row['cost'])
  if (cost && cost > 0) sub.cost = { amount: cost, currency: 'USD' }
  const created = num(row['time_created'])
  if (created !== undefined) sub.startedAt = created
  if (updated !== undefined) sub.lastActivityAt = updated
  return sub
}
