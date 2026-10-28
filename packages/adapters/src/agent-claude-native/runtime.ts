/**
 * AgentRuntime for Claude Code through the Claude Agent SDK (PLAN D8): one Workhub 1 bridge
 * process (`bridge/bridge.mjs`, Node) per session, one JSON object per line each way. The SDK
 * drives the user's own `claude`, so their settings, hooks, skills and MCP servers apply.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isUsageLimitText, limitResetFromText } from '@workhub/core'
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentEventListener,
  AgentRuntime,
  ImageInput,
  ModelOption,
  PromptResult,
  SessionControls,
  SessionModeControl,
  StartedSession,
  StartSessionRequest,
  Unsubscribe
} from '@workhub/core'
import { pathKeyOf } from '../shared/login-path'
import { CLAUDE_PERMISSION_MODES, ClaudeBridgeMapper, claudePermissionMode, permissionResult, resultStopReason, settleResult } from './mapping'

/** The permission modes Claude Code starts in; any other mode id (an ACP agent's) is ignored. */
const CLAUDE_MODES: ReadonlySet<string> = new Set(CLAUDE_PERMISSION_MODES.map((m) => m.id))

export interface ClaudeNativeRuntimeOptions {
  /** Folder holding `bridge.mjs` and `sessions.mjs`. */
  bridgeDir: string
  /** The bridge script, relative to `bridgeDir` (tests use a fake bridge). */
  bridgeScript?: string
  /**
   * Node to run the bridge with. Defaults to the running executable, which in Electron runs as
   * plain Node with ELECTRON_RUN_AS_NODE, so users need no Node install of their own.
   */
  nodeCommand?: string
  /** How long a stopping bridge gets to end Claude cleanly (it runs SessionEnd hooks) before it is killed. */
  stopTimeoutMs?: number
  /**
   * The PATH a session starts with (the login shell's, see shared/login-path.ts), read at each
   * start; the process PATH when unset or when it returns undefined.
   */
  path?: () => string | undefined
}

interface Pending {
  /** The uuid stamped on the prompt, so a result can tell which prompts it answers. */
  uuid: string
  resolve: (r: PromptResult) => void
  reject: (e: Error) => void
}

interface NativeSession {
  id: string
  agentSessionId: string
  child: ChildProcess
  mapper: ClaudeBridgeMapper
  pending: Pending[]
  cancelled: boolean
  stopping: boolean
  models: ModelOption[]
}

type Obj = Record<string, unknown>

export class ClaudeNativeRuntime implements AgentRuntime, SessionControls, SessionModeControl {
  readonly adapter = 'native' as const
  private readonly sessions = new Map<string, NativeSession>()
  private readonly listeners = new Set<AgentEventListener>()

  constructor(private readonly options: ClaudeNativeRuntimeOptions) {}

  capabilities(agent: AgentDefinition): AgentCapabilities {
    return agent.capabilities
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(req: StartSessionRequest): Promise<StartedSession> {
    const id = req.sessionId
    if (this.sessions.has(id)) throw new Error(`session ${id} already exists`)
    this.emit({ sessionId: id, type: 'state', state: 'starting' })
    const agentSessionId = req.agentSessionId ?? randomUUID()
    const basePath = this.options.path?.()
    const child = spawn(this.options.nodeCommand ?? process.execPath, [join(this.options.bridgeDir, this.options.bridgeScript ?? 'bridge.mjs')], {
      cwd: req.cwd,
      env: { ...process.env, ...(basePath ? { [pathKeyOf(process.env)]: basePath } : {}), ELECTRON_RUN_AS_NODE: '1', ...req.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const session: NativeSession = {
      id,
      agentSessionId,
      child,
      mapper: new ClaudeBridgeMapper(id),
      pending: [],
      cancelled: false,
      stopping: false,
      models: []
    }
    this.sessions.set(id, session)

    let markReady: () => void = () => {}
    let failStart: (e: Error) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failStart = reject
    })
    ready.catch(() => {})

    child.once('error', (err) => failStart(new Error(`could not start the Claude bridge: ${err.message}`)))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => d.split('\n').filter(Boolean).forEach((line) => this.emit({ sessionId: id, type: 'stderr', line })))
    createInterface({ input: child.stdout! }).on('line', (text) => {
      let line: Obj
      try {
        line = JSON.parse(text) as Obj
      } catch {
        return
      }
      if (line['type'] === 'ready') markReady()
      else if (line['type'] === 'error') failStart(new Error(String(line['message'] ?? 'the Claude bridge failed')))
      this.onLine(session, line)
    })
    child.on('exit', (code) => {
      failStart(new Error(`the Claude bridge exited during start (code ${code})`))
      this.finishPending(session, 'cancelled')
      this.emit({ sessionId: id, type: 'exit', code })
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id)
        const failed = !session.stopping && code !== 0
        this.emit({ sessionId: id, type: 'state', state: failed ? 'error' : 'stopped', error: failed ? `Claude exited (code ${code})` : undefined })
      }
    })

