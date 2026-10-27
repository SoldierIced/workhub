import { describe, expect, it, vi } from 'vitest'
import {
  emptyConfig,
  NO_CAPABILITIES,
  type AgentAdapterKind,
  type AgentCapabilities,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ConfigurationService,
  type HistoryMessage,
  type StartSessionRequest,
  type TranscriptReader,
  type WorkhubConfig
} from '@workhub/core'
import { claudeAccounts } from '../src/main/claude-accounts'
import { resolveChoice, SessionManager, ticketPrefixes } from '../src/main/session-manager'
import type { SessionView } from '../src/shared/api'

const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  ...NO_CAPABILITIES,
  appMode: true,
  transcript: true,
  models: true,
  mcpStatus: true,
  mcpControl: true,
  permissionRequests: true,
  imageInput: true,
  ...over
})

/** A runtime that records what it was asked and lets the test emit events. */
class FakeRuntime implements AgentRuntime {
  readonly adapter: AgentAdapterKind
  started: StartSessionRequest[] = []
  stopped: string[] = []
  prompts: { id: string; text: string; images?: unknown[] }[] = []
  writes: [string, string][] = []
  models: [string, string | null][] = []
  private listeners = new Set<AgentEventListener>()
  constructor(adapter: AgentAdapterKind, private readonly caps: AgentCapabilities) {
    this.adapter = adapter
  }
  capabilities(): AgentCapabilities {
    return this.caps
  }
  async start(r: StartSessionRequest) {
    this.started.push(r)
    this.emit({ sessionId: r.sessionId, type: 'state', state: 'ready' })
    return { agentName: 'Fake', permissionMode: null, agentSessionId: r.agentSessionId }
  }
  async prompt(id: string, text: string, images?: unknown[]) {
    this.prompts.push({ id, text, images })
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async stop(id: string) {
    this.stopped.push(id)
    this.emit({ sessionId: id, type: 'state', state: 'stopped' })
  }
  async stopAll() {}
  respondPermission() {}
  subscribe(l: AgentEventListener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit(e: AgentEvent) {
    for (const l of this.listeners) l(e)
  }
}

class FakeTerminal extends FakeRuntime {
  write(id: string, data: string) {
    this.writes.push([id, data])
  }
  resize() {}
}

class FakeNative extends FakeRuntime {
  async setModel(id: string, model: string | null) {
    this.models.push([id, model])
  }
  refreshMcp() {}
  reconnectMcp() {}
  toggleMcp() {}
}

function setup(config: WorkhubConfig = emptyConfig(), transcriptExists = false) {
  const replaceSessionIdentity = vi.fn(async (): Promise<{ ok: boolean } | undefined> => undefined)
  const emitConfigChanged = vi.fn()
  const native = new FakeNative('native', caps())
  const acp = new FakeRuntime('acp', caps({ mcpControl: false }))
  const terminal = new FakeTerminal('terminal', caps({ appMode: false }))
  const changed: SessionView[] = []
  const events: AgentEvent[] = []
  const removed: string[] = []
  const replays: [string, HistoryMessage[]][] = []
  const transcript: TranscriptReader = {
    id: 'claude',
    read: vi.fn(async () => ({ title: 'From transcript' })),
    exists: vi.fn(async () => transcriptExists),
    forget: () => {}
  }
  const manager = new SessionManager({
    config: { current: async () => config, replaceSessionIdentity } as unknown as ConfigurationService,
    runtimes: { native, acp },
    terminal,
    transcripts: [transcript],
    history: { claude: { list: async () => [], messages: async () => [{ kind: 'user', text: 'earlier' }] } },
    emitEvent: (e) => events.push(e),
    emitChanged: (s) => changed.push(s),
    emitRemoved: (id) => removed.push(id),
    emitReplay: (id, m) => replays.push([id, m]),
    emitConfigChanged,
    pollMs: 60_000
  })
  const last = (id: string) => [...changed].reverse().find((s) => s.id === id)!
  return { removed, manager, native, acp, terminal, changed, events, replays, transcript, last, replaceSessionIdentity, emitConfigChanged }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('SessionManager', () => {
  it('drops a stopped session from the list and tells the renderer, but never a live one', async () => {
    const { manager, removed } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    expect(manager.remove(view.id)).toBe(false)
    expect(manager.list()).toHaveLength(1)
    await manager.stop(view.id)
    expect(manager.remove(view.id)).toBe(true)
    expect(manager.list()).toHaveLength(0)
    expect(removed).toEqual([view.id])
    expect(manager.remove(view.id)).toBe(false)
  })

  it('starts native Claude in the app with a preassigned session id and offers app, terminal and shell', async () => {
    const { manager, native, last } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', model: 'haiku' })
    await flush()
    expect(view.modes).toEqual(['app', 'console', 'shell'])
    expect(view.mode).toBe('app')
    expect(view.controls).toBe(true)
    expect(native.started[0]).toMatchObject({ sessionId: view.id, cwd: '/tmp/demo', model: 'haiku', resume: false })
    expect(native.started[0]!.agentSessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(last(view.id)).toMatchObject({ state: 'ready', currentModelId: 'haiku' })
  })

  it('carries where a session came from (main only), and resumes a moved session under its own id', async () => {
    const { manager, native } = setup()
    const origin = { kind: 'failover' as const, fromLabel: 'Claude - Personal', fromIdentity: 'abc', reason: 'limit' as const }
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' }, { origin })
    await flush()
    expect(view.origin).toEqual(origin)
    expect(view.identity).toBe('abc')
    expect(native.started[0]).toMatchObject({ agentSessionId: 'abc', resume: true })
    expect((await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })).origin).toBeUndefined()
  })

  it('hands the session to the console with --resume once the transcript exists, and back', async () => {
    const { manager, native, terminal, last } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    await manager.setMode(view.id, 'console')
    expect(native.stopped).toEqual([view.id])
    expect(terminal.started[0]).toMatchObject({ sessionId: `${view.id}:console` })
    expect(terminal.started[0]!.agent.args).toEqual(['--resume', view.agentSessionId])
    expect(last(view.id)).toMatchObject({ mode: 'console', state: 'ready' })
    await expect(manager.prompt(view.id, 'hi')).rejects.toThrow(/console/)

    await manager.setMode(view.id, 'app')
    expect(terminal.stopped).toEqual([`${view.id}:console`])
    expect(native.started[1]).toMatchObject({ resume: true, agentSessionId: view.agentSessionId })
    expect(last(view.id)).toMatchObject({ mode: 'app', state: 'ready' })
  })

  it('opens a new console with --session-id when nothing was written yet', async () => {
    const { manager, terminal } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', mode: 'console' })
    await flush()
    expect(terminal.started[0]!.agent).toMatchObject({ command: 'claude', args: ['--session-id', view.agentSessionId] })
  })

  it('runs the shell next to the agent and goes back to the agent when the shell exits', async () => {
    const { manager, native, terminal, last } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    await manager.setMode(view.id, 'shell')
    expect(native.stopped).toEqual([])
    expect(terminal.started[0]).toMatchObject({ sessionId: `${view.id}:shell`, cwd: '/tmp/demo' })
    expect(last(view.id)).toMatchObject({ mode: 'shell', shellRunning: true })
    manager.write(`${view.id}:shell`, 'ls\r')
    expect(terminal.writes).toEqual([[`${view.id}:shell`, 'ls\r']])
    terminal.emit({ sessionId: `${view.id}:shell`, type: 'state', state: 'stopped' })
    expect(last(view.id)).toMatchObject({ mode: 'app', shellRunning: false, state: 'ready' })
  })

  it('replays a resumed conversation and passes images only to agents that take them', async () => {
    const { manager, native, acp, replays } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' })
    await flush()
    await flush()
    expect(native.started[0]).toMatchObject({ resume: true, agentSessionId: 'abc' })
    expect(replays).toEqual([[view.id, [{ kind: 'user', text: 'earlier' }]]])
    await manager.prompt(view.id, 'look', [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(native.prompts[0]!.images).toHaveLength(1)

    const other = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    ;(acp as unknown as { caps: AgentCapabilities }).caps.imageInput = false
    await manager.prompt(other.id, 'look', [{ mediaType: 'image/png', data: 'AAAA' }])
    expect(acp.prompts[0]!.images).toBeUndefined()
  })

  it('records the model picked in the session', async () => {
    const { manager, native, last } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    native.emit({ sessionId: view.id, type: 'models', models: [{ id: 'haiku', name: 'Haiku' }], currentModelId: 'default' })
    expect(last(view.id).models).toEqual([{ id: 'haiku', name: 'Haiku' }])
    await manager.setModel(view.id, 'haiku')
    expect(native.models).toEqual([[view.id, 'haiku']])
    expect(last(view.id).currentModelId).toBe('haiku')
  })
})

describe('session identity', () => {
  it('keys a Claude session by its own session id, which a resume keeps', async () => {
    const { manager } = setup()
    const fresh = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    expect(fresh.identity).toBe(fresh.agentSessionId)
    const resumed = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' })
    expect(resumed.identity).toBe('abc')
    await flush()
  })

  it('gives a plain terminal an identity of its own, and reopens it under the old one', async () => {
    const { manager } = setup()
    const a = await manager.start({ profileId: null, agentKey: 'shell', cwd: '/tmp/demo' })
    const b = await manager.start({ profileId: null, agentKey: 'shell', cwd: '/tmp/demo' })
    expect(a.agentSessionId).toBeUndefined()
    expect(a.identity).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.identity).not.toBe(b.identity)
    expect(a.identity).not.toBe(a.id)
    const again = await manager.start({ profileId: null, agentKey: 'shell', cwd: '/tmp/demo', identity: a.identity })
    expect(again.identity).toBe(a.identity)
    await flush()
  })

  it('moves the group place to the id an agent only reports once it has started', async () => {
    const { manager, acp, last, replaceSessionIdentity } = setup()
    acp.start = async () => ({ agentName: 'Fake', permissionMode: null, agentSessionId: 'acp-real' })
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    const provisional = view.identity
    await flush()
    expect(replaceSessionIdentity).toHaveBeenCalledWith(provisional, 'acp-real')
    expect(last(view.id)).toMatchObject({ identity: 'acp-real', agentSessionId: 'acp-real' })
  })

  it('tells the renderer to reload the config once the group place moved', async () => {
    const { manager, acp, replaceSessionIdentity, emitConfigChanged } = setup()
    replaceSessionIdentity.mockImplementation(async () => ({ ok: true }))
    acp.start = async () => ({ agentName: 'Fake', permissionMode: null, agentSessionId: 'acp-real' })
    await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    expect(emitConfigChanged).toHaveBeenCalledTimes(1)
  })
})

describe('session helpers', () => {
  const config: WorkhubConfig = {
    ...emptyConfig(),
    accounts: [
      { id: 'work', agentId: 'claude', name: 'Work', configDir: '/cfg/work' },
      { id: 'home', agentId: 'claude', name: 'Home' }
    ],
    connections: [
      { id: 'jira', kind: 'tracker', provider: 'jira', endpoint: 'https://acme.example', settings: { projectKeys: 'abc, DEF' } },
      { id: 'gh', kind: 'codeHost', provider: 'github', settings: { projectKeys: 'NOPE' } }
    ]
  }

  it('reads ticket prefixes from tracker connections only', () => {
    expect(ticketPrefixes(config)).toEqual(['ABC', 'DEF'])
  })

  it('resolves an account key the profile does not offer from the config', () => {
    const profiled: WorkhubConfig = {
      ...config,
      profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: ['home'], modules: { flows: false, health: false, chatWatcher: false, automations: false } }],
      activeProfileId: 'p'
    }
    expect(resolveChoice(profiled, 'p', 'claude:work')).toMatchObject({ account: { id: 'work' }, label: 'Claude Code - Work' })
    expect(resolveChoice(profiled, 'p', 'claude:missing')).toBeNull()
  })

  it('lists each Claude config folder once, plus the default folder when no account uses it', () => {
    expect(claudeAccounts(config, '/home/u', '')).toEqual([
      { accountId: 'work', name: 'Work', configDir: '/cfg/work' },
      { accountId: 'home', name: 'Home', configDir: undefined }
    ])
    expect(claudeAccounts({ ...emptyConfig() }, '/home/u', '')).toEqual([{ accountId: null, name: '' }])
  })
})
