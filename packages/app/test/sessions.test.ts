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
import { resolveChoice, SessionManager, ticketPrefixes, type SessionManagerDeps } from '../src/main/session-manager'
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
  resizes: [string, number, number][] = []
  write(id: string, data: string) {
    this.writes.push([id, data])
  }
  resize(id: string, cols: number, rows: number) {
    this.resizes.push([id, cols, rows])
  }
}

class FakeNative extends FakeRuntime {
  async setModel(id: string, model: string | null) {
    this.models.push([id, model])
  }
  refreshMcp() {}
  reconnectMcp() {}
  toggleMcp() {}
}

function setup(config: WorkhubConfig = emptyConfig(), transcriptExists = false, extra: Partial<SessionManagerDeps> = {}) {
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
    pollMs: 60_000,
    settleMs: 0,
    ...extra
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

  it('reopens a stored session resuming its conversation only when it still exists, and never prompts', async () => {
    const gone = setup(emptyConfig(), false)
    const fresh = await gone.manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' }, { restored: true })
    await flush()
    await flush()
    // Never prompted before the quit: the same session id starts fresh.
    expect(gone.native.started[0]).toMatchObject({ resume: false, agentSessionId: 'abc' })
    expect(fresh).toMatchObject({ identity: 'abc', agentSessionId: 'abc' })
    expect(gone.manager.engineOf(fresh.id)).toBe('app')

    const kept = setup(emptyConfig(), true)
    const view = await kept.manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' }, { restored: true })
    await flush()
    await flush()
    expect(kept.native.started[0]).toMatchObject({ resume: true, agentSessionId: 'abc' })
    expect(kept.replays).toEqual([[view.id, [{ kind: 'user', text: 'earlier' }]]])
    expect(kept.native.prompts).toEqual([])
  })

  it('follows what an ACP agent says at start about taking images', async () => {
    const { manager, acp, last } = setup()
    const start = acp.start.bind(acp)
    acp.start = async (r) => ({ ...(await start(r)), imageInput: false })
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    expect(last(view.id)?.capabilities.imageInput).toBe(false)
    await manager.prompt(view.id, 'look', [{ mediaType: 'image/png', data: 'AAAA' }])
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

describe('derived active time', () => {
  const activeOf = (events: AgentEvent[]) => events.filter((e) => e.type === 'monitor' && e.snapshot.activeTimeMs !== undefined).map((e) => (e as Extract<AgentEvent, { type: 'monitor' }>).snapshot.activeTimeMs!)

  it('counts the time a session spends busy when the agent reports none', async () => {
    const { manager, native, events } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await new Promise((r) => setTimeout(r, 30))
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    const reported = activeOf(events)
    expect(reported.at(-1)).toBeGreaterThanOrEqual(25)
    const settled = reported.at(-1)
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    expect(activeOf(events).at(-1)).toBeGreaterThanOrEqual(settled!)
  })

  it('leaves the time to the agent once it reports its own', async () => {
    const { manager, native, events } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await flush()
    native.emit({ sessionId: view.id, type: 'monitor', snapshot: { activeTimeMs: 9999 } })
    const before = activeOf(events).length
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await new Promise((r) => setTimeout(r, 10))
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    expect(activeOf(events).length).toBe(before)
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

/** Lets pending timers (settleMs: 0) and the promises after them run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('App ↔ Terminal hand-over (Workhub 1: Console.switchTo)', () => {
  it('waits for a running turn to end before handing the chat to the console', async () => {
    const { manager, native, terminal, last } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await manager.setMode(view.id, 'console')
    expect(native.stopped).toEqual([])
    expect(terminal.started).toEqual([])
    expect(last(view.id)).toMatchObject({ mode: 'app', pendingMode: 'console', state: 'busy' })

    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    await settle()
    expect(native.stopped).toEqual([view.id])
    expect(terminal.started[0]).toMatchObject({ sessionId: `${view.id}:console` })
    expect(last(view.id)).toMatchObject({ mode: 'console', pendingMode: undefined, state: 'ready' })
  })

  it('holds the switch while a permission request waits, and lets it go once answered', async () => {
    const { manager, native, terminal } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    native.emit({ sessionId: view.id, type: 'permission', requestId: 'r1', title: 'Run ls', options: [] })
    await manager.setMode(view.id, 'console')
    await settle()
    expect(native.stopped).toEqual([])
    manager.respondPermission(view.id, 'r1', 'allow')
    await settle()
    expect(native.stopped).toEqual([view.id])
    expect(terminal.started).toHaveLength(1)
  })

  it('switches at once with `now`, and drops a pending switch when the running view is picked', async () => {
    const { manager, native, terminal, last } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await manager.setMode(view.id, 'console')
    await manager.setMode(view.id, 'app')
    expect(last(view.id)).toMatchObject({ mode: 'app', pendingMode: undefined })
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    await settle()
    expect(native.stopped).toEqual([])

    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await manager.setMode(view.id, 'console', { now: true })
    expect(native.stopped).toEqual([view.id])
    expect(terminal.started).toHaveLength(1)
    expect(last(view.id)).toMatchObject({ mode: 'console', pendingMode: undefined })
  })

  it('reads a running console turn from the terminal title and hands it back to the app when it ends', async () => {
    const { manager, native, terminal, last } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', mode: 'console' })
    await settle()
    const out = (data: string) => terminal.emit({ sessionId: `${view.id}:console`, type: 'output', data })
    // A spinner title split across two chunks.
    out('\x1b]0;⠐ Working')
    out('\x07')
    await manager.setMode(view.id, 'app')
    await settle()
    expect(terminal.stopped).toEqual([])
    expect(last(view.id)).toMatchObject({ mode: 'console', pendingMode: 'app' })

    out('\x1b]0;✳ Claude Code\x07')
    await settle()
    expect(terminal.stopped).toEqual([`${view.id}:console`])
    expect(native.started[0]).toMatchObject({ resume: true })
    expect(last(view.id)).toMatchObject({ mode: 'app', pendingMode: undefined })
  })

  it('holds a console switch while a permission notification or an unfinished tool call waits', async () => {
    const reads: ({ toolCalls: { id: string; title: string; status: string; startedAt: number }[] })[] = []
    const { manager, terminal, transcript } = setup(emptyConfig(), true)
    ;(transcript.read as ReturnType<typeof vi.fn>).mockImplementation(async () => reads.shift() ?? null)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', mode: 'console' })
    await settle()
    const out = (data: string) => terminal.emit({ sessionId: `${view.id}:console`, type: 'output', data })
    out('\x1b]0;✳ Claude Code\x07\x1b]9;Claude needs your permission to use Bash\x07')
    await manager.setMode(view.id, 'app')
    await settle()
    expect(terminal.stopped).toEqual([])
    // The user answers in the terminal; the transcript still shows the call without a result.
    reads.push({ toolCalls: [{ id: 't1', title: 'Bash', status: 'in_progress', startedAt: Date.now() }] })
    manager.write(`${view.id}:console`, '1')
    await settle()
    expect(terminal.stopped).toEqual([])
    // The next monitor poll (every 3 s) reads the result.
    reads.push({ toolCalls: [{ id: 't1', title: 'Bash', status: 'completed', startedAt: Date.now() }] })
    await (manager as unknown as { pollTranscripts(): Promise<void> }).pollTranscripts()
    await settle()
    expect(terminal.stopped).toEqual([`${view.id}:console`])
  })

  it('stays in the shell when a pending switch runs while the shell is shown', async () => {
    const { manager, native, terminal, last } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await manager.setMode(view.id, 'console')
    await manager.setMode(view.id, 'shell')
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    await settle()
    expect(terminal.started.map((r) => r.sessionId)).toEqual([`${view.id}:shell`, `${view.id}:console`])
    expect(last(view.id)).toMatchObject({ mode: 'shell', pendingMode: undefined })
  })

  it('replays the whole conversation when the console hands it back, before any live event and before the chat turns ready', async () => {
    const order: string[] = []
    let finishRead: (m: HistoryMessage[]) => void = () => undefined
    const { manager, native, last } = setup(emptyConfig(), true, {
      history: { claude: { list: async () => [], messages: () => new Promise<HistoryMessage[]>((r) => (finishRead = r)) } },
      emitReplay: (_id, m) => order.push(`replay:${m.length}`),
      emitEvent: (e) => {
        if (e.type === 'message') order.push(`message:${e.text}`)
      }
    })
    native.start = async (r: StartSessionRequest) => {
      native.started.push(r)
      native.emit({ sessionId: r.sessionId, type: 'message', role: 'agent', text: 'hook' })
      native.emit({ sessionId: r.sessionId, type: 'state', state: 'ready' })
      return { agentName: 'Fake', permissionMode: null, agentSessionId: r.agentSessionId }
    }
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', mode: 'console' })
    await settle()
    const switching = manager.setMode(view.id, 'app')
    await settle()
    expect(native.started).toHaveLength(1)
    expect(order).toEqual([])
    expect(last(view.id).state).toBe('starting')
    finishRead([
      { kind: 'user', text: 'typed in the terminal' },
      { kind: 'agent', text: 'answered in the terminal' }
    ])
    await switching
    expect(order).toEqual(['replay:2', 'message:hook'])
    expect(last(view.id)).toMatchObject({ mode: 'app', state: 'ready' })
  })

  it('opens the chat without the earlier conversation when it cannot be read in time', async () => {
    const { manager, last, replays } = setup(emptyConfig(), true, {
      replayWaitMs: 10,
      history: { claude: { list: async () => [], messages: () => new Promise<HistoryMessage[]>(() => undefined) } }
    })
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' })
    await new Promise((r) => setTimeout(r, 30))
    expect(replays).toEqual([])
    expect(last(view.id).state).toBe('ready')
  })

  it('starts a terminal that starts after its view was fitted at the fitted size', async () => {
    const { manager, terminal } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    // The renderer fits the hidden console before its PTY exists (the chat still runs).
    manager.resize(`${view.id}:console`, 180, 52)
    await manager.setMode(view.id, 'console')
    expect(terminal.started[0]).toMatchObject({ cols: 180, rows: 52 })
    await manager.setMode(view.id, 'shell')
    expect(terminal.started[1]).toMatchObject({ sessionId: `${view.id}:shell`, cols: 180, rows: 52 })
    manager.resize(`${view.id}:console`, 0, 0)
    expect(terminal.resizes).toEqual([[`${view.id}:console`, 180, 52]])
  })
})

describe('closing a session', () => {
  it('stops a live session and drops it from the list', async () => {
    const { manager, native, terminal, removed } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    await manager.setMode(view.id, 'shell')
    await manager.close(view.id)
    expect(native.stopped).toEqual([view.id])
    expect(terminal.stopped).toEqual([`${view.id}:shell`])
    expect(manager.list()).toEqual([])
    expect(removed).toEqual([view.id])
  })

  it('drops a pending switch with the session, and closes a stopped one without stopping it again', async () => {
    const { manager, native, terminal } = setup(emptyConfig(), true)
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    native.emit({ sessionId: view.id, type: 'state', state: 'busy' })
    await manager.setMode(view.id, 'console')
    await manager.close(view.id)
    native.emit({ sessionId: view.id, type: 'state', state: 'ready' })
    await settle()
    expect(terminal.started).toEqual([])
    expect(native.stopped).toEqual([view.id])

    const other = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    await settle()
    await manager.stop(other.id)
    await manager.close(other.id)
    expect(native.stopped).toEqual([view.id, other.id])
    expect(manager.list()).toEqual([])
  })
})

describe('SessionManager prompt gate', () => {
  /** An ACP runtime whose turns end when the test says so. */
  function gated(midTurnInput = false) {
    const ctx = setup()
    if (midTurnInput) (ctx.acp as unknown as { caps: AgentCapabilities }).caps = caps({ mcpControl: false, midTurnInput: true })
    const ends: (() => void)[] = []
    ctx.acp.prompt = async (id: string, text: string) => {
      ctx.acp.prompts.push({ id, text })
      await new Promise<void>((r) => ends.push(r))
      return { stopReason: 'end_turn' }
    }
    const endTurn = async () => {
      ends.shift()?.()
      await flush()
    }
    return { ...ctx, endTurn, ends }
  }

  it('keeps one prompt in flight per session: a delivery at the same moment is refused, a second user prompt waits', async () => {
    const { manager, acp, endTurn } = gated()
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    const queued = manager.prompt(view.id, 'queued message')
    // The AI review, the local review, an automation or a Slack wake at the same moment: told to retry.
    expect(manager.tryPrompt(view.id, 'review findings')).toBeNull()
    const second = manager.prompt(view.id, 'second')
    await flush()
    expect(acp.prompts.map((p) => p.text)).toEqual(['queued message'])
    await endTurn()
    await expect(queued).resolves.toBe('end_turn')
    expect(acp.prompts.map((p) => p.text)).toEqual(['queued message', 'second'])
    expect(manager.tryPrompt(view.id, 'review findings')).toBeNull()
    await endTurn()
    await second
    const review = manager.tryPrompt(view.id, 'review findings')
    expect(review).not.toBeNull()
    await endTurn()
    await expect(review).resolves.toBe('end_turn')
    expect(acp.prompts.map((p) => p.text)).toEqual(['queued message', 'second', 'review findings'])
  })

  it('drops prompts still waiting when the session is interrupted, so none goes out after the turn', async () => {
    const { manager, acp, endTurn } = gated()
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    const running = manager.prompt(view.id, 'running')
    const waiting = manager.prompt(view.id, 'waiting')
    await manager.cancel(view.id)
    await expect(waiting).rejects.toThrow('workhub:prompt-withdrawn')
    await endTurn()
    await running
    await flush()
    expect(acp.prompts.map((p) => p.text)).toEqual(['running'])
    expect(manager.tryPrompt(view.id, 'next')).not.toBeNull()
  })

  it('tells the sender when a held prompt goes out, and lets it take the prompt back until then', async () => {
    const { manager, acp, endTurn } = gated()
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    const out: string[] = []
    void manager.prompt(view.id, 'review findings', undefined, { onStart: () => out.push('review') })
    const kept = manager.prompt(view.id, 'kept', undefined, { key: 'w:1', onStart: () => out.push('kept') })
    const removed = manager.prompt(view.id, 'removed', undefined, { key: 'w:2', onStart: () => out.push('removed') })
    expect(out).toEqual(['review'])
    expect(manager.withdrawPrompt(view.id, 'w:2')).toBe(true)
    await expect(removed).rejects.toThrow('workhub:prompt-withdrawn')
    await endTurn()
    expect(out).toEqual(['review', 'kept'])
    expect(manager.withdrawPrompt(view.id, 'w:1')).toBe(false)
    await endTurn()
    await kept
    expect(acp.prompts.map((p) => p.text)).toEqual(['review findings', 'kept'])
  })

  it('lets agents that take input mid-turn get a prompt while one runs', async () => {
    const { manager, acp, ends } = gated(true)
    const view = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo' })
    await flush()
    void manager.prompt(view.id, 'first')
    expect(manager.tryPrompt(view.id, 'folded in')).not.toBeNull()
    await flush()
    expect(acp.prompts.map((p) => p.text)).toEqual(['first', 'folded in'])
    ends.forEach((e) => e())
  })

  it('marks a reopened session as resumed and a new one as not', async () => {
    const { manager } = setup()
    const fresh = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo' })
    const resumed = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/tmp/demo', resumeAgentSessionId: 'abc' })
    const sameIdentity = await manager.start({ profileId: null, agentKey: 'opencode', cwd: '/tmp/demo', identity: 'old' })
    expect([fresh.resumed, resumed.resumed, sameIdentity.resumed]).toEqual([undefined, true, true])
  })
})
