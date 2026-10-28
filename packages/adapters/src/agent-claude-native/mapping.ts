/**
 * Maps the bridge's lines (Workhub 1's protocol, see `bridge/bridge.mjs`) to Workhub agent events.
 * Pure apart from the id counter, so it is tested against recorded-shape fixtures.
 */
import {
  CLAUDE_BUILTIN_COMMANDS,
  isUnattendedMode,
  readSlashCommand,
  isUsageLimitText,
  limitResetFromText,
  type AgentEvent,
  type McpServerState,
  type McpServerStatus,
  type ModelOption,
  type PermissionModeInfo,
  type PermissionOption,
  type PlanUsageWindow,
  type SessionModeOption,
  type SessionMonitorSnapshot,
  type SlashCommandInfo
} from '@workhub/core'
import { claudeToolResult, claudeToolView } from '../shared/claude-tool-view'
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

/** Descriptions of Claude Code's permission modes, as its docs word them. */
const MODE_DESCRIPTION: Record<string, string> = {
  default: 'Asks before file edits and commands',
  acceptEdits: 'Edits files without asking; asks before commands',
  plan: 'Reads and plans; changes nothing',
  auto: 'Decides itself which actions need asking',
  dontAsk: 'Never asks: denies what is not allowed in settings',
  bypassPermissions: 'Runs every tool without asking'
}

/**
 * The permission modes a Claude Code session can start in or switch to (Settings → Agents, the
 * session header's picker), in the order the pickers list them.
 */
export const CLAUDE_PERMISSION_MODES: readonly SessionModeOption[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].map((id) => ({
  id,
  name: MODE_LABEL[id]!,
  description: MODE_DESCRIPTION[id]!
}))

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

/** The notice `/clear` leaves in the chat; the app shows it in the reader's language. */
export const CLEARED_TEXT = 'The conversation was cleared.'

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

/** What a local command (`/cost`, `/context`) printed, without the terminal's colors and Claude Code's wrapper tags. */
export function localCommandText(content: string): string {
  return content
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/<\/?local-command-(stdout|stderr)>/g, '')
    .trim()
}

const CLAUDE_BUILTIN_NAMES = new Set(CLAUDE_BUILTIN_COMMANDS.map((c) => c.name))

/**
 * The session's slash commands from what Claude Code reported: `rows` are the SDK's `SlashCommand`s
 * (with descriptions), `names` the init message's `slash_commands`, `skills` its skill names.
 * Claude's own commands (marked `builtin`, or known built-ins from a CLI that does not mark them) are
 * the agent's; the rest are skills and custom commands (user, project, plugin, MCP). Commands bound
 * to the terminal (`terminal_slash_commands`) are left out: the chat cannot run them.
 */
export function claudeSlashCommands(rows: readonly unknown[], names: readonly string[], skills: ReadonlySet<string>, terminalOnly: ReadonlySet<string>): SlashCommandInfo[] {
  const marked = rows.some((r) => typeof obj(r)?.['builtin'] === 'boolean')
  const isBuiltin = (name: string, row?: Obj) => !skills.has(name) && (marked ? row?.['builtin'] === true : CLAUDE_BUILTIN_NAMES.has(name))
  const out = new Map<string, SlashCommandInfo>()
  for (const raw of rows) {
    const read = readSlashCommand(raw, 'agent')
    if (!read || terminalOnly.has(read.name) || out.has(read.name)) continue
    out.set(read.name, { ...read, group: isBuiltin(read.name, obj(raw)) ? 'agent' : 'skill' })
  }
  for (const name of names) {
    if (out.has(name) || terminalOnly.has(name) || !name || /\s/.test(name)) continue
    const known = CLAUDE_BUILTIN_COMMANDS.find((c) => c.name === name)
    out.set(name, known && !skills.has(name) ? known : { name, group: isBuiltin(name) ? 'agent' : 'skill' })
  }
  return [...out.values()]
}

