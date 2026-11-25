import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyConfig,
  NO_CAPABILITIES,
  type AgentAdapterKind,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ConfigurationService,
  type ProfileHost,
  type SessionHistorySource,
  type StartSessionRequest,
  type TranscriptReader
} from '@workhub/core'
import type { GitRunner } from '@workhub/adapters/git-review'
import type { ExecutionServices } from '@workhub/adapters/host'
import { followHostStatus, HostRegistry, localHost, originUrl, type HostTarget, type PendingHost } from '../src/main/hosts'
import { SessionManager, type PendingServices, type SessionServices } from '../src/main/session-manager'

/** A runtime that records what it was asked and lets the test emit events. */
class FakeRuntime implements AgentRuntime {
  started: StartSessionRequest[] = []
  prompts: string[] = []
  writes: [string, string][] = []
  stoppedAll = 0
  private listeners = new Set<AgentEventListener>()
  constructor(readonly adapter: AgentAdapterKind) {}
  capabilities() {
    return { ...NO_CAPABILITIES, appMode: true }
  }
  async start(r: StartSessionRequest) {
    this.started.push(r)
    this.emit({ sessionId: r.sessionId, type: 'state', state: 'ready' })
    return { agentName: 'Fake', permissionMode: null, agentSessionId: r.agentSessionId }
  }
  async prompt(_id: string, text: string) {
    this.prompts.push(text)
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async stop() {}
  async stopAll() {
    this.stoppedAll++
  }
  respondPermission() {}
  write(id: string, data: string) {
    this.writes.push([id, data])
  }
  resize() {}
  subscribe(l: AgentEventListener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit(e: AgentEvent) {
    for (const l of this.listeners) l(e)
  }
}

function services(said: string): SessionServices & { native: FakeRuntime; terminal: FakeRuntime; claude: SessionHistorySource; transcript: TranscriptReader } {
  const native = new FakeRuntime('native')
  const terminal = new FakeRuntime('terminal')
  const claude: SessionHistorySource = { list: async () => [], messages: vi.fn(async () => [{ kind: 'user' as const, text: said }]) }
  const transcript: TranscriptReader = { id: 'claude', read: vi.fn(async () => null), exists: vi.fn(async () => true), forget: () => {} }
  return { runtimes: { native }, terminal, transcripts: [transcript], history: { claude }, native, claude, transcript }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(hostFor?: (target: HostTarget) => SessionServices | PendingServices) {
  const local = services('on this computer')
  const events: AgentEvent[] = []
  const manager = new SessionManager({
    config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    ...local,
    ...(hostFor ? { hostFor } : {}),
    emitEvent: (e) => events.push(e),
    emitChanged: () => {},
    emitReplay: () => {},
    pollMs: 60_000
  })
  return { manager, local, events }
}

describe('SessionManager: services per host', () => {
  it('runs every session on the services it was given when no host resolver is set', async () => {
    const { manager, local } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    await flush()
    await manager.prompt(view.id, 'hello')
    expect(local.native.started).toHaveLength(1)
    expect(local.native.prompts).toEqual(['hello'])
    expect(manager.list()[0]!.state).toBe('ready')
  })

  it('starts, prompts, reads history and transcripts and writes terminals on the host the resolver picks', async () => {
    const remote = services('on the other host')
    const asked: HostTarget[] = []
    const { manager, local, events } = setup((target) => {
      asked.push(target)
      return target.profileId === 'elsewhere' ? remote : local
    })
    const here = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    const there = await manager.start({ profileId: 'elsewhere', agentKey: 'claude', cwd: '/w/acme/web', resumeAgentSessionId: 'abc' })
    await flush()
    expect(asked).toEqual([{ profileId: null }, { profileId: 'elsewhere' }])
    expect(local.native.started.map((r) => r.sessionId)).toEqual([here.id])
    expect(remote.native.started.map((r) => r.sessionId)).toEqual([there.id])
    // The other host's runtime is subscribed: its events reach the session.
    expect(events.some((e) => e.sessionId === there.id && e.type === 'state')).toBe(true)
    expect(manager.list().find((v) => v.id === there.id)!.state).toBe('ready')

    await manager.prompt(there.id, 'over there')
    expect(remote.native.prompts).toEqual(['over there'])
    expect(local.native.prompts).toEqual([])

    expect(await manager.history(there.id)).toEqual([{ kind: 'user', text: 'on the other host' }])
    expect(remote.transcript.exists).toHaveBeenCalled()
    expect(local.transcript.exists).not.toHaveBeenCalled()

    manager.write(`${there.id}:shell`, 'ls\r')
    manager.write(`${here.id}:shell`, 'pwd\r')
    expect(remote.terminal.writes).toEqual([[`${there.id}:shell`, 'ls\r']])
    expect(local.terminal.writes).toEqual([[`${here.id}:shell`, 'pwd\r']])

    await manager.stopAll()
    expect([local.native.stoppedAll, local.terminal.stoppedAll, remote.native.stoppedAll, remote.terminal.stoppedAll]).toEqual([1, 1, 1, 1])
  })

  it("names the session's host in its view, except this computer", async () => {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu' }
    const { manager, local } = setup((target) => (target.profileId === 'acme' ? wsl : { ...local, hostId: 'local' }))
    const there = await manager.start({ profileId: 'acme', agentKey: 'claude', cwd: '/w/acme/web' })
    const here = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    expect(there.hostId).toBe('wsl:Ubuntu')
    expect(here.hostId).toBeUndefined()
    await manager.stopAll()
  })
})

/** A WSL host that has not connected yet: `connect` or `fail` settles it. */
function connecting(hostId = 'wsl:Ubuntu') {
  let connect!: (s: SessionServices) => void
  let fail!: (err: Error) => void
  const ready = new Promise<SessionServices>((resolve, reject) => {
    connect = resolve
    fail = reject
  })
  ready.catch(() => undefined)
  const pending: PendingServices = { hostId, ready }
  return { pending, connect, fail }
}

describe('SessionManager: a host that has not connected yet', () => {
  it('lists a session restored before its host connects under that host, and binds it to the host once it connects', async () => {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu' }
    const host = connecting()
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? host.pending : local))
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', resumeAgentSessionId: 'abc' }, { restored: true, dormant: true })
    // The tag shows at once; nothing runs anywhere while it waits.
    expect(view).toMatchObject({ state: 'stopped', hostId: 'wsl:Ubuntu' })
    host.connect(wsl)
    await flush()
    expect(local.native.started).toEqual([])
    expect(wsl.native.started).toEqual([])
    // Bound to the host: its past conversation is read there.
    expect(await manager.history(view.id)).toEqual([{ kind: 'user', text: 'in WSL' }])
    expect(local.claude.messages).not.toHaveBeenCalled()
  })

  it('starts a session restored at launch on its host once that host connects, never on this computer', async () => {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu' }
    const host = connecting()
    let connected = false
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? (connected ? wsl : host.pending) : local))
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', resumeAgentSessionId: 'abc' }, { restored: true })
    expect(view).toMatchObject({ state: 'stopped', hostId: 'wsl:Ubuntu' })
    connected = true
    host.connect(wsl)
    await vi.waitFor(() => expect(wsl.native.started.map((r) => r.agentSessionId)).toEqual(['abc']))
    expect(local.native.started).toEqual([])
    // The session that started replaced the one that waited.
    expect(manager.list()).toEqual([expect.objectContaining({ state: 'ready', hostId: 'wsl:Ubuntu', agentSessionId: 'abc' })])
    await manager.stopAll()
  })

