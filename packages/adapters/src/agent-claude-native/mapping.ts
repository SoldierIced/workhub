/**
 * Maps the bridge's lines (Workhub 1's protocol, see `bridge/bridge.mjs`) to Workhub agent events.
 * Pure apart from the id counter, so it is tested against recorded-shape fixtures.
 */
import {
  isUnattendedMode,
  isUsageLimitText,
  limitResetFromText,
  type AgentEvent,
  type McpServerState,
  type McpServerStatus,
  type ModelOption,
  type PermissionModeInfo,
  type PermissionOption,
  type PlanUsageWindow,
  type SessionMonitorSnapshot
} from '@workhub/core'
import { describeTool, toolKind } from '../shared/claude-tools'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Claude Code's permission modes, as the terminal names them. */
const MODE_LABEL: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
  auto: 'Auto'
}

export function claudePermissionMode(id: string, source: PermissionModeInfo['source'] = 'agent'): PermissionModeInfo {
  return { id, label: MODE_LABEL[id] ?? id, source, unattended: isUnattendedMode(id) }
}

function mcpState(status: string | undefined): McpServerState {
  switch (status) {
    case 'connected':
      return 'running'
    case 'pending':
      return 'loading'
    case 'needs-auth':
      return 'needs-auth'
    case 'failed':
      return 'failed'
    case 'disabled':
      return 'disabled'
    default:
      return 'unknown'
  }
}

export function mcpServers(raw: unknown): McpServerStatus[] {
  return arr(raw).flatMap((x) => {
    const s = obj(x)
    const name = str(s?.['name'])
    if (!s || !name) return []
    const server: McpServerStatus = { name, state: mcpState(str(s['status'])) }
    const tools = arr(s['tools']).filter((t): t is string => typeof t === 'string')
    if (tools.length) server.tools = tools
    const count = num(s['toolCount'])
    if (count !== undefined) server.toolCount = count
    const error = str(s['error'])
    if (error) server.error = error
    const source = str(s['scope']) ?? str(s['source'])
    if (source) server.source = source
    return [server]
  })
}

const WINDOW: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet'
}

/** A `rate_limit_event`: the account's plan window, when the CLI reports its utilization. */
export function rateLimitWindow(info: unknown): PlanUsageWindow | null {
  const i = obj(info)
  const type = str(i?.['rateLimitType'])
  const utilization = num(i?.['utilization'])
  if (!i || !type || !WINDOW[type] || utilization === undefined) return null
  // The CLI reports a fraction; a value above 1 is already a percent.
  const percent = utilization <= 1 ? utilization * 100 : utilization
  const window: PlanUsageWindow = { window: WINDOW[type]!, percent: Math.min(100, Math.max(0, percent)) }
  const resets = num(i['resetsAt'])
  if (resets !== undefined) window.resetsAt = resets > 1e11 ? resets : resets * 1000
  return window
}

/**
 * A `rate_limit_event` that refused the request: the plan window is spent and no extra usage
 * (overage) covers it. The window and reset when the CLI says; null while the account may go on.
 */
export function rejectedLimit(info: unknown): { window?: string; resetsAt?: number } | null {
  const i = obj(info)
  if (!i || i['status'] !== 'rejected') return null
  const overage = i['overageStatus']
  if (overage === 'allowed' || overage === 'allowed_warning') return null
  const out: { window?: string; resetsAt?: number } = {}
  const type = str(i['rateLimitType'])
  if (type && WINDOW[type]) out.window = WINDOW[type]
  const resets = num(i['resetsAt'])
  if (resets !== undefined) out.resetsAt = resets > 1e11 ? resets : resets * 1000
  return out
}