/** One session's mapping state: which assistant messages already streamed their text. */
export class ClaudeBridgeMapper {
  private readonly streamed = new Set<string>()
  /** Tool name per call id, to read each result the way its tool writes it. */
  private readonly toolNames = new Map<string, string>()
  private streaming: string | undefined
  private notices = 0
  private readonly permissions = new Map<string, { input: unknown; suggestions: unknown }>()
  /** Last plan windows reported, by window name. */
  private readonly windows = new Map<string, PlanUsageWindow>()
  /** What Claude Code reported of its slash commands so far (see `claudeSlashCommands`). */
  private commandRows: unknown[] = []
  private commandNames: string[] = []
  private skills = new Set<string>()
  private terminalOnly = new Set<string>()

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
        // No mode in the settings is Claude's own default mode, so the header's picker shows one.
        const defaults = obj(line['defaults'])
        const mode = str(defaults?.['permissionMode']) ?? (defaults ? 'default' : undefined)
        if (mode) events.push({ sessionId, type: 'permissionMode', mode: claudePermissionMode(mode), currentModeId: mode })
        if (Array.isArray(line['commands'])) {
          this.commandRows = line['commands']
          events.push(this.commandsEvent())
        }
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
            const name = b['name'] as string
            const input = obj(b['input']) ?? {}
            const { title, detail } = describeTool(name, input)
            this.toolNames.set(b['id'] as string, name)
            events.push({
              sessionId,
              type: 'tool',
              toolCallId: b['id'] as string,
              title,
              detail: detail || undefined,
              kind: toolKind(name),
              status: 'in_progress',
              view: claudeToolView(name, input)
            })
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
        const blocks = arr(message['content'])
        // The structured result belongs to the message's only tool result; with several it is ambiguous.
        const extra = blocks.filter((b) => obj(b)?.['type'] === 'tool_result').length === 1 ? m['tool_use_result'] : undefined
        return blocks.flatMap((raw): AgentEvent[] => {
          const b = obj(raw)
          const id = str(b?.['tool_use_id'])
          if (b?.['type'] !== 'tool_result' || !id) return []
          const failed = b['is_error'] === true
          const name = this.toolNames.get(id)
          this.toolNames.delete(id)
          const event: AgentEvent = { sessionId, type: 'tool', toolCallId: id, status: failed ? 'failed' : 'completed' }
          if (name) event.result = claudeToolResult(name, b['content'], failed, extra)
          return [event]
        })
      }
      case 'system':
        return this.system(m)
      case 'conversation_reset':
        // `/clear` (or leaving plan mode with a fresh context): the runtime follows the new session id.
        return [this.notice('info', 'Claude Code', CLEARED_TEXT)]
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
        if (Array.isArray(m['slash_commands'])) {
          const names = (v: unknown) => arr(v).filter((n): n is string => typeof n === 'string')
          this.commandNames = names(m['slash_commands'])
          this.skills = new Set(names(m['skills']))
          this.terminalOnly = new Set(names(m['terminal_slash_commands']))
          events.push(this.commandsEvent())
        }
        return events
      }
      case 'commands_changed':
        if (!Array.isArray(m['commands'])) return []
        this.commandRows = m['commands']
        return [this.commandsEvent()]
      case 'local_command_output': {
        // A local command's output (`/cost`, `/context`): Claude Code shows it as its reply.
        const text = localCommandText(str(m['content']) ?? '')
        return text ? [{ sessionId, type: 'message', role: 'agent', text }] : []
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

  private commandsEvent(): AgentEvent {
    return { sessionId: this.sessionId, type: 'commands', commands: claudeSlashCommands(this.commandRows, this.commandNames, this.skills, this.terminalOnly) }
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

/**
 * Which prompts a `result` answers, by the uuids the app stamped on them (oldest first in
 * `pending`). Claude Code folds a message sent during a turn into that turn between tool rounds,
 * or runs it as the next turn: `user_message_uuids` lists every prompt the turn consumed and
 * `queued_turn_count` the sends still waiting. Prompts up to the last consumed one are settled;
 * the session stays busy while later ones wait for their own turn. A result without uuids (an
 * older CLI) settles every prompt, as before.
 */
export function settleResult(pending: readonly string[], result: Obj): { settled: string[]; stillBusy: boolean } {
  const uuids = Array.isArray(result['user_message_uuids'])
    ? result['user_message_uuids'].filter((u): u is string => typeof u === 'string')
    : typeof result['user_message_uuid'] === 'string'
      ? [result['user_message_uuid']]
      : null
  const queued = typeof result['queued_turn_count'] === 'number' ? result['queued_turn_count'] : 0
  if (!uuids || queued <= 0) return { settled: [...pending], stillBusy: false }
  const last = Math.max(-1, ...uuids.map((u) => pending.indexOf(u)))
  const settled = pending.slice(0, last + 1)
  return { settled, stillBusy: pending.length > settled.length }
}