  it('shows why a restored session cannot start when its host fails, and starts nothing on this computer', async () => {
    const host = connecting()
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? host.pending : local))
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', resumeAgentSessionId: 'abc' }, { restored: true })
    host.fail(new Error('WSL host Ubuntu is not available: the host process exited (1)'))
    await flush()
    expect(manager.list()).toEqual([expect.objectContaining({ id: view.id, state: 'error', error: 'WSL host Ubuntu is not available: the host process exited (1)', hostId: 'wsl:Ubuntu' })])
    expect(local.native.started).toEqual([])
  })

  it('makes a new session wait for its host, then runs it there', async () => {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu' }
    const host = connecting()
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? host.pending : local))
    let started: { id: string; hostId?: string } | undefined
    const starting = manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme' }).then((v) => (started = v))
    await flush()
    expect(started).toBeUndefined()
    expect(manager.list()).toEqual([])
    host.connect(wsl)
    await starting
    await flush()
    expect(started!.hostId).toBe('wsl:Ubuntu')
    expect(wsl.native.started.map((r) => r.sessionId)).toEqual([started!.id])
    expect(local.native.started).toEqual([])
    await manager.stopAll()
  })

  it('refuses a new session whose host failed, with the reason', async () => {
    const host = connecting()
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? host.pending : local))
    const starting = manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme' })
    host.fail(new Error('WSL host Ubuntu is not available: WSL distributions are used only on Windows'))
    await expect(starting).rejects.toThrow('WSL host Ubuntu is not available: WSL distributions are used only on Windows')
    expect(manager.list()).toEqual([])
    expect(local.native.started).toEqual([])
  })

  it('leaves the sessions of local profiles alone while another host connects', async () => {
    const host = connecting()
    const { manager, local } = setup((target) => (target.profileId === 'linux' ? host.pending : local))
    const here = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    const restored = await manager.start({ profileId: 'mine', agentKey: 'claude', cwd: '/w/acme/web', resumeAgentSessionId: 'def' }, { restored: true })
    await flush()
    expect(local.native.started.map((r) => r.sessionId)).toEqual([here.id, restored.id])
    expect(here.hostId).toBeUndefined()
    expect(restored.hostId).toBeUndefined()
    await manager.stopAll()
  })
})

