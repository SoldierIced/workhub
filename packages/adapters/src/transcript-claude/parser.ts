/**
 * Parsers of Claude Code transcripts (`<config>/projects/<folder>/<session>.jsonl` and the
 * session's `subagents/agent-<id>.jsonl`). Pure: lines in, monitor data out, so they run against
 * small synthetic fixtures. Ported from Workhub 1's `TranscriptReader` and `SubagentParser`.
 * The format is internal to Claude Code: every field is optional and unknown lines are skipped.
 */
import type { SessionMonitorSnapshot, SubagentSummary, TokenUsage, ToolCallSummary } from '@workhub/core'
import { contextWindow, describeTool, estimateCost, isJiraTool, pullRequestUrls, ticketKeys, toolKind } from '../shared/claude-tools'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function time(v: unknown, fallback: number): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isNaN(t) ? fallback : t
}

function parseLine(line: string): Obj | undefined {
  try {
    return obj(JSON.parse(line))
  } catch {
    return undefined
  }
}

function usageOf(message: Obj): TokenUsage | undefined {
  const u = obj(message['usage'])
  if (!u) return undefined
  return {
    input: int(u['input_tokens']),
    output: int(u['output_tokens']),
    cacheRead: int(u['cache_read_input_tokens']),
    cacheWrite: int(u['cache_creation_input_tokens'])
  }
}

export function sumTokens(list: Iterable<TokenUsage>): TokenUsage {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const u of list) {
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.cacheRead += u.cacheRead ?? 0
    t.cacheWrite += u.cacheWrite ?? 0
  }
  t.total = t.input + t.output + t.cacheRead + t.cacheWrite
  return t
}

/** Text of a tool result: a string, or the text parts of a content list. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((p) => str(obj(p)?.['text']) ?? '')
    .join('\n')
}

const STEP_LIMIT = 40
const KEY_LIMIT = 200

export interface ClaudeTranscriptOptions {
  /** Ticket project keys to look for; any key-like text in commands and prompts when empty. */
  ticketPrefixes?: readonly string[]
  /** The clock, for entries without a timestamp. */
  now?: () => number
}

/** The main conversation of one session. Feed it lines in order; `snapshot()` any time. */
export class ClaudeTranscriptParser {
  private model: string | undefined
  private readonly usage = new Map<string, TokenUsage>()
  private contextTokens = 0
  private readonly steps: ToolCallSummary[] = []
  private customTitle: string | undefined
  private aiTitle: string | undefined
  private readonly prs: string[] = []
  private readonly keys: string[] = []
  private readonly jiraCalls = new Set<string>()
  private closedTurnsMs = 0
  private turnStart: number | undefined
  private turnLast: number | undefined
  private permissionMode: string | undefined
  /** Folder of the session (its first entries' `cwd`). */
  folder: string | undefined

  constructor(private readonly options: ClaudeTranscriptOptions = {}) {}

