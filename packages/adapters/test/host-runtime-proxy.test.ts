import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  NO_CAPABILITIES,
  canSetModel,
  canSetSessionMode,
  hasSessionControls,
  isTerminalControl,
  type AgentDefinition,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ImageInput,
  type PromptResult,
  type StartSessionRequest,
  type StartedSession
} from '@workhub/core'
import { HostChannel, HostClient, HostServer, agentRuntimeHandlers, connectRemoteAgentRuntime, type HostHandlers } from '../src/host'

const hello = { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test', features: [], platform: 'linux' as const, home: '/home/ana', pathFlavor: 'posix' as const }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

class FakeRuntime implements AgentRuntime {
  readonly adapter = 'native' as const
  readonly calls: unknown[][] = []
  private readonly listeners = new Set<AgentEventListener>()

  capabilities(agent: AgentDefinition) {
    return agent.capabilities
  }
  subscribe(listener: AgentEventListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event)
  }
  async start(req: StartSessionRequest): Promise<StartedSession> {
    this.calls.push(['start', req])
    this.emit({ sessionId: req.sessionId, type: 'state', state: 'starting' })
    return { agentSessionId: req.agentSessionId ?? 'agent-1', agentName: 'Fake agent', permissionMode: null }
  }
  async prompt(sessionId: string, text: string, images?: ImageInput[]): Promise<PromptResult> {
    this.calls.push(['prompt', sessionId, text, images])
    if (text === 'fail') throw new Error('model overloaded')
    if (text === 'hang') return new Promise(() => {})
    this.emit({ sessionId, type: 'state', state: 'busy' })
    this.emit({ sessionId, type: 'message', role: 'agent', text: `echo ${text}` })
    this.emit({ sessionId, type: 'state', state: 'ready' })
    return { stopReason: 'end_turn' }
  }
  async cancel(sessionId: string) {
    this.calls.push(['cancel', sessionId])
  }
  async stop(sessionId: string) {
    this.calls.push(['stop', sessionId])
    this.emit({ sessionId, type: 'state', state: 'stopped' })
  }
  async stopAll() {
    this.calls.push(['stopAll'])
  }
  respondPermission(sessionId: string, requestId: string, optionId: string | null, answers?: Record<string, string>) {
    this.calls.push(['respondPermission', sessionId, requestId, optionId, answers])
  }
}

class FakeRuntimeWithControls extends FakeRuntime {
  async setModel(sessionId: string, modelId: string | null) {
    this.calls.push(['setModel', sessionId, modelId])
  }
  refreshMcp(sessionId: string) {
    this.calls.push(['refreshMcp', sessionId])
  }
  reconnectMcp(sessionId: string, server: string) {
    this.calls.push(['reconnectMcp', sessionId, server])
  }
  toggleMcp(sessionId: string, server: string, enabled: boolean) {
    this.calls.push(['toggleMcp', sessionId, server, enabled])
  }
  async setSessionMode(sessionId: string, modeId: string) {
    this.calls.push(['setSessionMode', sessionId, modeId])
  }
}

class FakeTerminalRuntime extends FakeRuntime {
  write(sessionId: string, data: string) {
    this.calls.push(['write', sessionId, data])
  }
  resize(sessionId: string, cols: number, rows: number) {
    this.calls.push(['resize', sessionId, cols, rows])
  }
}