describe('SessionManager: control endpoint per host', () => {
  it("hands each session its host's control info for its environment and Workhub's MCP server", async () => {
    const remote = { ...services('on the other host'), control: { socket: '/run/wh/host-1.sock', node: '/opt/wh/node', mcpScript: '/opt/wh/bridge/workhub-mcp.mjs' } }
    const local = services('on this computer')
    const envFor = vi.fn((id: string, control: unknown) => ({ WORKHUB_SESSION: id, WORKHUB_SOCKET: control ? (control as { socket: string }).socket : '/app.sock' }))
    const mcpFor = vi.fn(async () => [])
    const manager = new SessionManager({
      config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      ...local,
      hostFor: (target) => (target.profileId === 'wsl' ? remote : local),
      sessionEnv: envFor,
      sessionMcp: mcpFor,
      emitEvent: () => {},
      emitChanged: () => {},
      emitReplay: () => {},
      pollMs: 60_000
    })
    const here = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    const there = await manager.start({ profileId: 'wsl', agentKey: 'claude', cwd: '/w/acme/web' })
    await flush()
    expect(envFor.mock.calls).toEqual([
      [here.id, undefined],
      [there.id, remote.control]
    ])
    expect(mcpFor.mock.calls.map((c) => (c as unknown[])[2])).toEqual([undefined, remote.control])
    expect(remote.native.started[0]!.env).toMatchObject({ WORKHUB_SESSION: there.id, WORKHUB_SOCKET: '/run/wh/host-1.sock' })
    expect(local.native.started[0]!.env).toMatchObject({ WORKHUB_SESSION: here.id, WORKHUB_SOCKET: '/app.sock' })
    await manager.stopAll()
  })
})

describe('SessionManager: a restored session bound to its host later', () => {
  function restoredSetup() {
    const control = { socket: '/run/wh/host-1.sock', node: '/opt/wh/node', mcpScript: '/opt/wh/bridge/workhub-mcp.mjs' }
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu', control }
    const host = connecting()
    const local = services('on this computer')
    const envFor = vi.fn((id: string, c: unknown) => ({ WORKHUB_SESSION: id, WORKHUB_SOCKET: c ? (c as { socket: string }).socket : '/app.sock' }))
    const mcpFor = vi.fn(async (_env: Record<string, string>, _agent: unknown, c: unknown) => [{ name: 'workhub', command: c ? (c as { node: string }).node : 'C:\\Workhub\\Workhub.exe', args: [], env: {} }])
    const manager = new SessionManager({
      config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      ...local,
      hostFor: (target) => (target.profileId === 'linux' ? host.pending : local),
      sessionEnv: envFor,
      sessionMcp: mcpFor,
      emitEvent: () => {},
      emitChanged: () => {},
      emitReplay: () => {},
      pollMs: 60_000
    })
    return { manager, local, wsl, host, control }
  }

  it("refuses to switch modes or open the shell while the session's host has not connected", async () => {
    const { manager, local } = restoredSetup()
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', resumeAgentSessionId: 'abc' }, { restored: true, dormant: true })
    await expect(manager.setMode(view.id, 'shell')).rejects.toThrow('WSL host Ubuntu has not connected yet')
    await expect(manager.setMode(view.id, 'app')).rejects.toThrow('WSL host Ubuntu has not connected yet')
    expect(local.terminal.started).toEqual([])
    expect(local.native.started).toEqual([])
  })

  it("rebuilds its environment and Workhub's MCP server from the host's control once it connects", async () => {
    const { manager, local, wsl, host, control } = restoredSetup()
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', resumeAgentSessionId: 'abc' }, { restored: true, dormant: true })
    host.connect(wsl)
    await flush()
    await flush()
    await manager.setMode(view.id, 'app')
    await vi.waitFor(() => expect(wsl.native.started).toHaveLength(1))
    expect(local.native.started).toEqual([])
    const started = wsl.native.started[0]!
    expect(started.env).toMatchObject({ WORKHUB_SESSION: view.id, WORKHUB_SOCKET: control.socket })
    expect(JSON.stringify(started)).not.toContain('Workhub.exe')
    await manager.stopAll()
  })
})

