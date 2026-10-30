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
  type ContentBlock,
  type RequestPermissionResponse,
  type Stream
} from '@agentclientprotocol/sdk'
import { launchArgs, readOnlyModeId, readSlashCommand, uniqueSlashCommands } from '@workhub/core'
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentEventListener,
  AgentRuntime,
  ImageInput,
  ModelControl,
  ModelOption,
  PromptResult,
  SessionModeControl,
  SessionModeOption,
  SlashCommandInfo,
  StartedSession,
  StartSessionRequest,
  Unsubscribe
} from '@workhub/core'
import { findExecutable } from './availability'
import { pathKeyOf } from '../shared/login-path'
import { AcpMonitor, permissionMode, readConfigSelect, readModels, readModes, type SelectVia } from './monitor-mapping'
import { planSpawn } from './spawn-plan'
import { acpToolResult, acpToolView } from './tool-view'

export type AcpDirection = 'client->agent' | 'agent->client'

export interface AcpRuntimeOptions {
  clientName: string
  clientVersion: string
  /** Folders prepended to PATH for the agent process (e.g. bundled agent adapters). */
  extraPath?: string[]
  /**
   * The PATH a session starts with (the login shell's, see shared/login-path.ts), read at each
   * start; the process PATH when unset or when it returns undefined.
   */
  path?: () => string | undefined
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
  /** What the agent reported at `session/new` (or later through `config_option_update`). */
  models: ModelOption[]
  currentModelId?: string
  modelVia?: SelectVia
  modes: SessionModeOption[]
  currentModeId?: string
  modeVia?: SelectVia
  /** Slash commands by where the agent reported them (ACP `available_commands_update`, Kiro's extension). */
  commands: Map<'acp' | 'kiro', SlashCommandInfo[]>
}

/** Commands as an agent lists them (ACP `availableCommands`, Kiro's `commands`); entries without a name are skipped. */
export function acpSlashCommands(raw: unknown): SlashCommandInfo[] {
  return Array.isArray(raw) ? raw.flatMap((c) => readSlashCommand(c, 'agent') ?? []) : []
}

type RawRequest = (method: string, params: unknown) => Promise<unknown>

export class AcpRuntime implements AgentRuntime, ModelControl, SessionModeControl {
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

    // Windows names the variable `Path`; a plain copy of process.env is case-sensitive.
    const pathKey = pathKeyOf(process.env)
    const basePath = this.options.path?.()
    const env = { ...process.env, ...(basePath ? { [pathKey]: basePath } : {}), ...req.env }
    if (this.options.extraPath?.length) env[pathKey] = [...this.options.extraPath, env[pathKey] ?? ''].join(delimiter)

    // On Windows there is no ENOENT-on-spawn contract to lean on (and no shell for `.exe`), so the
    // command is resolved up front and started by its full path. POSIX spawns the name as before.
    let file = req.agent.command
    if (process.platform === 'win32') {
      const found = await findExecutable(file, { path: env[pathKey] ?? '' })
      if (!found) {
        const message = `could not start "${req.agent.command}": command not found on PATH`
        this.emit({ sessionId: id, type: 'state', state: 'error', error: message })
        throw new Error(message)
      }
      file = found
    }
    // Agents that take the model or effort on their command line (Kiro) get them at launch; ACP has no effort setting.
    const plan = planSpawn(file, launchArgs(req.agent, { model: req.model, effort: req.effort }))
    const child = spawn(plan.command, plan.args, {
      cwd: req.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    })

