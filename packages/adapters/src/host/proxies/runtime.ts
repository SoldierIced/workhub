// AgentRuntime over the host: the runtime spawns its agents on the host, and the app drives it.
// Methods are `runtime.<id>.<method>` requests; the runtime's events are `runtime.<id>.event`
// events carrying the AgentEvent as is (its `sessionId` says which session). Events and responses
// share one ordered channel, so an event the runtime emits before a call returns arrives first.
import { z } from 'zod'
import {
  canSetModel,
  canSetSessionMode,
  hasSessionControls,
  isTerminalControl,
  type AgentAdapterKind,
  type AgentCapabilities,
  type AgentDefinition,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ImageInput,
  type PromptResult,
  type StartSessionRequest,
  type StartedSession,
  type Unsubscribe
} from '@workhub/core'
import { HostRequestError, type HostClient } from '../client'
import type { HostHandlers } from '../server'
import { UNBOUNDED_TIMEOUT_MS, objectLike, parseParams, parseResult, type HostEmit } from './shared'

/**
 * The optional controls a runtime may have, as the core guards see them: `terminal`
 * (isTerminalControl), `sessionControls` (hasSessionControls), `modelControl` (canSetModel) and
 * `sessionMode` (canSetSessionMode). The remote has exactly the ones the host's runtime has.
 */
export const RUNTIME_EXTRAS = ['terminal', 'sessionControls', 'modelControl', 'sessionMode'] as const
export type RuntimeExtra = (typeof RUNTIME_EXTRAS)[number]

const RUNTIME_ID = /^[a-z0-9-]+$/
export const runtimeEventName = (runtimeId: string): string => `runtime.${runtimeId}.event`

const sessionId = z.string().min(1)
const mcpServer = z.looseObject({ name: z.string(), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) })
const startParams = z.looseObject({
  sessionId,
  agent: z.looseObject({ id: z.string(), adapter: z.string() }),
  account: z.looseObject({ id: z.string() }).nullable(),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  agentSessionId: z.string().optional(),
  resume: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  modeId: z.string().optional(),
  readOnly: z.boolean().optional(),
  mcpServers: z.array(mcpServer).optional()
})
const imageInput = z.object({ mediaType: z.string(), data: z.string() })
const promptParams = z.object({ sessionId, text: z.string(), images: z.array(imageInput).optional() })
const sessionParams = z.object({ sessionId })
const permissionParams = z.object({ sessionId, requestId: z.string(), optionId: z.string().nullable(), answers: z.record(z.string(), z.string()).optional() })
const modelParams = z.object({ sessionId, modelId: z.string().nullable() })
const mcpServerParams = z.object({ sessionId, server: z.string() })
const toggleParams = z.object({ sessionId, server: z.string(), enabled: z.boolean() })
const modeParams = z.object({ sessionId, modeId: z.string() })
const writeParams = z.object({ sessionId, data: z.string() })
const resizeParams = z.object({ sessionId, cols: z.number().int().positive(), rows: z.number().int().positive() })

const describeResult = z.object({ adapter: z.enum(['native', 'acp', 'terminal']), extras: z.array(z.enum(RUNTIME_EXTRAS)) })
const startedResult = objectLike<StartedSession>().refine((v) => typeof v.agentName === 'string', 'expected agentName')
const promptResult = z.looseObject({ stopReason: z.string() })
const eventEnvelope = z.looseObject({ sessionId: z.string(), type: z.string() })

function extrasOf(runtime: AgentRuntime): RuntimeExtra[] {
  const extras: RuntimeExtra[] = []
  if (isTerminalControl(runtime)) extras.push('terminal')
  if (hasSessionControls(runtime)) extras.push('sessionControls')
  if (canSetModel(runtime)) extras.push('modelControl')
  if (canSetSessionMode(runtime)) extras.push('sessionMode')
  return extras
}

export interface AgentRuntimeHandlersOptions {
  /** An event that could not be sent (larger than a protocol line); it is dropped. */
  onError?: (err: unknown) => void
}

/**
 * Host side: `runtime.<runtimeId>.*` for one runtime, and its events sent with `emit`. Handlers
 * for an extra exist only when the runtime has it. `dispose` stops forwarding events.
 */
