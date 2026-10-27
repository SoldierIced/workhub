/**
 * Parses Codex rollout files into the common monitor model (PLAN "Session monitor"). Codex is not
 * installed on the development machine, so this follows the structure documented by third parties
 * and Codex's open source: one JSON object per line, `{timestamp, type, payload}`, with `type`
 * `session_meta`, `turn_context`, `response_item` and `event_msg` (`token_count` carries the
 * token totals and the rate limits). Every accessor is defensive: unknown or missing fields are
 * skipped and their monitor field stays empty.
 */
import type { PlanUsageWindow, SessionMonitorSnapshot, TokenUsage, ToolCallSummary } from '@workhub/core'
import { pullRequestUrls, ticketKeys } from '../shared/claude-tools'
import { arr, fileBase, num, obj, oneLine, parseLine, str, toMillis, type Obj } from '../shared/reader-utils'

export interface CodexMeta {
  id?: string
  cwd?: string
  branch?: string
  createdAt?: number
  /** True for a rollout that belongs to a subagent of another session. */
  subagent: boolean
}

/** The `session_meta` payload of a rollout's first line. */
export function readSessionMeta(payload: Obj | undefined): CodexMeta {
  const source = payload?.['source']
  return {
    id: str(payload?.['id']),
    cwd: str(payload?.['cwd']),
    branch: str(obj(payload?.['git'])?.['branch']),
    createdAt: toMillis(payload?.['timestamp']),
    // Unverified: subagent rollouts are expected to name their origin in `source`.
    subagent: obj(source) !== undefined && Object.keys(obj(source) ?? {}).some((k) => k === 'subagent' || k === 'sub_agent')
  }
}

/** Codex counts cached tokens inside `input_tokens`; Workhub's model keeps them apart. */
export function codexTokens(usage: Obj | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const input = num(usage['input_tokens'])
  const cached = num(usage['cached_input_tokens'])
  const output = num(usage['output_tokens'])
  const total = num(usage['total_tokens'])
  if (input === undefined && output === undefined && total === undefined) return undefined
  const tokens: TokenUsage = {}
  if (input !== undefined) tokens.input = Math.max(0, input - (cached ?? 0))
  if (cached) tokens.cacheRead = cached
  if (output !== undefined) tokens.output = output
  tokens.total = total ?? (input ?? 0) + (output ?? 0)
  return tokens
}

/** 300 min -> `5h`, 10080 -> `weekly`; other windows by length. */
export function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'limit'
  if (minutes === 300) return '5h'
  if (minutes === 10_080) return 'weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/** One window of a `token_count` event's `rate_limits` (`primary`, `secondary`). */
export function rateWindow(raw: unknown, at: number | undefined): PlanUsageWindow | undefined {
  const w = obj(raw)
  const percent = num(w?.['used_percent'])
  if (!w || percent === undefined) return undefined
  const out: PlanUsageWindow = { window: windowLabel(num(w['window_minutes'])), percent }
  const resetsAt = w['resets_at'] !== undefined ? toMillis(w['resets_at']) : undefined
  const inSeconds = num(w['resets_in_seconds'])
  if (resetsAt !== undefined) out.resetsAt = resetsAt
  else if (inSeconds !== undefined && at !== undefined) out.resetsAt = at + inSeconds * 1000
  return out
}

/** The command of a shell-like tool call: a string, or an argv whose last element is the script. */
function commandText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return str(raw)
  const parts = arr(raw).filter((p): p is string => typeof p === 'string')
  if (!parts.length) return undefined
  return parts.length >= 3 && /^(ba|z|fi)?sh$|^cmd(\.exe)?$|powershell/i.test(fileBase(parts[0] ?? '')) ? parts[parts.length - 1] : parts.join(' ')
}

function jsonArgs(raw: unknown): Obj {
  if (typeof raw === 'string') {
    try {
      return obj(JSON.parse(raw)) ?? {}
    } catch {
      return {}
    }
  }
  return obj(raw) ?? {}
}

/** The files an `apply_patch` input touches, from its `*** Update File:` style headers. */
function patchedFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => (m[1] ?? '').trim())
}

