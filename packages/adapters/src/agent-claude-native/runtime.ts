/**
 * AgentRuntime for Claude Code through the Claude Agent SDK (PLAN D8): one Workhub 1 bridge
 * process (`bridge/bridge.mjs`, Node) per session, one JSON object per line each way. The SDK
 * drives the user's own `claude`, so their settings, hooks, skills and MCP servers apply.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
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
  StartedSession,
  StartSessionRequest,
  Unsubscribe
} from '@workhub/core'
import { pathKeyOf } from '../shared/login-path'
import { ClaudeBridgeMapper, permissionResult, resultStopReason } from './mapping'

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

export class ClaudeNativeRuntime implements AgentRuntime, SessionControls {
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
      ...(req.model ? { model: req.model } : {})
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
    return { agentSessionId, agentName: 'Claude Code', permissionMode: null }
  }

  async prompt(sessionId: string, text: string, images: ImageInput[] = []): Promise<PromptResult> {
    const s = this.require(sessionId)
    s.cancelled = false
    this.emit({ sessionId, type: 'state', state: 'busy' })
    const result = new Promise<PromptResult>((resolve, reject) => s.pending.push({ resolve, reject }))
    if (images.length) {
      const content = [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...(text ? [{ type: 'text', text }] : [])
      ]
      this.send(s, { type: 'user', content })
    } else {
      this.send(s, { type: 'user', text })
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
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  private onLine(s: NativeSession, line: Obj): void {
    const message = line['type'] === 'sdk' ? (line['message'] as Obj | undefined) : undefined
    if (message?.['type'] === 'result') {
      this.finishPending(s, resultStopReason(message, s.cancelled))
      s.cancelled = false
      if (this.sessions.has(s.id)) this.emit({ sessionId: s.id, type: 'state', state: 'ready' })
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
