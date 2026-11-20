import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDefinition, AgentEvent, AgentEventListener, AgentRuntime, PromptResult, StartSessionRequest, StartedSession } from '@workhub/core'
import { runHost, type HostedServices, type RunHostOptions, type RunningHost } from '@workhub/adapters/host'
import type { GitRunner } from '@workhub/adapters/git-review'
import { CHILD_HOST_ID, HostProcess, type HostChild } from '../src/main/host-process'

const VERSION = '2.0.0-test'
/** Lets pending stream callbacks and promises run (setImmediate is real under the fake timers used here). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

class FakeRuntime implements AgentRuntime {
  readonly calls: string[] = []
  private readonly listeners = new Set<AgentEventListener>()
  constructor(readonly adapter: AgentRuntime['adapter']) {}
  capabilities(agent: AgentDefinition) {
    return agent.capabilities
  }
  subscribe(listener: AgentEventListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async start(req: StartSessionRequest): Promise<StartedSession> {
    this.calls.push(`start ${req.cwd}`)
    for (const l of this.listeners) l({ sessionId: req.sessionId, type: 'state', state: 'ready' })
    return { agentSessionId: 'agent-1', agentName: 'Fake agent', permissionMode: null }
  }
  async prompt(): Promise<PromptResult> {
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async stop() {}
  async stopAll() {
    this.calls.push('stopAll')
  }
  respondPermission() {}
}

function services(): HostedServices & { runtimes: Record<string, FakeRuntime> } {
  const git: GitRunner = async (cwd, args) => ({ ok: true, stdout: `${cwd}: ${args.join(' ')}`, stderr: '' })
  const terminal = new FakeRuntime('terminal')
  return { runtimes: { native: new FakeRuntime('native'), acp: new FakeRuntime('acp'), terminal }, transcripts: [], history: {}, git }
}

/** A child process whose stdio is served by runHost in this process, as the real entry does. */
class FakeChild extends EventEmitter implements HostChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly host: RunningHost
  readonly signals: string[] = []
  private gone = false

  constructor(
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
    readonly hosted = services(),
    hostVersion = args[args.indexOf('--host-version') + 1]!,
    host: Partial<RunHostOptions> = {}
  ) {
    super()
    this.host = runHost({ input: this.stdin, output: this.stdout, hostVersion, services: hosted, platform: 'linux', home: '/users/ana', onExit: (code) => this.exit(code), ...host })
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    void this.host.shutdown()
    return true
  }

  /** The process dies on its own: its stdout ends and it exits. */
  crash(): void {
    this.stdout.end()
    this.exit(1)
  }

  private exit(code: number): void {
    if (this.gone) return
    this.gone = true
    queueMicrotask(() => this.emit('exit', code, null))
  }
}

