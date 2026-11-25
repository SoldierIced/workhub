import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  type AgentDefinition,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type PromptResult,
  type SessionHistorySource,
  type StartSessionRequest,
  type StartedSession,
  type TranscriptReader
} from '@workhub/core'
import {
  HostChannel,
  HostClient,
  connectRemoteAgentRuntime,
  connectRemoteHistorySources,
  connectRemoteTranscriptReaders,
  remoteFolders,
  remoteGitRunner,
  runHost,
  type HostedServices
} from '../src/host'
import type { GitRunner } from '../src/git-review'

const VERSION = '2.0.0-test'

class FakeRuntime implements AgentRuntime {
  readonly adapter = 'native' as const
  readonly calls: string[] = []
  private readonly listeners = new Set<AgentEventListener>()
  capabilities(agent: AgentDefinition) {
    return agent.capabilities
  }
  subscribe(listener: AgentEventListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event)
  }
  async start(req: StartSessionRequest): Promise<StartedSession> {
    this.calls.push('start')
    this.emit({ sessionId: req.sessionId, type: 'state', state: 'starting' })
    return { agentSessionId: 'agent-1', agentName: 'Fake agent', permissionMode: null }
  }
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    this.emit({ sessionId, type: 'message', role: 'agent', text: `echo ${text}` })
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async stop() {}
  async stopAll() {
    this.calls.push('stopAll')
  }
  respondPermission() {}
}

const transcript: TranscriptReader = {
  id: 'fake',
  read: async (q) => ({ title: `read ${q.agentSessionId}` }) as never,
  exists: async () => true,
  forget: () => {}
}

const history: SessionHistorySource = {
  list: async () => [{ agentSessionId: 'past-1', title: 'Fix the login page' } as never],
  messages: async () => []
}

function services() {
  const git = vi.fn<GitRunner>(async (cwd, args) => ({ ok: true, stdout: `${cwd} ${args.join(' ')}`, stderr: '' }))
  const native = new FakeRuntime()
  const terminal = new FakeRuntime()
  const hosted: HostedServices = { runtimes: { native, terminal, shell: terminal }, transcripts: [transcript], history: { claude: history }, git }
  return { hosted, git, native, terminal }
}

/** Starts a host over in-memory pipes and connects a client to it, as the app does. */
function connect(hosted: HostedServices) {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const lines: string[] = []
  fromHost.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)))
  const onExit = vi.fn()
  // The app listens before the host starts, as with a child's stdout.
  const client = new HostClient(new HostChannel(fromHost, toHost), { expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: VERSION } })
  const host = runHost({ input: toHost, output: fromHost, hostVersion: VERSION, services: hosted, platform: 'linux', home: '/users/ana', onExit })
  return { host, client, lines, onExit }
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workhub-host-'))
  await writeFile(join(dir, 'notes.txt'), 'hello')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('runHost', () => {
  it('says hello first, with its version, platform, home and features', async () => {
    const { client, lines } = connect(services().hosted)
    const hello = await client.ready

    expect(JSON.parse(lines[0]!)).toMatchObject({ t: 'hello', protocol: HOST_PROTOCOL_VERSION, hostVersion: VERSION })
    expect(hello).toMatchObject({ platform: 'linux', home: '/users/ana', pathFlavor: 'posix' })
    expect(hello.features).toEqual(['git', 'fs', 'transcripts', 'history', 'runtime.native', 'runtime.terminal', 'runtime.shell'])
    client.close()
  })

  it('answers git, file, transcript and history requests with its services', async () => {
    const { hosted, git } = services()
    const { client } = connect(hosted)

    expect(await remoteGitRunner(client)('/w/acme/api', ['status'])).toEqual({ ok: true, stdout: '/w/acme/api status', stderr: '' })
    expect(git).toHaveBeenCalledWith('/w/acme/api', ['status'], undefined)

    const folders = remoteFolders(client)
    expect(await folders.exists(dir)).toBe(true)
    expect(await folders.exists(join(dir, 'missing'))).toBe(false)
    expect(await folders.stat(join(dir, 'notes.txt'))).toMatchObject({ size: 5, isFile: true, isDirectory: false })
    expect(await folders.stat(dir)).toMatchObject({ isFile: false, isDirectory: true })
    expect(await folders.stat(join(dir, 'missing'))).toBeNull()
    // Resolved like the host does (Windows long names, not the 8.3 short ones of a temp folder).
    expect(await folders.realpath(dir)).toBe(await realpath(dir))
    expect(await folders.realpath(join(dir, 'missing'))).toBeNull()

    const [reader] = await connectRemoteTranscriptReaders(client)
    expect(await reader!.read({ agentSessionId: 'agent-1', cwd: '/w/acme/api' })).toEqual({ title: 'read agent-1' })

    const sources = await connectRemoteHistorySources(client)
    expect(await sources['claude']!.list({ agentId: 'claude', accountId: null })).toEqual([{ agentSessionId: 'past-1', title: 'Fix the login page' }])
    client.close()
  })

  it('rejects bad file params and keeps the remote checks soft', async () => {
    const { client } = connect(services().hosted)

    await expect(client.request('fs.stat', { path: '' })).rejects.toMatchObject({ code: 'bad_params' })
    client.close()
    expect(await remoteFolders(client).exists(dir)).toBe(false)
    expect(await remoteFolders(client).stat(dir)).toBeNull()
    expect(await remoteFolders(client).realpath(dir)).toBeNull()
  })

  it('runs a session on a hosted runtime and forwards its events', async () => {
    const { hosted, native } = services()
    const { client } = connect(hosted)
    const remote = await connectRemoteAgentRuntime(client, 'native')
    const events: AgentEvent[] = []
    remote.subscribe((e) => events.push(e))

    const agent = { id: 'claude', adapter: 'native' } as AgentDefinition
    await remote.start({ sessionId: 's1', agent, account: null, cwd: '/w/acme/api', env: {} })
    expect(await remote.prompt('s1', 'hi')).toEqual({ stopReason: 'end_turn' })

    expect(native.calls).toEqual(['start'])
    expect(events).toEqual([
      { sessionId: 's1', type: 'state', state: 'starting' },
      { sessionId: 's1', type: 'message', role: 'agent', text: 'echo hi' }
    ])
    client.close()
  })

  it('stops every runtime once and exits when the app closes the channel', async () => {
    const { hosted, native, terminal } = services()
    const { client, onExit } = connect(hosted)
    await client.ready

    client.close()
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0))
    expect(native.calls).toEqual(['stopAll'])
    // `terminal` and `shell` are the same runtime: stopped once.
    expect(terminal.calls).toEqual(['stopAll'])
  })

  it('shuts down on request (a signal), closing the channel first', async () => {
    const { hosted, native } = services()
    const { host, client, onExit } = connect(hosted)
    await client.ready
    const closed = new Promise<string>((resolve) => client.onClose(resolve))

    await host.shutdown()
    expect(native.calls).toEqual(['stopAll'])
    expect(onExit).toHaveBeenCalledTimes(1)
    await expect(closed).resolves.toBe('the host channel closed')
  })
})
