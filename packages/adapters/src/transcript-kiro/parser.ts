/**
 * Parsers for Kiro's session files (PLAN "Session monitor", checked on Kiro 2.33.1). The formats
 * are internal and undocumented, so every accessor is defensive: unknown or malformed data is
 * skipped and the matching monitor field stays empty.
 *
 * Two layouts exist:
 * - Chat sessions: `~/.kiro/sessions/<hash>/sess_<id>/` with `session.json`, `messages.jsonl`
 *   (`{id, timestamp, payload: {type, ...}}`) and `sub-executions/<id>.jsonl`.
 * - ACP sessions: `~/.kiro/sessions/cli/<id>.json` (metadata, per-turn usage) and `<id>.jsonl`
 *   (`{version, kind: Prompt | AssistantMessage | ToolResults, data}`).
 */
import type { SessionMonitorSnapshot, SubagentSummary, TokenUsage, ToolCallSummary } from '@workhub/core'
import { pullRequestUrls, ticketKeys } from '../shared/claude-tools'
import { arr, fileBase, num, obj, oneLine, parseLine, str, toMillis, type Obj } from '../shared/reader-utils'

/** What `session.json` of a chat session says about it. */
export interface KiroSessionInfo {
  title?: string
  model?: string
  cwd?: string
  createdAt?: number
  lastModifiedAt?: number
}

export function parseKiroSessionJson(text: string): KiroSessionInfo {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return {}
  }
  if (!raw) return {}
  const roots = [...arr(raw['workspacePaths']), ...arr(raw['rootPaths'])]
  return {
    title: str(raw['title']),
    model: str(raw['modelId']),
    cwd: roots.map(str).find(Boolean),
    createdAt: toMillis(raw['createdAt']),
    lastModifiedAt: toMillis(raw['lastModifiedAt'])
  }
}

/** ACP tool kind of a Kiro tool name (ACP sessions record names, chat sessions record kinds). */
export function kiroToolKind(name: string): string {
  switch (name) {
    case 'shell':
    case 'execute_bash':
      return 'execute'
    case 'read':
    case 'read_file':
    case 'read_files':
    case 'list_directory':
      return 'read'
    case 'write':
    case 'fs_write':
    case 'fs_append':
    case 'str_replace':
      return 'edit'
    case 'delete_file':
      return 'delete'
    case 'grep':
    case 'glob':
    case 'grep_search':
      return 'search'
    case 'web_fetch':
    case 'remote_web_search':
      return 'fetch'
    default:
      return 'other'
  }
}

/** The command, path or query behind a tool call. */
function toolDetail(args: Obj): string | undefined {
  const command = str(args['command'])
  if (command) return `$ ${command}`
  const files = arr(args['files']).map((f) => str(obj(f)?.['path'])).find(Boolean)
  const op = arr(args['operations']).map((o) => str(obj(o)?.['path'])).find(Boolean)
  return str(args['path']) ?? str(args['filePath']) ?? str(args['targetFile']) ?? files ?? op ?? str(args['query']) ?? str(args['url']) ?? str(args['pattern'])
}

/** A tool call in words when Kiro gave no title (ACP sessions only record the tool name and input). */
function describeKiroTool(name: string, input: Obj): { title: string; detail?: string } {
  const detail = toolDetail(input)
  const file = detail && !detail.startsWith('$ ') ? fileBase(detail) : ''
  switch (kiroToolKind(name)) {
    case 'execute':
      return { title: str(input['command_explanation']) ?? str(input['description']) ?? 'Ran a command', detail }
    case 'read':
      return { title: file ? `Read ${file}` : 'Read files', detail }
    case 'edit':
      return { title: file ? `Edited ${file}` : 'Edited a file', detail }
    case 'delete':
      return { title: file ? `Deleted ${file}` : 'Deleted a file', detail }
    case 'search':
      return { title: str(input['query']) ?? str(input['pattern']) ? `Searched for "${str(input['query']) ?? str(input['pattern'])}"` : 'Searched the code', detail }
    case 'fetch':
      return { title: `Fetched ${detail ?? 'a page'}`, detail }
    default:
      return { title: name.replaceAll('_', ' '), detail }
  }
}

