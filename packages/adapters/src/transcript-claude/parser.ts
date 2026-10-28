/**
 * Parsers of Claude Code transcripts (`<config>/projects/<folder>/<session>.jsonl` and the
 * session's `subagents/agent-<id>.jsonl`). Pure: lines in, monitor data out, so they run against
 * small synthetic fixtures. Ported from Workhub 1's `TranscriptReader` and `SubagentParser`.
 * The format is internal to Claude Code: every field is optional and unknown lines are skipped.
 */
import { homedir } from 'node:os'
import { noteWorkPath, toolWorkPaths, type SessionMonitorSnapshot, type SessionPullRequestLink, type SubagentSummary, type TokenUsage, type ToolCallSummary } from '@workhub/core'
import { contextWindow, describeTool, estimateCost, pullRequestNumbers, pullRequestUrls, ticketKeys, toolKind } from '../shared/claude-tools'
import { noteLink, SessionLinks } from './session-links'

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
/** A final reply that names more tickets or PRs than this lists other work (a search, a backlog), not the session's. */
const REPLY_NAMES_LIMIT = 3

/**
 * The part of a prompt the user typed. Claude Code writes other text as user entries too: a
 * background task's result (`<task-notification>`), reminders, the output of a local command or
 * of a `!` shell command. Of a slash command, only its arguments are the user's.
 */
function typedText(text: string): string {
  return text
    .replace(/<(task-notification|system-reminder|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|command-name|command-message)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?command-args>/g, ' ')
}

/** Workhub's own prompt carrying replies from a tracked Slack thread (`wakeText`): Slack's words, not the user's. */
const SLACK_WAKE = /^New reply in the tracked Slack thread /

export interface ClaudeTranscriptOptions {
  /** Ticket project keys to look for; any key-like text in commands and prompts when empty. */
  ticketPrefixes?: readonly string[]
  /** The clock, for entries without a timestamp. */
  now?: () => number
  /** The home folder `~/` paths of commands resolve from; the user's by default. */
  home?: string
}

/** The main conversation of one session. Feed it lines in order; `snapshot()` any time. */
export class ClaudeTranscriptParser {
  private model: string | undefined
  private readonly usage = new Map<string, TokenUsage>()
  private contextTokens = 0
  private readonly steps: ToolCallSummary[] = []
  private customTitle: string | undefined
  private aiTitle: string | undefined
  /** The PRs the user named and the ones the agent's final replies named; the ones it acted on are in `links`. */
  private readonly named: SessionPullRequestLink[] = []
  /** Ticket keys the user typed, in order of last mention. */
  private readonly keys: string[] = []
  /** Ticket keys the agent's final replies named, in order of last mention. */
  private readonly replyKeys: string[] = []
  /** The text the agent wrote since its last tool call in this turn: its final reply so far. */
  private reply = ''
  private readonly links: SessionLinks
  private closedTurnsMs = 0
  /** Ids of the assistant messages of the current turn, in order. */
  private turnMessages: string[] = []
  private turnStart: number | undefined
  private turnLast: number | undefined
  private permissionMode: string | undefined
  /** The folders the session worked in, most recent last (see `toolWorkPaths`). */
  private readonly workPaths: string[] = []
  /** The `cwd` of the latest entry: where its commands run. */
  private cwd: string | undefined
  /** Folder of the session (its first entries' `cwd`). */
  folder: string | undefined

  constructor(private readonly options: ClaudeTranscriptOptions = {}) {
    this.links = new SessionLinks(options.ticketPrefixes, options.home ?? homedir())
  }