    const monitor = new AcpMonitor()
    const session: AcpSession = {
      id,
      agent: req.agent,
      child,
      conn: undefined as unknown as ClientConnection,
      agentSessionId: '',
      monitor,
      pending: new Map(),
      stopping: false,
      models: [],
      modes: [],
      commands: new Map()
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
        // Kiro lists its slash commands with its MCP servers.
        const listed = ctx.method === '_kiro.dev/commands/available' ? (ctx.params as { commands?: unknown } | undefined)?.commands : undefined
        if (Array.isArray(listed)) this.setCommands(session, 'kiro', acpSlashCommands(listed))
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
      const modes = readModes(created)
      session.modes = modes.availableModes
      session.currentModeId = modes.currentModeId
      session.modeVia = modes.via
      const models = readModels(created)
      session.models = models.availableModels
      session.currentModelId = models.currentModelId
      session.modelVia = models.via
      const { availableModes } = modes
      // A reviewer starts in the agent's most read-only permission mode, when it has one; otherwise
      // the mode asked for (an agent or persona), when the agent offers it.
      const readOnlyMode = req.readOnly && req.agent.modeSemantics === 'permission' ? readOnlyModeId(availableModes) : undefined
      const wanted = readOnlyMode ?? (req.readOnly ? undefined : req.modeId)
      let modeIgnored = false
      if (wanted && wanted !== session.currentModeId) {
        const applied = availableModes.some((m) => m.id === wanted) && (await this.applyMode(session, wanted, spawnFailed))
        // A reviewer that cannot get into its read-only mode does not start.
        if (!applied && readOnlyMode) throw new Error(`could not switch the reviewer to the "${readOnlyMode}" mode`)
        modeIgnored = !applied
      }
      const currentModeId = session.currentModeId
      // A model asked for: ACP's session model selection, when the agent reports models and takes it.
      // An agent launched with the model on its command line already runs it, whatever it lists.
      const modelIgnored = req.model ? !(await this.selectModel(session, req.model, spawnFailed)) && !req.agent.modelArgs?.length : false
      const started: StartedSession = {
        agentSessionId: created.sessionId,
        agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? req.agent.name,
        permissionMode: permissionMode(req.agent.modeSemantics, currentModeId, availableModes),
        currentModeId,
        availableModes,
        ...(modelIgnored ? { modelIgnored: true } : {}),
        ...(modeIgnored ? { modeIgnored: true } : {}),
        // Image content blocks are opt-in in ACP: only an agent that advertises them gets pasted images.
        imageInput: init.agentCapabilities?.promptCapabilities?.image === true,
        ...(session.models.length ? { models: session.models } : {}),
        ...(session.currentModelId ? { currentModelId: session.currentModelId } : {})
      }
      if (session.models.length) this.emit({ sessionId: id, type: 'models', models: session.models, currentModelId: session.currentModelId })
      if (session.currentModelId) this.emit({ sessionId: id, type: 'monitor', snapshot: { model: session.currentModelId } })
      this.emit({ sessionId: id, type: 'state', state: 'ready' })
      return started
    } catch (err) {
      await this.stop(id).catch(() => {})
      const message = err instanceof Error ? err.message : JSON.stringify(err)
      this.emit({ sessionId: id, type: 'state', state: 'error', error: message })
      throw new Error(message)
    }
  }

  /** Sends a request the SDK has no typed method for (unstable or newer ACP methods). */
  private raw(session: AcpSession, method: string, params: unknown): Promise<unknown> {
    const request = session.conn.agent.request as unknown as RawRequest
    return request.call(session.conn.agent, method, params)
  }

  /** `session/set_mode`, or the `mode` config option. True when the agent took it. */
  private async applyMode(session: AcpSession, modeId: string, guard?: Promise<never>): Promise<boolean> {
    const via = session.modeVia ?? { kind: 'method' }
    const call =
      via.kind === 'config'
        ? this.raw(session, 'session/set_config_option', { sessionId: session.agentSessionId, configId: via.configId, value: modeId })
        : this.raw(session, 'session/set_mode', { sessionId: session.agentSessionId, modeId })
    try {
      const result = await (guard ? Promise.race([call, guard]) : call)
      session.currentModeId = modeId
      this.readConfigResult(session, result)
      return true
    } catch {
      return false
    }
  }

  /**
   * `session/set_model` (unstable ACP), or the `model` config option. False when the agent reports
   * no model list, does not offer that id, or refuses: the session keeps its model.
   */
  private async selectModel(session: AcpSession, modelId: string, guard?: Promise<never>): Promise<boolean> {
    if (!session.models.some((m) => m.id === modelId)) return false
    const via = session.modelVia ?? { kind: 'method' }
    const call =
      via.kind === 'config'
        ? this.raw(session, 'session/set_config_option', { sessionId: session.agentSessionId, configId: via.configId, value: modelId })
        : this.raw(session, 'session/set_model', { sessionId: session.agentSessionId, modelId })
    try {
      const result = await (guard ? Promise.race([call, guard]) : call)
      session.currentModelId = modelId
      this.readConfigResult(session, result)
      return true
    } catch {
      return false
    }
  }

  /** `session/set_config_option` answers with every option's new value; keep what changed. */
  private readConfigResult(session: AcpSession, result: unknown): void {
    const options = (result as { configOptions?: unknown } | null)?.configOptions
    if (!options) return
    if (session.modelVia?.kind === 'config') session.currentModelId = readConfigSelect(options, 'model')?.currentValue ?? session.currentModelId
    if (session.modeVia?.kind === 'config') session.currentModeId = readConfigSelect(options, 'mode')?.currentValue ?? session.currentModeId
  }

  /** Switches a running session's model. `null` (the agent's default) cannot be asked for over ACP and is ignored. */
  async setModel(sessionId: string, modelId: string | null): Promise<void> {
    const s = this.require(sessionId)
    if (!modelId || modelId === s.currentModelId) return
    if (!s.models.some((m) => m.id === modelId)) throw new Error(`the agent does not offer the model "${modelId}"`)
    if (!(await this.selectModel(s, modelId))) throw new Error(`the agent refused the model "${modelId}"`)
    this.emit({ sessionId, type: 'models', models: s.models, currentModelId: s.currentModelId })
    this.emit({ sessionId, type: 'monitor', snapshot: { model: s.currentModelId } })
  }

  /** Switches a running session's mode: the agent or persona (Kiro, OpenCode), or the approval preset (Codex). */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const s = this.require(sessionId)
    if (modeId === s.currentModeId) return
    if (!s.modes.some((m) => m.id === modeId)) throw new Error(`the agent does not offer the mode "${modeId}"`)
    if (!(await this.applyMode(s, modeId))) throw new Error(`the agent refused the mode "${modeId}"`)
    this.emitMode(s)
  }

  private emitMode(s: AcpSession): void {
    if (!s.currentModeId) return
    this.emit({
      sessionId: s.id,
      type: 'permissionMode',
      mode: permissionMode(s.agent.modeSemantics, s.currentModeId, s.modes),
      currentModeId: s.currentModeId
    })
  }

  async prompt(sessionId: string, text: string, images: ImageInput[] = []): Promise<PromptResult> {
    const s = this.require(sessionId)
    this.emit({ sessionId, type: 'state', state: 'busy' })
    try {
      const prompt: ContentBlock[] = [
        ...images.map((i): ContentBlock => ({ type: 'image', mimeType: i.mediaType, data: i.data })),
        ...(text || !images.length ? [{ type: 'text', text } satisfies ContentBlock] : [])
      ]
      const res = await s.conn.agent.request('session/prompt', { sessionId: s.agentSessionId, prompt })
      const patch = s.monitor.applyPromptResult(res)
      if (patch) this.emit({ sessionId, type: 'monitor', snapshot: patch })
      const ended = s.monitor.endTurn(res.stopReason)
      if (ended) this.emit({ sessionId, type: 'monitor', snapshot: ended })
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
          kind: typeof u['kind'] === 'string' ? u['kind'] : undefined,
          view: acpToolView(u),
          result: acpToolResult(u)
        })
        break
      case 'available_commands_update':
        this.setCommands(s, 'acp', acpSlashCommands(u['availableCommands']))
        break
      case 'current_mode_update':
        if (u.currentModeId) {
          s.currentModeId = u.currentModeId
          this.emitMode(s)
        }
        break
      case 'config_option_update': {
        // The newer ACP form of model and mode changes, made by the agent or a slash command.
        const options = u['configOptions']
        const model = s.modelVia?.kind === 'config' ? readConfigSelect(options, 'model') : undefined
        if (model?.currentValue && model.currentValue !== s.currentModelId) {
          s.currentModelId = model.currentValue
          if (model.options.length) s.models = model.options.map((o) => (o.description ? o : { id: o.id, name: o.name }))
          this.emit({ sessionId: s.id, type: 'models', models: s.models, currentModelId: s.currentModelId })
          this.emit({ sessionId: s.id, type: 'monitor', snapshot: { model: s.currentModelId } })
        }
        const mode = s.modeVia?.kind === 'config' ? readConfigSelect(options, 'mode') : undefined
        if (mode?.currentValue && mode.currentValue !== s.currentModeId) {
          s.currentModeId = mode.currentValue
          this.emitMode(s)
        }
        break
      }
    }
    const patch = s.monitor.applyUpdate(update)
    if (patch) this.emit({ sessionId: s.id, type: 'monitor', snapshot: patch })
  }

  private setCommands(s: AcpSession, source: 'acp' | 'kiro', commands: SlashCommandInfo[]): void {
    s.commands.set(source, commands)
    this.emit({ sessionId: s.id, type: 'commands', commands: uniqueSlashCommands([...s.commands.values()].flat()) })
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