function setup(overrides: { hostVersion?: string } = {}) {
  const children: FakeChild[] = []
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }
  const onRestart = vi.fn()
  const onLost = vi.fn()
  /** Set to make every child started from now on die at once, or say another version. */
  const behavior: { crashOnStart: boolean; hostVersion?: string } = { crashOnStart: false }
  const hostProcess = new HostProcess({
    entry: '/w/acme/out/main/host.js',
    execPath: '/w/acme/workhub',
    args: ['--bridge-dir', '/w/acme/bridge'],
    hostVersion: VERSION,
    log,
    onRestart,
    onLost,
    env: { PATH: '/usr/bin' },
    spawn: (command, args, env) => {
      expect(command).toBe('/w/acme/workhub')
      const child = new FakeChild(args, env, services(), behavior.hostVersion ?? overrides.hostVersion)
      children.push(child)
      if (behavior.crashOnStart) child.crash()
      return child
    },
    kill: (child) => child.kill('SIGTERM'),
    backoff: { initialMs: 1_000, maxMs: 4_000 }
  })
  return { hostProcess, children, log, onRestart, onLost, behavior }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('HostProcess', () => {
  it('starts the entry as Node and connects a host whose services run in the child', async () => {
    const { hostProcess, children } = setup()
    const host = await hostProcess.connect()
    const child = children[0]!

    expect(child.args).toEqual(['/w/acme/out/main/host.js', '--stdio', '--host-version', VERSION, '--bridge-dir', '/w/acme/bridge'])
    expect(child.env).toEqual({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' })
    expect(host.id).toBe(CHILD_HOST_ID)
    expect(await host.git('/w/acme/api', ['status'])).toEqual({ ok: true, stdout: '/w/acme/api: status', stderr: '' })
    expect(await host.exists('/w/acme/does-not-exist')).toBe(false)
    expect(await host.stat('/w/acme/does-not-exist')).toBeNull()

    const events: AgentEvent[] = []
    host.services.runtimes.native.subscribe((e) => events.push(e))
    await host.services.runtimes.native.start({ sessionId: 's1', agent: { id: 'claude', adapter: 'native' } as AgentDefinition, account: null, cwd: '/w/acme/api', env: {} })
    expect(child.hosted.runtimes['native']!.calls).toEqual(['start /w/acme/api'])
    expect(events).toEqual([{ sessionId: 's1', type: 'state', state: 'ready' }])
    // The terminal runtime is one, and a raw terminal reports no structured capabilities.
    expect(host.services.terminal).toBe(host.services.runtimes.terminal)
    expect(host.services.terminal.capabilities({ capabilities: { cost: true } } as unknown as AgentDefinition)).not.toHaveProperty('cost', true)
    // A child without a relay socket leaves its sessions on main's own endpoint.
    expect(host.control).toBeUndefined()
    hostProcess.stop()
  })

  it.skipIf(process.platform === 'win32')("relays the host socket's requests to main and reports where its sessions reach Workhub", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-hp-'))
    const socket = join(dir, 'host.sock')
    const served: { method: string; url: string; token: unknown; body?: string }[] = []
    const hostProcess = new HostProcess({
      id: 'wsl:Ubuntu',
      launch: () => ({ command: 'wsl.exe', args: ['--host-version', VERSION], env: {} }),
      hostVersion: VERSION,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      spawn: (_command, args, env) => new FakeChild(args, env, services(), VERSION, { control: { socketPath: socket }, node: '/opt/wh/node/bin/node', bridgeDir: '/opt/wh/bridge' }),
      kill: (child) => child.kill('SIGTERM'),
      serveControl: () => async (req) => {
        served.push({ method: req.method, url: req.url, token: req.headers['x-workhub-token'], body: req.body })
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true,"from":"main"}' }
      }
    })
    try {
      const host = await hostProcess.connect()
      expect(host.control).toEqual({ socket, node: '/opt/wh/node/bin/node', mcpScript: join('/opt/wh/bridge', 'workhub-mcp.mjs') })
      const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ socketPath: socket, method: 'POST', path: '/v1/notify', headers: { 'x-workhub-token': 'st' } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
        })
        req.on('error', reject)
        req.end('{"title":"done"}')
      })
      expect(answer).toEqual({ status: 200, body: '{"ok":true,"from":"main"}' })
      expect(served).toEqual([{ method: 'POST', url: '/v1/notify', token: 'st', body: '{"title":"done"}' }])
    } finally {
      hostProcess.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends what the child writes to stderr to the log', async () => {
    const { hostProcess, children, log } = setup()
    await hostProcess.connect()

    children[0]!.stderr.write('[host] warming up\n')
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith('host: [host] warming up'))
    hostProcess.stop()
  })

  it('refuses a host of another version, logs it and ends the child', async () => {
    const { hostProcess, children, log } = setup({ hostVersion: '1.9.0' })

    await expect(hostProcess.connect()).rejects.toMatchObject({ reason: 'version_mismatch' })
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('incompatible host'))
    expect(children[0]!.signals).toEqual(['SIGTERM'])
  })

  it('restarts a host that went away, with a growing delay, and hands the new host over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { hostProcess, children, log, onRestart, onLost } = setup()
    const first = await hostProcess.connect()
    const events: AgentEvent[] = []
    first.services.runtimes.native.subscribe((e) => events.push(e))
    await first.services.runtimes.native.start({ sessionId: 's1', agent: { id: 'claude', adapter: 'native' } as AgentDefinition, account: null, cwd: '/w/acme/api', env: {} })

    children[0]!.crash()
    await settle()
    // The live session is left in error by its runtime proxy.
    expect(events.at(-1)).toMatchObject({ sessionId: 's1', type: 'state', state: 'error' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('restarting in 1000 ms'))
    expect(onLost).toHaveBeenCalledWith('the host process exited (1)', true)
    expect(children).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(children).toHaveLength(2)
    await settle()
    expect(onRestart).toHaveBeenCalledTimes(1)
    const second = onRestart.mock.calls[0]![0]
    expect(second).not.toBe(first)
    expect(await second.git('/w/acme/api', ['log'])).toMatchObject({ ok: true })

    // A restart that succeeded resets the delay; one that keeps failing doubles it, up to the cap.
    children[1]!.crash()
    await settle()
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('restarting in 1000 ms'))
    hostProcess.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(children).toHaveLength(2)
  })

  it('backs off up to the cap while restarts fail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { hostProcess, children, log, onRestart, behavior } = setup()
    await hostProcess.connect()

    behavior.crashOnStart = true
    children[0]!.crash()
    for (const expected of [1000, 2000, 4000, 4000]) {
      await settle()
      expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining(`restarting in ${expected} ms`))
      const before = children.length
      await vi.advanceTimersByTimeAsync(expected - 1)
      expect(children).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(children).toHaveLength(before + 1)
    }
    expect(onRestart).not.toHaveBeenCalled()
    hostProcess.stop()
  })

  it('says when a lost host is given up on (a restart that cannot be used)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { hostProcess, children, onLost, behavior } = setup()
    await hostProcess.connect()
    behavior.hostVersion = '1.9.0'
    children[0]!.crash()
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(onLost.mock.calls[0]).toEqual(['the host process exited (1)', true])
    expect(onLost.mock.lastCall).toEqual([expect.stringContaining('incompatible host'), false])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(children).toHaveLength(2)
    hostProcess.stop()
  })

  it('ends the child when the app quits and does not start it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { hostProcess, children } = setup()
    await hostProcess.connect()
    const child = children[0]!

    hostProcess.stop()
    await settle()
    expect(child.hosted.runtimes['native']!.calls).toEqual(['stopAll'])
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(children).toHaveLength(1)
  })
})