  ingest(line: string): void {
    const entry = parseLine(line)
    if (!entry) return
    const type = entry['type']
    if (type === 'custom-title') {
      this.customTitle = str(entry['customTitle']) ?? this.customTitle
      // A title the user gave the session is theirs, like a prompt.
      this.noteKeys(this.keys, this.customTitle ?? '')
    }
    if (type === 'ai-title') this.aiTitle = str(entry['aiTitle']) ?? this.aiTitle
    if (type === 'permission-mode') this.permissionMode = str(entry['permissionMode']) ?? this.permissionMode
    if (entry['isSidechain'] === true || (type !== 'assistant' && type !== 'user')) return
    const message = obj(entry['message'])
    if (!message) return
    const at = time(entry['timestamp'], this.options.now?.() ?? Date.now())
    const cwd = str(entry['cwd'])
    this.folder ??= cwd
    if (cwd && cwd !== this.cwd) {
      this.cwd = cwd
      noteWorkPath(this.workPaths, cwd)
    }
    const content = arr(message['content']).map(obj).filter((b): b is Obj => !!b)

    if (type === 'assistant') {
      const model = str(message['model'])
      if (model && model !== '<synthetic>') this.model = model
      const id = str(message['id'])
      const usage = usageOf(message)
      if (id && usage) {
        // A streamed message repeats its usage on every block it writes.
        this.usage.set(id, usage)
        if (!this.turnMessages.includes(id)) this.turnMessages.push(id)
        this.contextTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      }
      for (const b of content) {
        if (b['type'] === 'text') this.reply += `${str(b['text']) ?? ''}\n`
        if (b['type'] !== 'tool_use') continue
        this.reply = ''
        const callId = str(b['id'])
        const tool = str(b['name'])
        if (!callId || !tool) continue
        const input = obj(b['input']) ?? {}
        const { title, detail } = describeTool(tool, input)
        if (tool === 'Bash') noteWorkPath(this.workPaths, this.cwd)
        for (const path of toolWorkPaths(tool, input, this.cwd, this.options.home ?? homedir())) noteWorkPath(this.workPaths, path)
        this.links.call(callId, tool, input, this.cwd)
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
      // Slash commands Claude Code runs locally write user entries but no turn; their arguments are typed by the user.
      if (text.includes('<command-name>')) this.noteTyped(typedText(text))
      else if (!text.includes('<local-command') && !text.startsWith('[Request interrupted')) {
        this.closeTurn()
        this.turnMessages = []
        this.turnStart = at
        this.turnLast = at
        if (!SLACK_WAKE.test(text)) this.noteTyped(typedText(text))
      }
    }
    for (const b of content) {
      if (b['type'] !== 'tool_result') continue
      const callId = str(b['tool_use_id'])
      if (!callId) continue
      // A tool's output is never the session's work by itself (a listing, a file, a search): only what the call acted on.
      this.links.result(callId, resultText(b['content']), b['is_error'] === true)
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
      const requests = this.turnMessages.map((id) => this.usage.get(id)).filter((u): u is TokenUsage => !!u).map((u) => (u.input ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0))
      if (requests.length) snap.turnRequests = requests
      const cost = estimateCost(this.model, tokens)
      if (cost) snap.cost = cost
      const size = contextWindow(this.model, this.contextTokens)
      snap.context = { used: this.contextTokens, size, percent: (this.contextTokens / size) * 100 }
    }
    const replyKeys = [...this.replyKeys]
    // The ones it acted on, then the ones only named (a PR acted on and named is listed once, as acted on).
    const links: SessionPullRequestLink[] = this.links.prs.map((l) => ({ ...l }))
    for (const l of this.named) noteLink(links, { ...l })
    // The reply being written counts as it stands; it is kept once the turn ends.
    this.noteReply(this.reply, replyKeys, links)
    if (links.length) {
      snap.pullRequestLinks = links
      const urls = links.map((l) => l.url).filter((u): u is string => !!u)
      if (urls.length) snap.pullRequests = urls
    }
    if (this.keys.length) snap.ticketKeys = [...this.keys]
    if (replyKeys.length) snap.replyTicketKeys = replyKeys
    const linked = this.links.linkedTickets()
    if (linked.length) snap.linkedTicketKeys = linked
    if (this.links.branches.length) snap.branches = this.links.branches.map((b) => ({ ...b }))
    if (this.workPaths.length) snap.workPaths = [...this.workPaths]
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
    this.noteReply(this.reply, this.replyKeys, this.named)
    this.reply = ''
    if (this.turnStart !== undefined && this.turnLast !== undefined) this.closedTurnsMs += Math.max(0, this.turnLast - this.turnStart)
    this.turnStart = undefined
    this.turnLast = undefined
  }

  /** What the user typed: its ticket keys, PR URLs and PRs by number. */
  private noteTyped(text: string): void {
    this.noteKeys(this.keys, text)
    for (const url of pullRequestUrls(text)) noteLink(this.named, { source: 'user', url })
    for (const pr of pullRequestNumbers(text)) noteLink(this.named, { source: 'user', number: pr.number, ...(pr.repo ? { repo: pr.repo } : {}) })
  }

  /**
   * The tickets and PR URLs of an agent's final reply, when it names a few: more is a listing. Keys
   * of any project are too loose in free text, so replies count only with the tracker's projects.
   */
  private noteReply(text: string, keys: string[], links: SessionPullRequestLink[]): void {
    if (!text.trim()) return
    const found = this.options.ticketPrefixes?.length ? ticketKeys(text, this.options.ticketPrefixes) : []
    if (found.length <= REPLY_NAMES_LIMIT) this.noteKeys(keys, found.join(' '))
    const urls = pullRequestUrls(text)
    if (urls.length <= REPLY_NAMES_LIMIT) for (const url of urls) noteLink(links, { source: 'reply', url })
  }

  /** Keeps the order of last mention; only the most recent keys are kept. */
  private noteKeys(list: string[], text: string): void {
    for (const key of ticketKeys(text, this.options.ticketPrefixes)) {
      const i = list.indexOf(key)
      if (i >= 0) list.splice(i, 1)
      list.push(key)
    }
    if (list.length > KEY_LIMIT) list.splice(0, list.length - KEY_LIMIT)
  }

  /** The PRs, tickets and branches this conversation acted on, to merge its subagents' into. */
  actions(): SessionLinks {
    return this.links
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
  /** The folders the subagent worked in, most recent last (see `toolWorkPaths`). */
  readonly workPaths: string[] = []
  /** The PRs, tickets and branches the subagent changed: the session's work too (its reads are research). */
  readonly links: SessionLinks
  private cwd: string | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly home: string = homedir(),
    ticketPrefixes?: readonly string[]
  ) {
    this.links = new SessionLinks(ticketPrefixes, home, false)
  }

  ingest(line: string): void {
    const entry = parseLine(line)
    const type = entry?.['type']
    const message = obj(entry?.['message'])
    if (!entry || !message || (type !== 'assistant' && type !== 'user')) return
    const at = time(entry['timestamp'], this.now())
    this.startedAt ??= at
    this.lastActivityAt = at
    this.cwd = str(entry['cwd']) ?? this.cwd
    if (type === 'user') {
      this.isTerminal = false
      for (const raw of arr(message['content'])) {
        const b = obj(raw)
        const callId = str(b?.['tool_use_id'])
        if (b?.['type'] === 'tool_result' && callId) this.links.result(callId, resultText(b['content']), b['is_error'] === true)
      }
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
      const input = obj(b['input']) ?? {}
      this.lastStep = describeTool(str(b['name'])!, input).title
      this.isTerminal = false
      for (const path of toolWorkPaths(str(b['name']), input, this.cwd, this.home)) noteWorkPath(this.workPaths, path)
      const callId = str(b['id'])
      if (callId) this.links.call(callId, str(b['name'])!, input, this.cwd)
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