  ingest(line: string): void {
    const entry = parseLine(line)
    if (!entry) return
    const type = entry['type']
    if (type === 'custom-title') this.customTitle = str(entry['customTitle']) ?? this.customTitle
    if (type === 'ai-title') this.aiTitle = str(entry['aiTitle']) ?? this.aiTitle
    if (type === 'permission-mode') this.permissionMode = str(entry['permissionMode']) ?? this.permissionMode
    if (entry['isSidechain'] === true || (type !== 'assistant' && type !== 'user')) return
    const message = obj(entry['message'])
    if (!message) return
    const at = time(entry['timestamp'], this.options.now?.() ?? Date.now())
    this.folder ??= str(entry['cwd'])
    const branch = str(entry['gitBranch'])
    if (branch) this.noteKeys(branch)
    const content = arr(message['content']).map(obj).filter((b): b is Obj => !!b)

    if (type === 'assistant') {
      const model = str(message['model'])
      if (model && model !== '<synthetic>') this.model = model
      const id = str(message['id'])
      const usage = usageOf(message)
      if (id && usage) {
        // A streamed message repeats its usage on every block it writes.
        this.usage.set(id, usage)
        this.contextTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      }
      if (this.options.ticketPrefixes?.length) {
        for (const b of content) if (b['type'] === 'text') this.noteKeys(str(b['text']) ?? '')
      }
      for (const b of content) {
        if (b['type'] !== 'tool_use') continue
        const callId = str(b['id'])
        const tool = str(b['name'])
        if (!callId || !tool) continue
        const input = obj(b['input']) ?? {}
        const { title, detail } = describeTool(tool, input)
        const raw = JSON.stringify(input)
        this.notePrs(raw)
        if (tool === 'Bash') this.noteKeys(str(input['command']) ?? '')
        if (isJiraTool(tool)) {
          this.jiraCalls.add(callId)
          this.noteKeys(raw)
        }
        this.steps.push({ id: callId, title, detail: detail || undefined, kind: toolKind(tool), status: 'in_progress', startedAt: at })
      }
      if (this.steps.length > STEP_LIMIT) this.steps.splice(0, this.steps.length - STEP_LIMIT)
      this.touchTurn(at)
      return
    }

    // A prompt typed by the user (plain text, no tool results) starts a new turn.
    const isPrompt =
      entry['isMeta'] !== true &&
      (typeof message['content'] === 'string' || (content.length > 0 && !content.some((b) => b['type'] === 'tool_result')))
    if (isPrompt) {
      const text =
        typeof message['content'] === 'string'
          ? message['content']
          : content
              .filter((b) => b['type'] === 'text')
              .map((b) => str(b['text']) ?? '')
              .join(' ')
      // Slash commands Claude Code runs locally write user entries but no turn.
      if (!text.includes('<command-name>') && !text.includes('<local-command') && !text.startsWith('[Request interrupted')) {
        this.closeTurn()
        this.turnStart = at
        this.turnLast = at
        this.noteKeys(text)
      }
    }
    for (const b of content) {
      if (b['type'] !== 'tool_result') continue
      const callId = str(b['tool_use_id'])
      if (!callId) continue
      const text = resultText(b['content'])
      this.notePrs(text)
      // A Jira tool's result names the tickets it touched, e.g. a created issue's key.
      if (this.jiraCalls.delete(callId)) this.noteKeys(text)
      const step = this.steps.findLast((s) => s.id === callId)
      if (step) {
        step.status = b['is_error'] === true ? 'failed' : 'completed'
        step.endedAt = at
      }
    }
    if (!isPrompt) this.touchTurn(at)
  }

  /** Tool-use ids of the parent's Agent/Task calls and whether each has its result. */
  parentCalls(): Map<string, { done: boolean; failed: boolean }> {
    return new Map(this.steps.map((s) => [s.id, { done: s.status === 'completed' || s.status === 'failed', failed: s.status === 'failed' }]))
  }

  snapshot(): SessionMonitorSnapshot {
    const tokens = sumTokens(this.usage.values())
    const snap: SessionMonitorSnapshot = {
      toolCalls: this.steps.map((s) => ({ ...s })),
      activeTimeMs: this.activeMs()
    }
    const title = this.customTitle ?? this.aiTitle
    if (title) snap.title = title
    if (this.model) snap.model = this.model
    if (this.usage.size) {
      snap.tokens = tokens
      const cost = estimateCost(this.model, tokens)
      if (cost) snap.cost = cost
      const size = contextWindow(this.model, this.contextTokens)
      snap.context = { used: this.contextTokens, size, percent: (this.contextTokens / size) * 100 }
    }
    if (this.prs.length) snap.pullRequests = [...this.prs]
    if (this.keys.length) snap.ticketKeys = [...this.keys]
    return snap
  }

  /** The permission mode Claude Code recorded last (`permission-mode` entries). */
  lastPermissionMode(): string | undefined {
    return this.permissionMode
  }

  private activeMs(): number {
    const open = this.turnStart !== undefined && this.turnLast !== undefined ? this.turnLast - this.turnStart : 0
    return this.closedTurnsMs + Math.max(0, open)
  }

  private touchTurn(at: number): void {
    if (this.turnStart !== undefined) this.turnLast = Math.max(this.turnLast ?? at, at)
  }

  private closeTurn(): void {
    if (this.turnStart !== undefined && this.turnLast !== undefined) this.closedTurnsMs += Math.max(0, this.turnLast - this.turnStart)
    this.turnStart = undefined
    this.turnLast = undefined
  }

  private notePrs(text: string): void {
    for (const url of pullRequestUrls(text)) if (!this.prs.includes(url)) this.prs.push(url)
  }