export const PERMISSION_OPTIONS = {
  allowOnce: { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  allowAlways: { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  deny: { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
} as const satisfies Record<string, PermissionOption>

/** The bridge's answer to a permission request for the option the user picked (null: cancelled). */
export function permissionResult(optionId: string | null, input: unknown, suggestions: unknown): Obj {
  if (optionId === PERMISSION_OPTIONS.allowOnce.optionId) return { behavior: 'allow', updatedInput: obj(input) ?? {} }
  if (optionId === PERMISSION_OPTIONS.allowAlways.optionId) {
    return { behavior: 'allow', updatedInput: obj(input) ?? {}, updatedPermissions: arr(suggestions) }
  }
  return { behavior: 'deny', message: optionId ? 'The user denied this.' : 'The request was cancelled.' }
}

/** One session's mapping state: which assistant messages already streamed their text. */
export class ClaudeBridgeMapper {
  private readonly streamed = new Set<string>()
  private streaming: string | undefined
  private notices = 0
  private readonly permissions = new Map<string, { input: unknown; suggestions: unknown }>()
  /** Last plan windows reported, by window name. */
  private readonly windows = new Map<string, PlanUsageWindow>()

  constructor(private readonly sessionId: string) {}

  /** The stored input and suggestions of a pending permission request. */
  takePermission(requestId: string): { input: unknown; suggestions: unknown } | undefined {
    const p = this.permissions.get(requestId)
    this.permissions.delete(requestId)
    return p
  }

  /** Events for one bridge line. `result` lines are handled by the runtime (they end a prompt). */
  map(line: Obj): AgentEvent[] {
    const sessionId = this.sessionId
    switch (line['type']) {
      case 'options': {
        const events: AgentEvent[] = []
        const models: ModelOption[] = arr(line['models']).flatMap((m) => {
          const o = obj(m)
          const id = str(o?.['value'])
          return id ? [{ id, name: str(o?.['displayName']) ?? id, description: str(o?.['description']) }] : []
        })
        if (models.length) events.push({ sessionId, type: 'models', models })
        const mode = str(obj(line['defaults'])?.['permissionMode'])
        if (mode) events.push({ sessionId, type: 'permissionMode', mode: claudePermissionMode(mode), currentModeId: mode })
        return events
      }
      case 'mcp_status':
        return [{ sessionId, type: 'monitor', snapshot: { mcpServers: mcpServers(line['servers']) } }]
      case 'mcp_error':
      case 'option_error': {
        const name = str(line['name'])
        return [this.notice('warning', name ? `${line['type'] === 'mcp_error' ? 'MCP' : 'Setting'}: ${name}` : 'MCP', str(line['message']) ?? '')]
      }
      case 'permission_request': {
        const requestId = str(line['id'])
        const tool = str(line['toolName'])
        if (!requestId || !tool) return []
        this.permissions.set(requestId, { input: line['input'], suggestions: line['suggestions'] })
        const { title, detail } = describeTool(tool, obj(line['input']) ?? {})
        const options: PermissionOption[] = [PERMISSION_OPTIONS.allowOnce]
        if (arr(line['suggestions']).length) options.push(PERMISSION_OPTIONS.allowAlways)
        options.push(PERMISSION_OPTIONS.deny)
        return [{ sessionId, type: 'permission', requestId, title, detail: detail || undefined, options }]
      }
      case 'permission_cancelled': {
        const requestId = str(line['id'])
        if (!requestId) return []
        this.permissions.delete(requestId)
        return [{ sessionId, type: 'permissionCancelled', requestId }]
      }
      case 'sdk':
        return this.sdk(obj(line['message']) ?? {})
      default:
        return []
    }
  }

  private sdk(m: Obj): AgentEvent[] {
    const sessionId = this.sessionId
    // Subagent traffic belongs to its Agent/Task tool call, not to the conversation.
    if (str(m['parent_tool_use_id'])) return []
    switch (m['type']) {
      case 'stream_event': {
        const event = obj(m['event'])
        if (event?.['type'] === 'message_start') this.streaming = str(obj(event['message'])?.['id'])
        if (event?.['type'] !== 'content_block_delta') return []
        const delta = obj(event['delta'])
        if (delta?.['type'] === 'text_delta' && str(delta['text'])) {
          if (this.streaming) this.streamed.add(this.streaming)
          return [{ sessionId, type: 'message', role: 'agent', text: delta['text'] as string }]
        }
        if (delta?.['type'] === 'thinking_delta' && str(delta['thinking'])) {
          if (this.streaming) this.streamed.add(this.streaming)
          return [{ sessionId, type: 'message', role: 'thought', text: delta['thinking'] as string }]
        }
        return []
      }
      case 'assistant': {
        const message = obj(m['message']) ?? {}
        const id = str(message['id'])
        const events: AgentEvent[] = []
        for (const raw of arr(message['content'])) {
          const b = obj(raw)
          if (!b) continue
          if (b['type'] === 'tool_use' && str(b['id']) && str(b['name'])) {
            const { title, detail } = describeTool(b['name'] as string, obj(b['input']) ?? {})
            events.push({ sessionId, type: 'tool', toolCallId: b['id'] as string, title, detail: detail || undefined, kind: toolKind(b['name'] as string), status: 'in_progress' })
          } else if (b['type'] === 'text' && str(b['text']) && !(id && this.streamed.has(id))) {
            // Text that did not stream (a synthetic answer such as a usage-limit message).
            events.push({ sessionId, type: 'message', role: 'agent', text: b['text'] as string })
          }
        }
        const model = str(message['model'])
        if (model && model !== '<synthetic>') events.push({ sessionId, type: 'monitor', snapshot: { model } })
        // A usage or rate limit: the SDK flags it (`error: 'rate_limit'`) or Claude Code answers with a synthetic message.
        const text = arr(message['content']).map((b) => str(obj(b)?.['text']) ?? '').join('\n')
        if (m['error'] === 'rate_limit' || (model === '<synthetic>' && isUsageLimitText(text))) events.push(this.usageLimit(text))
        return events
      }
      case 'user': {
        const message = obj(m['message']) ?? {}
        return arr(message['content']).flatMap((raw): AgentEvent[] => {
          const b = obj(raw)
          const id = str(b?.['tool_use_id'])
          if (b?.['type'] !== 'tool_result' || !id) return []
          return [{ sessionId, type: 'tool', toolCallId: id, status: b['is_error'] === true ? 'failed' : 'completed' }]
        })
      }
      case 'system':
        return this.system(m)
      case 'rate_limit_event': {
        const info = obj(m['rate_limit_info'])
        const w = rateLimitWindow(info)
        const events: AgentEvent[] = []
        if (w) {
          this.windows.set(w.window, w)
          events.push({ sessionId, type: 'monitor', snapshot: { planUsage: [...this.windows.values()] } })
        }
        const limit = rejectedLimit(info)
        if (limit) events.push({ sessionId, type: 'usageLimit', ...limit })
        return events
      }
      default:
        return []
    }
  }

  private system(m: Obj): AgentEvent[] {
    const sessionId = this.sessionId
    switch (m['subtype']) {
      case 'init': {
        const events: AgentEvent[] = []
        const mode = str(m['permissionMode'])
        if (mode) events.push({ sessionId, type: 'permissionMode', mode: claudePermissionMode(mode), currentModeId: mode })
        const snapshot: SessionMonitorSnapshot = {}
        const model = str(m['model'])
        if (model) snapshot.model = model
        if (Object.keys(snapshot).length) events.push({ sessionId, type: 'monitor', snapshot })
        return events
      }
      case 'hook_response': {
        // A hook's own output (context it adds, a block reason): shown apart from Claude's reply.
        const text = [str(m['output']), str(m['stdout']), str(m['stderr'])].find(Boolean) ?? ''
        const failed = m['outcome'] === 'error'
        if (!text.trim() && !failed) return []
        const event = str(m['hook_event']) ?? 'Hook'
        const name = str(m['hook_name'])
        return [this.notice('hook', name && name !== event ? `${event} · ${name}` : event, text.trim(), failed)]
      }
      case 'informational': {
        const content = str(m['content'])
        if (!content) return []
        const level = m['level']
        return [this.notice(level === 'warning' ? 'warning' : 'info', 'Claude Code', content)]
      }
      case 'compact_boundary':
        return [this.notice('info', 'Claude Code', 'The conversation was compacted.')]
      default:
        return []
    }
  }

  private usageLimit(text: string): AgentEvent {
    const resetsAt = limitResetFromText(text)
    return { sessionId: this.sessionId, type: 'usageLimit', ...(resetsAt !== undefined ? { resetsAt } : {}), ...(text.trim() ? { message: text.trim().slice(0, 500) } : {}) }
  }

  private notice(kind: 'hook' | 'info' | 'warning', title: string, text: string, failed = false): AgentEvent {
    this.notices += 1
    return { sessionId: this.sessionId, type: 'notice', noticeId: `${this.sessionId}:${this.notices}`, kind, title, text, failed: failed || undefined }
  }
}

/** The stop reason a `result` line ends a prompt with. */
export function resultStopReason(result: Obj, cancelled: boolean): string {
  if (cancelled) return 'cancelled'
  return result['subtype'] === 'success' && result['is_error'] !== true ? 'end_turn' : (str(result['subtype']) ?? 'error')
}