function describeCodexTool(name: string, args: Obj, input: string | undefined): { title: string; kind: string; detail?: string } {
  const command = commandText(args['command'] ?? args['cmd'])
  const detail = (d: string | undefined) => (d ? { detail: d } : {})
  if (['shell', 'exec_command', 'local_shell', 'container.exec', 'shell_command'].includes(name)) {
    return { title: str(args['justification']) ?? 'Ran a command', kind: 'execute', ...detail(command && `$ ${command}`) }
  }
  if (name === 'apply_patch') {
    const files = patchedFiles(str(args['input']) ?? input ?? '')
    const first = files[0]
    return { title: first ? `Edited ${fileBase(first)}${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : 'Edited files', kind: 'edit', ...detail(first) }
  }
  if (name === 'update_plan') return { title: 'Updated the plan', kind: 'other' }
  if (name === 'web_search') return { title: 'Searched the web', kind: 'fetch' }
  if (name === 'view_image') return { title: 'Looked at an image', kind: 'read', ...detail(str(args['path'])) }
  return { title: name.replaceAll('_', ' ').replaceAll('__', ': '), kind: 'other' }
}

/** Whether a tool output reports a failure (a non-zero exit code or `success: false`). */
function outputFailed(output: unknown): boolean {
  const o = typeof output === 'string' ? jsonArgs(output) : (obj(output) ?? {})
  const exit = num(obj(o['metadata'])?.['exit_code']) ?? num(o['exit_code'])
  return (exit !== undefined && exit !== 0) || o['success'] === false
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output.slice(0, 20_000)
  const o = obj(output)
  return (str(o?.['content']) ?? str(o?.['output']) ?? '').slice(0, 20_000)
}

export interface CodexParserOptions {
  ticketPrefixes?: readonly string[]
}

export class CodexRolloutParser {
  meta: CodexMeta = { subagent: false }
  private model: string | undefined
  private firstPrompt: string | undefined
  private total: Obj | undefined
  private last: Obj | undefined
  private contextWindow: number | undefined
  private primary: PlanUsageWindow | undefined
  private secondary: PlanUsageWindow | undefined
  private activeMs = 0
  private lastTotal: number | undefined
  private turnRequests: number[] = []
  private turnStart: number | undefined
  private readonly tools = new Map<string, ToolCallSummary>()
  private readonly prs: string[] = []
  private readonly tickets: string[] = []

  constructor(private readonly options: CodexParserOptions = {}) {}

  ingest(line: string): void {
    const entry = parseLine(line)
    const payload = obj(entry?.['payload'])
    if (!entry || !payload) return
    const at = toMillis(entry['timestamp'])
    switch (entry['type']) {
      case 'session_meta':
        this.meta = readSessionMeta(payload)
        this.scan(this.meta.branch)
        break
      case 'turn_context':
        this.model = str(payload['model']) ?? this.model
        break
      case 'event_msg':
        this.onEvent(payload, at)
        break
      case 'response_item':
        this.onItem(payload, at)
        break
    }
  }

  private onEvent(payload: Obj, at: number | undefined): void {
    switch (payload['type']) {
      case 'user_message': {
        const text = str(payload['message'])
        this.firstPrompt ??= text
        this.scan(text)
        break
      }
      case 'token_count': {
        const info = obj(payload['info'])
        if (info) {
          this.total = obj(info['total_token_usage']) ?? this.total
          const last = obj(info['last_token_usage'])
          this.last = last ?? this.last
          // Codex repeats a token_count; a request counts once, when the running total moves.
          const total = num(obj(info['total_token_usage'])?.['total_tokens'])
          if (last && total !== undefined && total !== this.lastTotal) {
            const t = codexTokens(last)
            this.turnRequests.push((t?.input ?? 0) + (t?.output ?? 0))
          }
          if (total !== undefined) this.lastTotal = total
          this.contextWindow = num(info['model_context_window']) ?? this.contextWindow
        }
        const limits = obj(payload['rate_limits'])
        if (limits) {
          this.primary = rateWindow(limits['primary'], at) ?? this.primary
          this.secondary = rateWindow(limits['secondary'], at) ?? this.secondary
        }
        break
      }
      case 'task_started':
      case 'turn_started':
        this.turnStart = at
        this.turnRequests = []
        break
      case 'task_complete':
      case 'turn_complete':
      case 'turn_aborted':
        if (this.turnStart !== undefined && at !== undefined && at >= this.turnStart) this.activeMs += at - this.turnStart
        this.turnStart = undefined
        break
    }
  }

  private onItem(payload: Obj, at: number | undefined): void {
    switch (payload['type']) {
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = str(payload['call_id']) ?? str(payload['id'])
        if (!id) break
        const isShell = payload['type'] === 'local_shell_call'
        const name = isShell ? 'shell' : str(payload['name']) ?? 'tool'
        const input = typeof payload['input'] === 'string' ? payload['input'] : undefined
        const args = isShell ? { command: obj(payload['action'])?.['command'] } : jsonArgs(payload['arguments'])
        const call: ToolCallSummary = { id, status: 'in_progress', ...describeCodexTool(name, args, input) }
        if (at !== undefined) call.startedAt = at
        this.tools.set(id, call)
        this.scan(commandText(args['command'] ?? args['cmd']))
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const call = this.tools.get(str(payload['call_id']) ?? '')
        if (call) {
          call.status = outputFailed(payload['output']) ? 'failed' : 'completed'
          if (at !== undefined) call.endedAt = at
        }
        this.scan(outputText(payload['output']))
        break
      }
    }
  }

  private scan(text: string | undefined): void {
    if (!text) return
    for (const url of pullRequestUrls(text)) if (!this.prs.includes(url)) this.prs.push(url)
    for (const key of ticketKeys(text, this.options.ticketPrefixes ?? [])) if (!this.tickets.includes(key)) this.tickets.push(key)
  }

  snapshot(): SessionMonitorSnapshot {
    const out: SessionMonitorSnapshot = {}
    if (this.firstPrompt) out.title = oneLine(this.firstPrompt)
    if (this.model) out.model = this.model
    const tokens = codexTokens(this.total)
    if (tokens) out.tokens = tokens
    // The prompt of the last request is what fills the context window.
    const used = num(this.last?.['input_tokens']) ?? num(this.last?.['total_tokens'])
    if (used !== undefined || this.contextWindow !== undefined) {
      out.context = {}
      if (used !== undefined) out.context.used = used
      if (this.contextWindow) out.context.size = this.contextWindow
      if (used !== undefined && this.contextWindow) out.context.percent = (used / this.contextWindow) * 100
    }
    const windows = [this.primary, this.secondary].filter((w): w is PlanUsageWindow => !!w)
    if (windows.length) out.planUsage = windows
    if (this.turnRequests.length) out.turnRequests = [...this.turnRequests]
    if (this.activeMs > 0) out.activeTimeMs = this.activeMs
    if (this.tools.size) out.toolCalls = [...this.tools.values()]
    if (this.prs.length) out.pullRequests = [...this.prs]
    if (this.tickets.length) out.ticketKeys = [...this.tickets]
    return out
  }
}