  /** Keeps the order of last mention; only the most recent keys are kept. */
  private noteKeys(text: string): void {
    const found = ticketKeys(text, this.options.ticketPrefixes)
    for (const key of found) {
      const i = this.keys.indexOf(key)
      if (i >= 0) this.keys.splice(i, 1)
      this.keys.push(key)
    }
    if (this.keys.length > KEY_LIMIT) this.keys.splice(0, this.keys.length - KEY_LIMIT)
  }
}

/** `agent-<id>.meta.json` next to a subagent transcript. */
export interface SubagentMeta {
  agentType?: string
  description?: string
  model?: string
  toolUseId?: string
}

export function parseSubagentMeta(text: string): SubagentMeta {
  const json = parseLine(text) ?? {}
  return { agentType: str(json['agentType']), description: str(json['description']), model: str(json['model']), toolUseId: str(json['toolUseId']) }
}

/** One subagent transcript: totals and the last step, for the monitor. */
export class SubagentParser {
  private readonly usage = new Map<string, TokenUsage>()
  model: string | undefined
  startedAt: number | undefined
  lastActivityAt: number | undefined
  lastStep: string | undefined
  stepCount = 0
  /** The last assistant message ended its turn: the subagent returned its answer. */
  isTerminal = false

  constructor(private readonly now: () => number = Date.now) {}

  ingest(line: string): void {
    const entry = parseLine(line)
    const type = entry?.['type']
    const message = obj(entry?.['message'])
    if (!entry || !message || (type !== 'assistant' && type !== 'user')) return
    const at = time(entry['timestamp'], this.now())
    this.startedAt ??= at
    this.lastActivityAt = at
    if (type === 'user') {
      this.isTerminal = false
      return
    }
    const model = str(message['model'])
    if (model && model !== '<synthetic>') this.model = model
    const id = str(message['id'])
    const usage = usageOf(message)
    if (id && usage) this.usage.set(id, usage)
    // A streamed message is written one block per record; only the last carries the stop reason.
    this.isTerminal = message['stop_reason'] === 'end_turn'
    for (const raw of arr(message['content'])) {
      const b = obj(raw)
      if (b?.['type'] !== 'tool_use' || !str(b['name'])) continue
      this.stepCount += 1
      this.lastStep = describeTool(str(b['name'])!, obj(b['input']) ?? {}).title
      this.isTerminal = false
    }
  }

  tokens(): TokenUsage {
    return sumTokens(this.usage.values())
  }
}

export type SubagentStatus = 'running' | 'background' | 'completed' | 'failed' | 'stopped'

/**
 * Running or not, from three signals (Claude Code writes no "finished" marker; Workhub 1's rule):
 * an `end_turn` answer means done; a parent call still waiting means a foreground agent at work
 * (silent tools are normal, so 10 minutes of silence mean stopped); a parent that moved on means a
 * background agent (2 minutes of silence mean stopped). Without parent data, 30 s of silence.
 */
export function subagentStatus(isTerminal: boolean, silentForMs: number, parent: { done: boolean; failed: boolean } | undefined): SubagentStatus {
  if (isTerminal) return parent?.failed ? 'failed' : 'completed'
  if (!parent) return silentForMs < 30_000 ? 'running' : 'stopped'
  if (!parent.done) return silentForMs < 600_000 ? 'running' : 'stopped'
  return silentForMs < 120_000 ? 'background' : 'stopped'
}

export function subagentSummary(
  id: string,
  meta: SubagentMeta,
  parser: SubagentParser,
  status: SubagentStatus,
  fallbackModel: string | undefined
): SubagentSummary {
  const model = parser.model ?? meta.model
  const tokens = parser.tokens()
  const summary: SubagentSummary = {
    id,
    name: meta.description ?? meta.agentType ?? id,
    status,
    type: meta.agentType ?? 'general-purpose',
    tokens,
    stepCount: parser.stepCount
  }
  if (meta.description) summary.description = meta.description
  if (meta.toolUseId) summary.toolUseId = meta.toolUseId
  if (model) summary.model = model
  const cost = estimateCost(model ?? fallbackModel, tokens)
  if (cost) summary.cost = cost
  if (parser.lastStep) summary.lastStep = parser.lastStep
  if (parser.startedAt !== undefined) summary.startedAt = parser.startedAt
  if (parser.lastActivityAt !== undefined) summary.lastActivityAt = parser.lastActivityAt
  return summary
}