/** Keeps pull request URLs and ticket keys found in text, oldest first. */
class Mentions {
  readonly pullRequests: string[] = []
  readonly tickets: string[] = []
  constructor(private readonly prefixes: readonly string[]) {}

  scan(text: string | undefined): void {
    if (!text) return
    for (const url of pullRequestUrls(text)) if (!this.pullRequests.includes(url)) this.pullRequests.push(url)
    for (const key of ticketKeys(text, this.prefixes)) if (!this.tickets.includes(key)) this.tickets.push(key)
  }
}

function sum(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined)
  return present.length ? present.reduce((a, b) => a + b, 0) : undefined
}

export interface KiroParserOptions {
  ticketPrefixes?: readonly string[]
}

/** Reads a chat session's `messages.jsonl` one line at a time. */
export class KiroChatParser {
  private readonly tools = new Map<string, ToolCallSummary>()
  private readonly mentions: Mentions
  private readonly subagents = new Map<string, { id: string; name?: string; description?: string; startedAt?: number; endedAt?: number; status?: string }>()
  private readonly credits: number[] = []
  private elapsedMs = 0
  private contextPercent: number | undefined
  private firstPrompt: string | undefined

  constructor(options: KiroParserOptions = {}) {
    this.mentions = new Mentions(options.ticketPrefixes ?? [])
  }

  ingest(line: string): void {
    const entry = parseLine(line)
    const payload = obj(entry?.['payload'])
    if (!entry || !payload) return
    const at = toMillis(entry['timestamp'])
    switch (payload['type']) {
      case 'user': {
        const text = str(payload['content'])
        this.firstPrompt ??= text
        this.mentions.scan(text)
        break
      }
      case 'tool_call': {
        const id = str(payload['toolCallId'])
        if (!id) break
        const args = obj(payload['args']) ?? {}
        const status = str(payload['status'])
        const call: ToolCallSummary = {
          id,
          title: str(payload['title']) ?? str(payload['toolName']) ?? 'Tool call',
          kind: str(payload['kind']) ?? kiroToolKind(str(payload['toolName']) ?? ''),
          // `approved`: the user or the agent's trust settings allowed it; the result decides the rest.
          status: status === 'denied' ? 'failed' : 'in_progress'
        }
        const detail = toolDetail(args)
        if (detail) call.detail = detail
        if (at !== undefined) call.startedAt = at
        this.tools.set(id, call)
        this.mentions.scan(str(args['command']))
        break
      }
      case 'tool_result': {
        const call = this.tools.get(str(payload['toolCallId']) ?? '')
        if (call && call.status !== 'failed') call.status = payload['success'] === false ? 'failed' : 'completed'
        if (call && at !== undefined) call.endedAt = at
        this.mentions.scan(str(payload['content']))
        break
      }
      case 'usage_summary': {
        const turn = sum(arr(payload['promptTurnSummaries']).map((s) => num(obj(s)?.['usage'])))
        if (turn !== undefined) this.credits.push(turn)
        this.elapsedMs += num(payload['elapsedTime']) ?? 0
        break
      }
      case 'session_metadata':
        if (payload['key'] === 'contextUsage') this.contextPercent = num(obj(payload['value'])?.['usagePercentage']) ?? this.contextPercent
        break
      case 'sub_agent_start': {
        const id = str(payload['subSessionId'])
        if (id) this.subagents.set(id, { id, name: str(payload['subAgentName']), description: str(payload['explanation']), startedAt: at })
        break
      }
      case 'sub_agent_complete': {
        const sub = this.subagents.get(str(payload['subSessionId']) ?? '')
        if (sub) {
          sub.endedAt = at
          sub.status = str(payload['status']) === 'success' ? 'completed' : 'failed'
        }
        break
      }
    }
  }

  /** The sub-execution ids named by `sub_agent_start`, to find their files. */
  subSessionIds(): string[] {
    return [...this.subagents.keys()]
  }