describe('HostProcess with a launch of its own', () => {
  it('spawns the command and arguments it is given, its variables over the environment, under its id', async () => {
    const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const launch = vi.fn(() => ({ command: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '~', '-e', '/users/ana/node', '/users/ana/host.js', '--stdio', '--host-version', VERSION], env: { WSLENV: '' } }))
    const hostProcess = new HostProcess({
      id: 'wsl:Ubuntu',
      launch,
      hostVersion: VERSION,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      env: { PATH: '/usr/bin', WSLENV: 'TOKEN/u' },
      spawn: (command, args, env) => {
        spawned.push({ command, args, env })
        return new FakeChild(args, env)
      },
      kill: (child) => child.kill('SIGTERM')
    })
    const host = await hostProcess.connect()
    expect(host.id).toBe('wsl:Ubuntu')
    expect(spawned).toEqual([{ command: 'wsl.exe', args: launch.mock.results[0]!.value.args, env: { PATH: '/usr/bin', WSLENV: '' } }])
    // Not run as Electron's Node: that variable belongs to the default launch only.
    expect(spawned[0]!.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(await host.git('/w/acme/api', ['status'])).toMatchObject({ ok: true })
    // A host started elsewhere without a relay socket gives its sessions no endpoint.
    expect(host.control).toBeNull()
    hostProcess.stop()
  })

  it('refuses to start with neither an entry nor a launch', async () => {
    const hostProcess = new HostProcess({ hostVersion: VERSION, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, spawn: () => { throw new Error('not spawned') } })
    await expect(hostProcess.connect()).rejects.toThrow(/an entry or a launch/)
  })
})
