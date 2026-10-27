/**
 * AgentRuntime over the Agent Client Protocol (stdio, newline-delimited JSON-RPC).
 * Grown from the P0 spike's `acp-client.ts`; one agent process per session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
  type ClientConnection,
  type RequestPermissionResponse,
  type Stream
} from '@agentclientprotocol/sdk'
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentEventListener,
  AgentRuntime,
  PromptResult,
  StartedSession,
  StartSessionRequest,
  Unsubscribe
} from '@workhub/core'
import { AcpMonitor, permissionMode, readModes } from './monitor-mapping'

export type AcpDirection = 'client->agent' | 'agent->client'

export interface AcpRuntimeOptions {
  clientName: string
  clientVersion: string
  /** Folders prepended to PATH for the agent process (e.g. bundled agent adapters). */
  extraPath?: string[]
  /** Every raw JSON-RPC message, for debugging. */
  onRaw?: (sessionId: string, direction: AcpDirection, message: AnyMessage) => void
}

interface AcpSession {
  id: string
  agent: AgentDefinition
  child: ChildProcess
  conn: ClientConnection
  agentSessionId: string
  monitor: AcpMonitor
  pending: Map<string, (r: RequestPermissionResponse) => void>
  stopping: boolean
}

export class AcpRuntime implements AgentRuntime {
  readonly adapter = 'acp' as const
  private readonly sessions = new Map<string, AcpSession>()
  private readonly listeners = new Set<AgentEventListener>()

  constructor(private readonly options: AcpRuntimeOptions) {}