  /** `info` comes from `session.json`; `activity` from the sub-execution files, by sub-session id. */
  snapshot(info: KiroSessionInfo, activity: ReadonlyMap<string, SubExecutionActivity>): SessionMonitorSnapshot {
    const out: SessionMonitorSnapshot = {}
    const title = info.title ?? (this.firstPrompt ? oneLine(this.firstPrompt) : undefined)
    if (title) out.title = title
    if (info.model) out.model = info.model
    const credits = sum(this.credits)
    if (credits !== undefined) {
      out.credits = credits
      out.lastTurnCredits = this.credits[this.credits.length - 1]
      out.turnCredits = [...this.credits]
    }
    if (this.contextPercent !== undefined) out.context = { percent: this.contextPercent }
    if (this.elapsedMs > 0) out.activeTimeMs = this.elapsedMs
    if (this.tools.size) out.toolCalls = [...this.tools.values()]
    if (this.subagents.size) {
      out.subagents = [...this.subagents.values()].map((s): SubagentSummary => {
        const a = activity.get(s.id)
        const sub: SubagentSummary = { id: s.id, status: s.status ?? 'running' }
        const name = s.name ?? s.description
        if (name) sub.name = name
        if (s.description) sub.description = s.description
        if (s.startedAt !== undefined) sub.startedAt = s.startedAt
        if (a?.lastStep) sub.lastStep = a.lastStep
        if (a) sub.stepCount = a.steps
        if (a?.lastActivityAt !== undefined) sub.lastActivityAt = a.lastActivityAt
        return sub
      })
    }
    if (this.mentions.pullRequests.length) out.pullRequests = [...this.mentions.pullRequests]
    if (this.mentions.tickets.length) out.ticketKeys = [...this.mentions.tickets]
    return out
  }
}

/** What one `sub-executions/<id>.jsonl` shows: how many tool calls and the last one. */
export interface SubExecutionActivity {
  steps: number
  lastStep?: string
  lastActivityAt?: number
}

export class KiroSubExecutionParser {
  steps = 0
  lastStep: string | undefined
  lastActivityAt: number | undefined

  ingest(line: string): void {
    const entry = parseLine(line)
    const payload = obj(entry?.['payload'])
    if (!entry || !payload) return
    this.lastActivityAt = toMillis(entry['timestamp']) ?? this.lastActivityAt
    if (payload['type'] === 'tool_call') {
      this.steps += 1
      this.lastStep = str(payload['title']) ?? str(payload['toolName']) ?? this.lastStep
    }
  }

  activity(): SubExecutionActivity {
    return { steps: this.steps, lastStep: this.lastStep, lastActivityAt: this.lastActivityAt }
  }
}

/** Facts from an ACP session's `cli/<id>.json`: model, context, per-turn tokens, credits and duration. */
export function parseKiroCliMeta(text: string): SessionMonitorSnapshot & { cwd?: string; updatedAt?: number; createdAt?: number } {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return {}
  }
  if (!raw) return {}
  const state = obj(raw['session_state'])
  const model = obj(obj(state?.['rts_model_state'])?.['model_info'])
  const turns = arr(obj(state?.['conversation_metadata'])?.['user_turn_metadatas']).map(obj).filter((t): t is Obj => !!t)
  const out: SessionMonitorSnapshot & { cwd?: string; updatedAt?: number; createdAt?: number } = {}
  const title = str(raw['title'])
  if (title) out.title = title
  const modelId = str(model?.['model_id']) ?? str(turns[turns.length - 1]?.['model'])
  if (modelId) out.model = modelId
  const cwd = str(raw['cwd'])
  if (cwd) out.cwd = cwd
  const updatedAt = toMillis(raw['updated_at'])
  if (updatedAt !== undefined) out.updatedAt = updatedAt
  const createdAt = toMillis(raw['created_at'])
  if (createdAt !== undefined) out.createdAt = createdAt

  const lastTurn = turns[turns.length - 1]
  const percent = num(lastTurn?.['final_context_usage_percentage']) ?? num(obj(state?.['rts_model_state'])?.['context_usage_percentage'])
  const size = num(model?.['context_window_tokens'])
  if (percent !== undefined || size !== undefined) {
    out.context = {}
    if (percent !== undefined) out.context.percent = percent
    if (size !== undefined) out.context.size = size
    if (percent !== undefined && size !== undefined) out.context.used = Math.round((percent / 100) * size)
  }

  const turnCredits = turns.map((t) => sum(arr(t['metering_usage']).map((m) => num(obj(m)?.['value']))))
  const credits = sum(turnCredits)
  if (credits !== undefined) {
    out.credits = credits
    const last = turnCredits[turnCredits.length - 1]
    if (last !== undefined) out.lastTurnCredits = last
    out.turnCredits = turnCredits.filter((c): c is number => c !== undefined)
  }

  const field = (key: string) => sum(turns.map((t) => num(t[key])))
  const tokens: TokenUsage = {}
  const input = field('input_token_count')
  const output = field('output_token_count')
  const cacheRead = field('cache_read_input_token_count')
  const cacheWrite = field('cache_write_input_token_count')
  if (input) tokens.input = input
  if (output) tokens.output = output
  if (cacheRead) tokens.cacheRead = cacheRead
  if (cacheWrite) tokens.cacheWrite = cacheWrite
  // Kiro reports zeros for many models: no tokens at all hides the field instead of showing 0.
  if (Object.keys(tokens).length) {
    tokens.total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    out.tokens = tokens
  }

  const durationMs = sum(
    turns.map((t) => {
      const d = obj(t['turn_duration'])
      const secs = num(d?.['secs'])
      return secs === undefined ? undefined : secs * 1000 + Math.round((num(d?.['nanos']) ?? 0) / 1e6)
    })
  )
  if (durationMs) out.activeTimeMs = durationMs
  return out
}