function connect(runtime: AgentRuntime, runtimeId = 'native') {
  const toHost = new PassThrough()
  const toApp = new PassThrough()
  const hostChannel = new HostChannel(toHost, toApp)
  const client = new HostClient(new HostChannel(toApp, toHost), { expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test' } })
  const hostErrors: unknown[] = []
  let server: HostServer | undefined
  const served = agentRuntimeHandlers(runtimeId, runtime, (ev, p) => server!.emit(ev, p), { onError: (e) => hostErrors.push(e) })
  const handlers: HostHandlers = served.handlers
  server = new HostServer(hostChannel, { hello, handlers })
  return { client, server, hostChannel, hostErrors, served }
}

const agent = { id: 'claude', name: 'Claude', adapter: 'native', capabilities: { ...NO_CAPABILITIES, appMode: true } } as unknown as AgentDefinition
const startRequest = (sessionId: string): StartSessionRequest => ({ sessionId, agent, account: null, cwd: '/w/acme/api', env: { ACME_TOKEN_REF: 'x' }, agentSessionId: `agent-${sessionId}` })

describe('agent runtime over the host', () => {
  it('runs start, prompt and stop, with each session getting its events in order', async () => {
    const fake = new FakeRuntime()
    const { client } = connect(fake)
    const remote = await connectRemoteAgentRuntime(client, 'native')
    expect(remote.adapter).toBe('native')
    const events: AgentEvent[] = []
    remote.subscribe((e) => events.push(e))

    const started = await remote.start(startRequest('s1'))
    // An event the runtime emitted during start arrives before start resolves, as it does locally.
    expect(events).toEqual([{ sessionId: 's1', type: 'state', state: 'starting' }])
    expect(started).toEqual({ agentSessionId: 'agent-s1', agentName: 'Fake agent', permissionMode: null })
    await remote.start(startRequest('s2'))

    const images = [{ mediaType: 'image/png', data: 'aGVsbG8=' }]
    await expect(Promise.all([remote.prompt('s1', 'one', images), remote.prompt('s2', 'two')])).resolves.toEqual([{ stopReason: 'end_turn' }, { stopReason: 'end_turn' }])
    await remote.cancel('s1')
    await remote.stop('s1')
    await remote.stopAll()
    await tick()

    const of = (id: string) => events.filter((e) => e.sessionId === id).map((e) => (e.type === 'state' ? e.state : e.type === 'message' ? e.text : e.type))
    expect(of('s1')).toEqual(['starting', 'busy', 'echo one', 'ready', 'stopped'])
    expect(of('s2')).toEqual(['starting', 'busy', 'echo two', 'ready'])
    expect(fake.calls.map((c) => c[0])).toEqual(['start', 'start', 'prompt', 'prompt', 'cancel', 'stop', 'stopAll'])
    expect(fake.calls[0]![1]).toEqual(startRequest('s1'))
    expect(fake.calls[2]).toEqual(['prompt', 's1', 'one', images])
  })

  it('keeps the message of a runtime error', async () => {
    const { client } = connect(new FakeRuntime())
    const remote = await connectRemoteAgentRuntime(client, 'native')
    await remote.start(startRequest('s1'))
    await expect(remote.prompt('s1', 'fail')).rejects.toThrow('model overloaded')
  })

  it('answers permissions, a cancelled one included', async () => {
    const fake = new FakeRuntime()
    const { client } = connect(fake)
    const remote = await connectRemoteAgentRuntime(client, 'native')
    remote.respondPermission('s1', 'r1', 'allow_once')
    remote.respondPermission('s1', 'r2', null, { 'Which file?': 'form.tsx' })
    await remote.stopAll()
    expect(fake.calls.slice(0, 2)).toEqual([
      ['respondPermission', 's1', 'r1', 'allow_once', undefined],
      ['respondPermission', 's1', 'r2', null, { 'Which file?': 'form.tsx' }]
    ])
  })

  it('offers no extras when the host runtime has none', async () => {
    const { client } = connect(new FakeRuntime())
    const remote = await connectRemoteAgentRuntime(client, 'native')
    expect([isTerminalControl(remote), canSetModel(remote), canSetSessionMode(remote), hasSessionControls(remote)]).toEqual([false, false, false, false])
    await expect(client.request('runtime.native.setModel', { sessionId: 's1', modelId: null })).rejects.toMatchObject({ code: 'unknown_method' })
  })

  it('offers session, model and mode controls when the host runtime has them', async () => {
    const fake = new FakeRuntimeWithControls()
    const { client } = connect(fake)
    const remote = await connectRemoteAgentRuntime(client, 'native')
    if (!hasSessionControls(remote) || !canSetSessionMode(remote)) throw new Error('controls missing')
    expect(canSetModel(remote)).toBe(true)
    expect(isTerminalControl(remote)).toBe(false)
    await remote.setModel('s1', 'model-b')
    await remote.setModel('s1', null)
    remote.refreshMcp('s1')
    remote.reconnectMcp('s1', 'docs')
    remote.toggleMcp('s1', 'docs', false)
    await remote.setSessionMode('s1', 'plan')
    expect(fake.calls).toEqual([
      ['setModel', 's1', 'model-b'],
      ['setModel', 's1', null],
      ['refreshMcp', 's1'],
      ['reconnectMcp', 's1', 'docs'],
      ['toggleMcp', 's1', 'docs', false],
      ['setSessionMode', 's1', 'plan']
    ])
  })

  it('offers terminal control when the host runtime has it, keeping writes in order', async () => {
    const fake = new FakeTerminalRuntime()
    const { client } = connect(fake, 'terminal')
    const remote = await connectRemoteAgentRuntime(client, 'terminal', { capabilities: () => ({ ...NO_CAPABILITIES }) })
    if (!isTerminalControl(remote)) throw new Error('terminal control missing')
    expect(hasSessionControls(remote)).toBe(false)
    expect(remote.capabilities(agent)).toEqual(NO_CAPABILITIES)
    for (const data of ['l', 's', ' -la', '\r']) remote.write('t1', data)
    remote.resize('t1', 120, 40)
    await remote.stopAll()
    expect(fake.calls).toEqual([['write', 't1', 'l'], ['write', 't1', 's'], ['write', 't1', ' -la'], ['write', 't1', '\r'], ['resize', 't1', 120, 40], ['stopAll']])
  })

  it('takes capabilities from the agent definition by default', async () => {
    const { client } = connect(new FakeRuntime())
    const remote = await connectRemoteAgentRuntime(client, 'native')
    expect(remote.capabilities(agent)).toEqual(agent.capabilities)
  })

  it('turns a lost host into a session error and a rejected prompt instead of a hang', async () => {
    const { client, hostChannel } = connect(new FakeRuntime())
    const remote = await connectRemoteAgentRuntime(client, 'native')
    const events: AgentEvent[] = []
    remote.subscribe((e) => events.push(e))
    await remote.start(startRequest('s1'))
    await remote.start(startRequest('s2'))
    await remote.stop('s2')
    const turn = remote.prompt('s1', 'hang')
    await tick()
    hostChannel.close()
    await expect(turn).rejects.toMatchObject({ code: 'closed' })
    const errors = events.filter((e) => e.type === 'state' && e.state === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ sessionId: 's1', type: 'state', state: 'error', error: expect.stringMatching(/host/) })
    // Nothing is left to stop on a host that is gone: stopping resolves.
    await expect(remote.stop('s1')).resolves.toBeUndefined()
    await expect(remote.stopAll()).resolves.toBeUndefined()
    await expect(remote.start(startRequest('s3'))).rejects.toMatchObject({ code: 'closed' })
  })

  it('refuses bad params and an unknown runtime', async () => {
    const { client } = connect(new FakeRuntime())
    await expect(client.request('runtime.native.prompt', { sessionId: 1, text: 'hi' })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(client.request('runtime.native.start', { sessionId: 's1', cwd: '/w' })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(connectRemoteAgentRuntime(client, 'acp')).rejects.toMatchObject({ code: 'unknown_method' })
  })

  it('drops an event too large for the channel and keeps streaming', async () => {
    const fake = new FakeRuntime()
    const { client, hostErrors } = connect(fake)
    const remote = await connectRemoteAgentRuntime(client, 'native')
    const events: AgentEvent[] = []
    remote.subscribe((e) => events.push(e))
    fake.emit({ sessionId: 's1', type: 'output', data: 'x'.repeat(1024 * 1024 + 10) })
    fake.emit({ sessionId: 's1', type: 'output', data: 'small' })
    await tick()
    expect(events).toEqual([{ sessionId: 's1', type: 'output', data: 'small' }])
    expect(hostErrors).toHaveLength(1)
  })

  it('reports and drops a malformed event on the app side', async () => {
    const { client, server } = connect(new FakeRuntime())
    const appErrors: unknown[] = []
    const remote = await connectRemoteAgentRuntime(client, 'native', { onError: (e) => appErrors.push(e) })
    const events: AgentEvent[] = []
    remote.subscribe((e) => events.push(e))
    server.emit('runtime.native.event', { type: 'state' })
    await tick()
    expect(events).toEqual([])
    expect(appErrors).toHaveLength(1)
  })
})