export function agentRuntimeHandlers(
  runtimeId: string,
  runtime: AgentRuntime,
  emit: HostEmit,
  options: AgentRuntimeHandlersOptions = {}
): { handlers: HostHandlers; dispose: Unsubscribe } {
  if (!RUNTIME_ID.test(runtimeId)) throw new Error(`not a runtime id: ${JSON.stringify(runtimeId)}`)
  const name = (method: string) => `runtime.${runtimeId}.${method}`
  const event = runtimeEventName(runtimeId)
  const dispose = runtime.subscribe((e) => {
    try {
      emit(event, e)
    } catch (err) {
      options.onError?.(err)
    }
  })
  const extras = extrasOf(runtime)
  const handlers: HostHandlers = {
    [name('describe')]: () => ({ adapter: runtime.adapter, extras }),
    [name('start')]: (p) => runtime.start(parseParams(startParams, p, name('start')) as unknown as StartSessionRequest),
    [name('prompt')]: (p) => {
      const { sessionId: id, text, images } = parseParams(promptParams, p, name('prompt'))
      return runtime.prompt(id, text, images)
    },
    [name('cancel')]: async (p) => void (await runtime.cancel(parseParams(sessionParams, p, name('cancel')).sessionId)),
    [name('stop')]: async (p) => void (await runtime.stop(parseParams(sessionParams, p, name('stop')).sessionId)),
    [name('stopAll')]: async () => void (await runtime.stopAll()),
    [name('respondPermission')]: (p) => {
      const { sessionId: id, requestId, optionId, answers } = parseParams(permissionParams, p, name('respondPermission'))
      runtime.respondPermission(id, requestId, optionId, answers)
    }
  }
  if (canSetModel(runtime)) {
    handlers[name('setModel')] = async (p) => {
      const { sessionId: id, modelId } = parseParams(modelParams, p, name('setModel'))
      await runtime.setModel(id, modelId)
    }
  }
  if (hasSessionControls(runtime)) {
    handlers[name('refreshMcp')] = (p) => runtime.refreshMcp(parseParams(sessionParams, p, name('refreshMcp')).sessionId)
    handlers[name('reconnectMcp')] = (p) => {
      const { sessionId: id, server } = parseParams(mcpServerParams, p, name('reconnectMcp'))
      runtime.reconnectMcp(id, server)
    }
    handlers[name('toggleMcp')] = (p) => {
      const { sessionId: id, server, enabled } = parseParams(toggleParams, p, name('toggleMcp'))
      runtime.toggleMcp(id, server, enabled)
    }
  }
  if (canSetSessionMode(runtime)) {
    handlers[name('setSessionMode')] = async (p) => {
      const { sessionId: id, modeId } = parseParams(modeParams, p, name('setSessionMode'))
      await runtime.setSessionMode(id, modeId)
    }
  }
  if (isTerminalControl(runtime)) {
    handlers[name('write')] = (p) => {
      const { sessionId: id, data } = parseParams(writeParams, p, name('write'))
      runtime.write(id, data)
    }
    handlers[name('resize')] = (p) => {
      const { sessionId: id, cols, rows } = parseParams(resizeParams, p, name('resize'))
      runtime.resize(id, cols, rows)
    }
  }
  return { handlers, dispose }
}

export interface RemoteAgentRuntimeOptions {
  /**
   * `capabilities` is synchronous, so it is not asked of the host. Both agent runtimes take them
   * from the agent definition (the default); a terminal-like runtime passes its own.
   */
  capabilities?: (agent: AgentDefinition) => AgentCapabilities
  /** A fire-and-forget call (a permission answer, a terminal write) that failed, or a malformed event. */
  onError?: (err: unknown) => void
}

const isClosed = (err: unknown): boolean => err instanceof HostRequestError && err.code === 'closed'

/**
 * App side: an AgentRuntime whose sessions run on the host. Calls wait as long as the host's
 * runtime takes (it owns the timeouts); when the host goes away every pending call rejects with
 * `closed`, each session still live gets a `state: error` event, and stopping becomes a no-op.
 */
export class RemoteAgentRuntime implements AgentRuntime {
  private readonly listeners = new Set<AgentEventListener>()
  /** Sessions started and not yet stopped, ended or failed: the ones a lost host leaves in error. */
  private readonly live = new Set<string>()
  // Present only when the host's runtime has them (see RUNTIME_EXTRAS): callers duck-type them.
  setModel?: (sessionId: string, modelId: string | null) => Promise<void>
  refreshMcp?: (sessionId: string) => void
  reconnectMcp?: (sessionId: string, server: string) => void
  toggleMcp?: (sessionId: string, server: string, enabled: boolean) => void
  setSessionMode?: (sessionId: string, modeId: string) => Promise<void>
  write?: (sessionId: string, data: string) => void
  resize?: (sessionId: string, cols: number, rows: number) => void