  capabilities(agent: AgentDefinition): AgentCapabilities {
    return agent.capabilities
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(req: StartSessionRequest): Promise<StartedSession> {
    if (this.sessions.has(req.sessionId)) throw new Error(`session ${req.sessionId} already exists`)
    const id = req.sessionId
    this.emit({ sessionId: id, type: 'state', state: 'starting' })

    const env = { ...process.env, ...req.env }
    if (this.options.extraPath?.length) env['PATH'] = [...this.options.extraPath, env['PATH'] ?? ''].join(delimiter)
    // Windows runs npm-installed agents (npx, gemini, opencode) through .cmd shims, which Node
    // only starts through a shell. Not verified on Windows yet.
    const child = spawn(req.agent.command, req.agent.args, { cwd: req.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })

    const monitor = new AcpMonitor()
    const session: AcpSession = {
      id,
      agent: req.agent,
      child,
      conn: undefined as unknown as ClientConnection,
      agentSessionId: '',
      monitor,
      pending: new Map(),
      stopping: false
    }
    this.sessions.set(id, session)

    // Spawn errors (command not found) arrive as an event, not a throw.
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`could not start "${req.agent.command}": ${err.message}`)))
      child.once('exit', (code) => reject(new Error(`agent exited during start (code ${code})`)))
    })
    spawnFailed.catch(() => {})
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) =>
      d.split('\n').filter(Boolean).forEach((line) => this.emit({ sessionId: id, type: 'stderr', line }))
    )
    child.on('exit', (code) => {
      this.emit({ sessionId: id, type: 'exit', code })
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id)
        this.emit({ sessionId: id, type: 'state', state: session.stopping ? 'stopped' : 'error', error: session.stopping ? undefined : `agent exited (code ${code})` })
      }
    })

    const base = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    session.conn = client({ name: this.options.clientName })
      .onNotification('session/update', (ctx) => this.onUpdate(session, ctx.params.update))
      .onRequest('session/request_permission', (ctx) =>
        new Promise<RequestPermissionResponse>((resolve) => {
          const requestId = randomUUID()
          session.pending.set(requestId, resolve)
          this.emit({
            sessionId: id,
            type: 'permission',
            requestId,
            title: ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId,
            options: ctx.params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
          })
        })
      )
      .onRequest('*', (ctx) => {
        throw new Error(`method ${ctx.method} is not supported by ${this.options.clientName}`)
      })
      .onNotification('*', (ctx) => {
        const patch = monitor.applyExtension(ctx.method, ctx.params)
        if (patch) this.emit({ sessionId: id, type: 'monitor', snapshot: patch })
      })
      .connect(this.tap(id, base))

    try {
      const init = await Promise.race([
        session.conn.agent.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: this.options.clientName, version: this.options.clientVersion }
        }),
        spawnFailed
      ])
      // Empty mcpServers: each agent loads its own MCP configuration (P0 finding).
      const created = await Promise.race([
        session.conn.agent.request('session/new', { cwd: req.cwd, mcpServers: [] }),
        spawnFailed
      ])
      session.agentSessionId = created.sessionId
      const { currentModeId, availableModes } = readModes(created)
      const started: StartedSession = {
        agentSessionId: created.sessionId,
        agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? req.agent.name,
        permissionMode: permissionMode(req.agent.modeSemantics, currentModeId, availableModes),
        currentModeId,
        availableModes
      }
      const model = (created as { models?: { currentModelId?: string } }).models?.currentModelId
      if (model) this.emit({ sessionId: id, type: 'monitor', snapshot: { model } })
      this.emit({ sessionId: id, type: 'state', state: 'ready' })
      return started
    } catch (err) {
      await this.stop(id).catch(() => {})
      const message = err instanceof Error ? err.message : JSON.stringify(err)
      this.emit({ sessionId: id, type: 'state', state: 'error', error: message })
      throw new Error(message)
    }
  }

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const s = this.require(sessionId)
    this.emit({ sessionId, type: 'state', state: 'busy' })
    try {
      const res = await s.conn.agent.request('session/prompt', {
        sessionId: s.agentSessionId,
        prompt: [{ type: 'text', text }]
      })
      const patch = s.monitor.applyPromptResult(res)
      if (patch) this.emit({ sessionId, type: 'monitor', snapshot: patch })
      return { stopReason: res.stopReason }
    } finally {
      if (this.sessions.has(sessionId)) this.emit({ sessionId, type: 'state', state: 'ready' })
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const s = this.require(sessionId)
    await s.conn.agent.notify('session/cancel', { sessionId: s.agentSessionId })
  }

  respondPermission(sessionId: string, requestId: string, optionId: string | null): void {
    const s = this.sessions.get(sessionId)
    const resolve = s?.pending.get(requestId)
    if (!s || !resolve) return
    s.pending.delete(requestId)
    resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.stopping = true
    for (const resolve of s.pending.values()) resolve({ outcome: { outcome: 'cancelled' } })
    s.pending.clear()
    try {
      s.conn?.close()
    } catch {
      /* already closed */
    }
    const child = s.child
    // No pid: the spawn itself failed and there is no process to wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.sessions.delete(sessionId)
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  private onUpdate(s: AcpSession, update: unknown): void {
    const u = update as { sessionUpdate?: string; content?: { type?: string; text?: string }; currentModeId?: string } & Record<string, unknown>
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (u.content?.type === 'text' && u.content.text) {
          this.emit({ sessionId: s.id, type: 'message', role: u.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought', text: u.content.text })
        }
        break
      case 'tool_call':
      case 'tool_call_update':
        this.emit({
          sessionId: s.id,
          type: 'tool',
          toolCallId: String(u['toolCallId'] ?? ''),
          title: typeof u['title'] === 'string' ? u['title'] : undefined,
          status: typeof u['status'] === 'string' ? u['status'] : undefined,
          kind: typeof u['kind'] === 'string' ? u['kind'] : undefined
        })
        break
      case 'current_mode_update':
        if (u.currentModeId) {
          this.emit({
            sessionId: s.id,
            type: 'permissionMode',
            mode: permissionMode(s.agent.modeSemantics, u.currentModeId, []),
            currentModeId: u.currentModeId
          })
        }
        break
    }
    const patch = s.monitor.applyUpdate(update)
    if (patch) this.emit({ sessionId: s.id, type: 'monitor', snapshot: patch })
  }

  private require(sessionId: string): AcpSession {
    const s = this.sessions.get(sessionId)
    if (!s || !s.agentSessionId) throw new Error(`no ready ACP session ${sessionId}`)
    return s
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event)
  }

  /** Wraps a stream so every JSON-RPC message in both directions reaches `onRaw`. */
  private tap(sessionId: string, s: Stream): Stream {
    const raw = this.options.onRaw
    if (!raw) return s
    const readable = s.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (m, c) => {
          raw(sessionId, 'agent->client', m)
          c.enqueue(m)
        }
      })
    )
    const out = new TransformStream<AnyMessage, AnyMessage>({
      transform: (m, c) => {
        raw(sessionId, 'client->agent', m)
        c.enqueue(m)
      }
    })
    void out.readable.pipeTo(s.writable).catch(() => {})
    return { readable, writable: out.writable }
  }
}