    this.send(session, {
      type: 'start',
      cwd: req.cwd,
      configDir: req.env['CLAUDE_CONFIG_DIR'],
      ...(req.resume ? { resume: agentSessionId } : { sessionId: agentSessionId }),
      ...(req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      // A reviewer: plan mode, and the edit tools refused outright. Else the mode asked for, when Claude has it.
      ...(req.readOnly ? { permissionMode: 'plan', readOnly: true } : req.modeId && CLAUDE_MODES.has(req.modeId) ? { permissionMode: req.modeId } : {})
    })
    try {
      await ready
    } catch (err) {
      await this.stop(id).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ sessionId: id, type: 'state', state: 'error', error: message })
      throw new Error(message)
    }
    this.emit({ sessionId: id, type: 'state', state: 'ready' })
    if (req.readOnly) return { agentSessionId, agentName: 'Claude Code', permissionMode: { id: 'plan', label: 'Plan (read-only)', source: 'workhub' } }
    // The modes it can switch to from the session header. The current one is the mode asked for,
    // else the settings' default, reported by the bridge once Claude has started.
    const asked = req.modeId && CLAUDE_MODES.has(req.modeId) ? req.modeId : undefined
    return {
      agentSessionId,
      agentName: 'Claude Code',
      permissionMode: asked ? claudePermissionMode(asked, 'workhub') : null,
      ...(asked ? { currentModeId: asked } : {}),
      availableModes: [...CLAUDE_PERMISSION_MODES]
    }
  }

  /** Switches the permission mode of a running session, as Shift+Tab does in the terminal. */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.require(sessionId)
    if (!CLAUDE_MODES.has(modeId)) throw new Error(`Claude Code has no permission mode "${modeId}"`)
    this.send(s, { type: 'set_permission_mode', mode: modeId })
    this.emit({ sessionId, type: 'permissionMode', mode: claudePermissionMode(modeId, 'workhub'), currentModeId: modeId })
  }

  /**
   * Sends a prompt. One sent while a turn runs goes in at priority `next`: Claude Code folds it
   * into the running turn between tool rounds (as a message typed in the terminal while Claude
   * works), or runs it as the next turn when the turn ends first.
   */
  async prompt(sessionId: string, text: string, images: ImageInput[] = []): Promise<PromptResult> {
    const s = this.require(sessionId)
    const midTurn = s.pending.length > 0
    if (!midTurn) s.cancelled = false
    this.emit({ sessionId, type: 'state', state: 'busy' })
    const uuid = randomUUID()
    const result = new Promise<PromptResult>((resolve, reject) => s.pending.push({ uuid, resolve, reject }))
    const stamp = { uuid, ...(midTurn ? { priority: 'next' } : {}) }
    if (images.length) {
      const content = [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...(text ? [{ type: 'text', text }] : [])
      ]
      this.send(s, { type: 'user', content, ...stamp })
    } else {
      this.send(s, { type: 'user', text, ...stamp })
    }
    return result
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.require(sessionId)
    s.cancelled = true
    this.send(s, { type: 'interrupt' })
  }

  respondPermission(sessionId: string, requestId: string, optionId: string | null): void {
    const s = this.sessions.get(sessionId)
    const request = s?.mapper.takePermission(requestId)
    if (!s || !request) return
    this.send(s, { type: 'permission', id: requestId, result: permissionResult(optionId, request.input, request.suggestions) })
  }

  async setModel(sessionId: string, modelId: string | null): Promise<void> {
    const s = this.require(sessionId)
    this.send(s, { type: 'set_model', model: modelId })
    this.emit({ sessionId, type: 'models', models: s.models, currentModelId: modelId ?? undefined })
  }

  refreshMcp(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) this.send(s, { type: 'mcp_status' })
  }

  reconnectMcp(sessionId: string, server: string): void {
    const s = this.sessions.get(sessionId)
    if (s) this.send(s, { type: 'mcp_reconnect', name: server })
  }

  toggleMcp(sessionId: string, server: string, enabled: boolean): void {
    const s = this.sessions.get(sessionId)
    if (s) this.send(s, { type: 'mcp_toggle', name: server, enabled })
  }

  /** Closes the bridge's input: it interrupts Claude, which exits on its own and runs its SessionEnd hooks. */
  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.stopping = true
    this.finishPending(s, 'cancelled')
    const child = s.child
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.sessions.delete(sessionId)
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, this.options.stopTimeoutMs ?? 8000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin?.end()
    })
    // Killed after the timeout: the exit may come later, and the session id must be free for the
    // engine that takes over (a hand-over starts it again at once).
    if (this.sessions.get(sessionId) === s) {
      this.sessions.delete(sessionId)
      this.emit({ sessionId, type: 'state', state: 'stopped' })
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  private onLine(s: NativeSession, line: Obj): void {
    const message = line['type'] === 'sdk' ? (line['message'] as Obj | undefined) : undefined
    // `/clear` gives the conversation a new session id and transcript: the session follows it, so
    // its monitor, its resume and its sidebar place keep pointing at the live conversation. Only
    // main-thread messages (the init and a turn's result) are trusted for it.
    const moved = message && (message['type'] === 'result' || (message['type'] === 'system' && message['subtype'] === 'init')) ? message['session_id'] : undefined
    if (typeof moved === 'string' && moved && moved !== s.agentSessionId) {
      s.agentSessionId = moved
      this.emit({ sessionId: s.id, type: 'agentSession', agentSessionId: moved })
    }
    if (message?.['type'] === 'result') {
      // A turn refused by a usage limit ends with an error result carrying Claude Code's message.
      const text = typeof message['result'] === 'string' ? message['result'] : ''
      if (message['is_error'] === true && isUsageLimitText(text)) {
        const resetsAt = limitResetFromText(text)
        this.emit({ sessionId: s.id, type: 'usageLimit', message: text.slice(0, 500), ...(resetsAt !== undefined ? { resetsAt } : {}) })
      }
      const { settled, stillBusy } = settleResult(
        s.pending.map((p) => p.uuid),
        message
      )
      const stopReason = resultStopReason(message, s.cancelled)
      for (const p of s.pending.filter((p) => settled.includes(p.uuid))) p.resolve({ stopReason })
      s.pending = s.pending.filter((p) => !settled.includes(p.uuid))
      s.cancelled = false
      // A prompt sent during the turn still waits for its own turn: the session stays busy.
      if (!stillBusy && this.sessions.has(s.id)) this.emit({ sessionId: s.id, type: 'state', state: 'ready' })
      return
    }
    if (line['type'] === 'error') {
      const error = String(line['message'] ?? 'the Claude bridge failed')
      for (const p of s.pending.splice(0)) p.reject(new Error(error))
      this.emit({ sessionId: s.id, type: 'state', state: 'error', error })
      return
    }
    for (const event of s.mapper.map(line)) {
      if (event.type === 'models') s.models = event.models
      this.emit(event)
    }
  }

  private finishPending(s: NativeSession, stopReason: string): void {
    for (const p of s.pending.splice(0)) p.resolve({ stopReason })
  }

  private send(s: NativeSession, message: Obj): void {
    if (s.child.stdin?.writable) s.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private require(sessionId: string): NativeSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`no Claude session ${sessionId}`)
    return s
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event)
  }
}