/** Reads an ACP session's `cli/<id>.jsonl`: prompts, tool uses and their results. */
export class KiroCliParser {
  private readonly tools = new Map<string, ToolCallSummary>()
  private readonly mentions: Mentions
  private firstPrompt: string | undefined

  constructor(options: KiroParserOptions = {}) {
    this.mentions = new Mentions(options.ticketPrefixes ?? [])
  }

  ingest(line: string): void {
    const entry = parseLine(line)
    const data = obj(entry?.['data'])
    if (!entry || !data) return
    const content = arr(data['content']).map(obj).filter((c): c is Obj => !!c)
    const at = toMillis(obj(data['meta'])?.['timestamp'])
    switch (entry['kind']) {
      case 'Prompt': {
        const text = content.map((c) => (c['kind'] === 'text' ? str(c['data']) : undefined)).filter(Boolean).join('\n')
        if (text) {
          this.firstPrompt ??= text
          this.mentions.scan(text)
        }
        break
      }
      case 'AssistantMessage':
        for (const c of content) {
          const use = c['kind'] === 'toolUse' ? obj(c['data']) : undefined
          const id = str(use?.['toolUseId'])
          const name = str(use?.['name'])
          if (!use || !id || !name) continue
          const input = obj(use['input']) ?? {}
          const call: ToolCallSummary = { id, kind: kiroToolKind(name), status: 'in_progress', ...describeKiroTool(name, input) }
          if (at !== undefined) call.startedAt = at
          this.tools.set(id, call)
          this.mentions.scan(str(input['command']))
        }
        break
      case 'ToolResults':
        for (const c of content) {
          const result = c['kind'] === 'toolResult' ? obj(c['data']) : undefined
          const call = this.tools.get(str(result?.['toolUseId']) ?? '')
          if (call) call.status = str(result?.['status']) === 'success' ? 'completed' : 'failed'
          // Command output is nested JSON here; a bounded text form is enough to find PR links.
          if (result) this.mentions.scan(JSON.stringify(result['content'] ?? '').slice(0, 20_000))
        }
        break
    }
  }

  snapshot(): SessionMonitorSnapshot {
    const out: SessionMonitorSnapshot = {}
    if (this.firstPrompt) out.title = oneLine(this.firstPrompt)
    if (this.tools.size) out.toolCalls = [...this.tools.values()]
    if (this.mentions.pullRequests.length) out.pullRequests = [...this.mentions.pullRequests]
    if (this.mentions.tickets.length) out.ticketKeys = [...this.mentions.tickets]
    return out
  }
}