  /** Use connectRemoteAgentRuntime, which asks the host what the runtime is first. */
  constructor(
    private readonly client: HostClient,
    readonly runtimeId: string,
    readonly adapter: AgentAdapterKind,
    readonly extras: ReadonlySet<RuntimeExtra>,
    private readonly options: RemoteAgentRuntimeOptions = {}
  ) {
    client.onEvent(runtimeEventName(runtimeId), (payload) => this.receive(payload))
    client.onClose((reason) => this.hostLost(reason))
    if (extras.has('modelControl') || extras.has('sessionControls')) this.setModel = (id, modelId) => this.call('setModel', { sessionId: id, modelId })
    if (extras.has('sessionControls')) {
      this.refreshMcp = (id) => this.fire('refreshMcp', { sessionId: id })
      this.reconnectMcp = (id, server) => this.fire('reconnectMcp', { sessionId: id, server })
      this.toggleMcp = (id, server, enabled) => this.fire('toggleMcp', { sessionId: id, server, enabled })
    }
    if (extras.has('sessionMode')) this.setSessionMode = (id, modeId) => this.call('setSessionMode', { sessionId: id, modeId })
    if (extras.has('terminal')) {
      this.write = (id, data) => this.fire('write', { sessionId: id, data })
      this.resize = (id, cols, rows) => this.fire('resize', { sessionId: id, cols, rows })
    }
  }

  capabilities(agent: AgentDefinition): AgentCapabilities {
    return this.options.capabilities ? this.options.capabilities(agent) : agent.capabilities
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(request: StartSessionRequest): Promise<StartedSession> {
    this.live.add(request.sessionId)
    try {
      return parseResult(startedResult, await this.call('start', request), this.method('start'))
    } catch (err) {
      this.live.delete(request.sessionId)
      throw err
    }
  }

  async prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<PromptResult> {
    const result = await this.call('prompt', { sessionId, text, ...(images ? { images } : {}) })
    return parseResult(promptResult, result, this.method('prompt'))
  }

  cancel(sessionId: string): Promise<void> {
    return this.unlessClosed(this.call('cancel', { sessionId }))
  }

  async stop(sessionId: string): Promise<void> {
    await this.unlessClosed(this.call('stop', { sessionId }))
    this.live.delete(sessionId)
  }

  stopAll(): Promise<void> {
    return this.unlessClosed(this.call('stopAll'))
  }

  respondPermission(sessionId: string, requestId: string, optionId: string | null, answers?: Record<string, string>): void {
    this.fire('respondPermission', { sessionId, requestId, optionId, ...(answers ? { answers } : {}) })
  }

  private method(name: string): string {
    return `runtime.${this.runtimeId}.${name}`
  }

  private async call(name: string, params?: unknown): Promise<never> {
    return this.client.request<never>(this.method(name), params, { timeoutMs: UNBOUNDED_TIMEOUT_MS })
  }

  /** For the methods that return nothing: requests go out in call order, failures are reported. */
  private fire(name: string, params: unknown): void {
    this.call(name, params).catch((err: unknown) => this.options.onError?.(err))
  }

  /** There is nothing left to stop or cancel on a host that is gone. */
  private async unlessClosed(pending: Promise<unknown>): Promise<void> {
    try {
      await pending
    } catch (err) {
      if (!isClosed(err)) throw err
    }
  }

  private receive(payload: unknown): void {
    const parsed = eventEnvelope.safeParse(payload)
    if (!parsed.success) {
      this.options.onError?.(new Error(`${runtimeEventName(this.runtimeId)}: malformed event from the host`))
      return
    }
    const event = parsed.data as unknown as AgentEvent
    if (event.type === 'exit' || (event.type === 'state' && (event.state === 'stopped' || event.state === 'error'))) this.live.delete(event.sessionId)
    this.dispatch(event)
  }

  private hostLost(reason: string): void {
    const sessions = [...this.live]
    this.live.clear()
    for (const id of sessions) this.dispatch({ sessionId: id, type: 'state', state: 'error', error: `the workhub host went away (${reason})` })
  }

  private dispatch(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** App side: the host's runtime `runtimeId`, with the extras it has. Rejects when the host has no such runtime. */
export async function connectRemoteAgentRuntime(client: HostClient, runtimeId: string, options: RemoteAgentRuntimeOptions = {}): Promise<RemoteAgentRuntime> {
  if (!RUNTIME_ID.test(runtimeId)) throw new Error(`not a runtime id: ${JSON.stringify(runtimeId)}`)
  const method = `runtime.${runtimeId}.describe`
  const described = parseResult(describeResult, await client.request(method), method)
  return new RemoteAgentRuntime(client, runtimeId, described.adapter, new Set(described.extras), options)
}