describe('SessionManager: worktrees on another host', () => {
  function worktreeSetup() {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu' }
    const local = services('on this computer')
    const worktrees = { repoRootOf: vi.fn(async () => '/home/ana/acme'), create: vi.fn(async () => undefined), remove: vi.fn(), status: vi.fn() }
    const manager = new SessionManager({
      config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      ...local,
      hostFor: (target) => (target.profileId === 'linux' ? wsl : local),
      worktrees: worktrees as never,
      emitEvent: () => {},
      emitChanged: () => {},
      emitReplay: () => {},
      pollMs: 60_000
    })
    return { manager, wsl, worktrees }
  }

  it('refuses a session that asks for a worktree on a WSL host, and makes none', async () => {
    const { manager, wsl, worktrees } = worktreeSetup()
    await expect(manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', worktree: { branch: 'fix' } })).rejects.toThrow('Worktrees are not available in WSL yet')
    expect(worktrees.repoRootOf).not.toHaveBeenCalled()
    expect(worktrees.create).not.toHaveBeenCalled()
    expect(wsl.native.started).toEqual([])
  })

  it('starts a session that only takes a worktree when it can in the folder itself', async () => {
    const { manager, wsl, worktrees } = worktreeSetup()
    const view = await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme', worktree: { optional: true } })
    expect(view).toMatchObject({ cwd: '/home/ana/acme', hostId: 'wsl:Ubuntu' })
    expect(view.worktree).toBeUndefined()
    expect(worktrees.create).not.toHaveBeenCalled()
    await flush()
    expect(wsl.native.started.map((r) => r.cwd)).toEqual(['/home/ana/acme'])
    await manager.stopAll()
  })
})

describe('SessionManager: accounts and home on another host', () => {
  function accountSetup() {
    const wsl = { ...services('in WSL'), hostId: 'wsl:Ubuntu', home: '/home/ana' }
    const local = services('on this computer')
    const config = { ...emptyConfig(), accounts: [{ id: 'work', agentId: 'claude', name: 'Work', configDir: 'C:\\Users\\ana\\.claude-work' }, { id: 'plain', agentId: 'claude', name: 'Plain' }] }
    const profileEnv = vi.fn(async (_profileId: string | null, _cwd: string, _home?: string | null) => ({}))
    const manager = new SessionManager({
      config: { current: async () => config, replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      ...local,
      hostFor: (target) => (target.profileId === 'linux' ? wsl : local),
      profileEnv,
      emitEvent: () => {},
      emitChanged: () => {},
      emitReplay: () => {},
      pollMs: 60_000
    })
    return { manager, wsl, local, profileEnv }
  }

  it('refuses an account with its own config folder for a session in WSL, and starts nothing', async () => {
    const { manager, wsl } = accountSetup()
    await expect(manager.start({ profileId: 'linux', agentKey: 'claude:work', cwd: '/home/ana/acme' })).rejects.toThrow('The account Work has its own config folder')
    expect(wsl.native.started).toEqual([])
  })

  it("still runs that account on this computer, and an account without one in WSL", async () => {
    const { manager, wsl, local } = accountSetup()
    await manager.start({ profileId: null, agentKey: 'claude:work', cwd: '/w/acme' })
    await manager.start({ profileId: 'linux', agentKey: 'claude:plain', cwd: '/home/ana/acme' })
    await flush()
    expect(local.native.started).toHaveLength(1)
    expect(wsl.native.started).toHaveLength(1)
    await manager.stopAll()
  })

  it("expands the profile environment with the host's home, and this computer's for local sessions", async () => {
    const { manager, profileEnv } = accountSetup()
    await manager.start({ profileId: 'linux', agentKey: 'claude', cwd: '/home/ana/acme' })
    await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme' })
    expect(profileEnv.mock.calls).toEqual([
      ['linux', '/home/ana/acme', '/home/ana'],
      [null, '/w/acme', undefined]
    ])
    await manager.stopAll()
  })
})

describe('HostRegistry', () => {
  const execution = {} as ExecutionServices

  it('resolves every profile to the local host for now', () => {
    const hosts = new HostRegistry(localHost(execution))
    hosts.register({ ...localHost(execution), id: 'wsl:dev' })
    expect(hosts.hostFor({ profileId: 'any' })).toBe(hosts.local)
    expect(hosts.hostFor({ profileId: null }).id).toBe('local')
    expect(hosts.get('wsl:dev')?.id).toBe('wsl:dev')
  })

  it('resolves every profile to the preferred host while it is registered, its latest instance', () => {
    const hosts = new HostRegistry(localHost(execution))
    hosts.prefer('child')
    expect(hosts.hostFor({ profileId: 'any' })).toBe(hosts.local)

    const first = { ...localHost(execution), id: 'child' }
    hosts.register(first)
    expect(hosts.hostFor({ profileId: 'any' })).toBe(first)
    const restarted = { ...localHost(execution), id: 'child' }
    hosts.register(restarted)
    expect(hosts.hostFor({ profileId: null })).toBe(restarted)

    hosts.prefer(null)
    expect(hosts.hostFor({ profileId: 'any' })).toBe(hosts.local)
  })

  it("resolves a profile to the host it names while that host is registered, else to this computer", () => {
    const named: Record<string, ProfileHost> = { linux: { kind: 'wsl', distro: 'Ubuntu' }, here: { kind: 'local' } }
    const hosts = new HostRegistry(localHost(execution), (id) => named[id])
    expect(hosts.hostFor({ profileId: 'linux' })).toBe(hosts.local)

    const wsl = { ...localHost(execution), id: 'wsl:Ubuntu' }
    hosts.register(wsl)
    expect(hosts.hostFor({ profileId: 'linux' })).toBe(wsl)
    expect(hosts.hostFor({ profileId: 'here' })).toBe(hosts.local)
    expect(hosts.hostFor({ profileId: 'other' })).toBe(hosts.local)
    expect(hosts.hostFor({ profileId: null })).toBe(hosts.local)
  })

  it('runs only the profiles that name no host on the preferred host', () => {
    const named: Record<string, ProfileHost> = { linux: { kind: 'wsl', distro: 'Debian' }, here: { kind: 'local' } }
    const hosts = new HostRegistry(localHost(execution), (id) => named[id])
    const child = { ...localHost(execution), id: 'child' }
    hosts.register(child)
    hosts.prefer('child')
    expect(hosts.hostFor({ profileId: 'unnamed' })).toBe(child)
    expect(hosts.hostFor({ profileId: null })).toBe(child)
    expect(hosts.hostFor({ profileId: 'here' })).toBe(hosts.local)
    // Its distribution is not connected: this computer, not the preferred host.
    expect(hosts.hostFor({ profileId: 'linux' })).toBe(hosts.local)
  })

  describe('sessionHostFor', () => {
    const named: Record<string, ProfileHost> = { linux: { kind: 'wsl', distro: 'Ubuntu' }, here: { kind: 'local' } }
    const pending = (x: unknown): PendingHost => {
      expect(x).toHaveProperty('ready')
      return x as PendingHost
    }

    it('waits for a named host that has not connected, and resolves to it once it registers', async () => {
      const hosts = new HostRegistry(localHost(execution), (id) => named[id])
      const waiting = pending(hosts.sessionHostFor({ profileId: 'linux' }))
      expect(waiting.id).toBe('wsl:Ubuntu')
      const wsl = { ...localHost(execution), id: 'wsl:Ubuntu' }
      hosts.register(wsl)
      await expect(waiting.ready).resolves.toBe(wsl)
      expect(hosts.sessionHostFor({ profileId: 'linux' })).toBe(wsl)
    })

    it('rejects with the reason when the host fails, now and for later sessions until it starts again', async () => {
      const hosts = new HostRegistry(localHost(execution), (id) => named[id])
      const waiting = pending(hosts.sessionHostFor({ profileId: 'linux' }))
      hosts.failed('wsl:Ubuntu', 'the host process exited (1)')
      await expect(waiting.ready).rejects.toThrow('WSL host Ubuntu is not available: the host process exited (1)')
      await expect(pending(hosts.sessionHostFor({ profileId: 'linux' })).ready).rejects.toThrow('the host process exited (1)')
      // Retried: sessions wait again.
      hosts.starting('wsl:Ubuntu')
      const again = pending(hosts.sessionHostFor({ profileId: 'linux' }))
      const wsl = { ...localHost(execution), id: 'wsl:Ubuntu' }
      hosts.register(wsl)
      await expect(again.ready).resolves.toBe(wsl)
    })

    it('makes new sessions wait while a dropped host restarts, never handing out the closed one', async () => {
      const hosts = new HostRegistry(localHost(execution), (id) => named[id])
      const old = { ...localHost(execution), id: 'wsl:Ubuntu' }
      followHostStatus(hosts, 'wsl:Ubuntu', { type: 'connecting' })
      hosts.register(old)
      expect(hosts.sessionHostFor({ profileId: 'linux' })).toBe(old)
      followHostStatus(hosts, 'wsl:Ubuntu', { type: 'lost', reason: 'the host process exited (1)', restarting: true })
      const waiting = pending(hosts.sessionHostFor({ profileId: 'linux' }))
      expect(hosts.get('wsl:Ubuntu')).toBeUndefined()
      const restarted = { ...localHost(execution), id: 'wsl:Ubuntu' }
      hosts.register(restarted)
      await expect(waiting.ready).resolves.toBe(restarted)
    })

    it('fails the waiting sessions when the host status says it failed or is unavailable', async () => {
      const hosts = new HostRegistry(localHost(execution), (id) => named[id])
      const waiting = pending(hosts.sessionHostFor({ profileId: 'linux' }))
      followHostStatus(hosts, 'wsl:Ubuntu', { type: 'failed', detail: 'no WSL' })
      await expect(waiting.ready).rejects.toThrow('WSL host Ubuntu is not available: no WSL')
    })

    it('gives up on a host that does not connect in time', async () => {
      vi.useFakeTimers()
      try {
        const hosts = new HostRegistry(localHost(execution), (id) => named[id])
        const waiting = pending(hosts.sessionHostFor({ profileId: 'linux' }, 30_000))
        vi.advanceTimersByTime(30_000)
        await expect(waiting.ready).rejects.toThrow('WSL host Ubuntu is not available: it did not connect within 30 s')
      } finally {
        vi.useRealTimers()
      }
    })

    it('never waits for profiles that name this computer or no host', () => {
      const hosts = new HostRegistry(localHost(execution), (id) => named[id])
      expect(hosts.sessionHostFor({ profileId: 'here' })).toBe(hosts.local)
      expect(hosts.sessionHostFor({ profileId: 'other' })).toBe(hosts.local)
      expect(hosts.sessionHostFor({ profileId: null })).toBe(hosts.local)
    })
  })

  it('keeps the local host fixed', () => {
    const hosts = new HostRegistry(localHost(execution))
    expect(() => hosts.register(localHost(execution))).toThrow()
    expect(() => new HostRegistry({ ...localHost(execution), id: 'other' })).toThrow()
  })
})

describe('the local host folder facade', () => {
  it("runs the composition's git and looks at this computer's disk", async () => {
    const git: GitRunner = vi.fn(async () => ({ ok: true, stdout: 'x', stderr: '' }))
    const host = localHost({ git } as unknown as ExecutionServices)
    await host.git('/w/acme', ['status'])
    expect(git).toHaveBeenCalledWith('/w/acme', ['status'])
    const dir = mkdtempSync(join(tmpdir(), 'workhub-host-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')
    expect(await host.exists(file)).toBe(true)
    expect(await host.exists(join(dir, 'missing'))).toBe(false)
    expect(await host.stat(file)).toMatchObject({ size: 5, isFile: true, isDirectory: false })
    expect(await host.stat(dir)).toMatchObject({ isFile: false, isDirectory: true })
    expect(await host.stat(join(dir, 'missing'))).toBeNull()
  })

  it("reads a folder's origin through the host's git", async () => {
    const git: GitRunner = vi.fn(async (cwd: string) => (cwd === '/w/acme' ? { ok: true, stdout: 'git@github.com:acme/api.git\n', stderr: '' } : { ok: false, stdout: '', stderr: 'not a git repository' }))
    expect(await originUrl(git, '/w/acme')).toBe('git@github.com:acme/api.git')
    expect(await originUrl(git, '/w/notes')).toBeNull()
    expect(git).toHaveBeenCalledWith('/w/acme', ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  })
})
