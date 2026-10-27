import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from '@workhub/adapters/agent-acp'
import { emptyConfig, NO_CAPABILITIES, type AgentDefinition, type AgentRuntime, type ConfigurationService, type WorkhubConfig } from '@workhub/core'
import { AgentOptionsService, parseAgentOptionsState, runsKiroCli, type AgentOptionsState } from '../src/main/agent-options'
import { SessionManager } from '../src/main/session-manager'
import { initialStartChoice, sessionModelPicker, sessionModePicker } from '../src/renderer/lib/agent-pickers'
import { parsePrefs } from '../src/renderer/lib/prefs'
import { turnCreditsList } from '../src/renderer/screens/sessions/MonitorPanel'
import type { SessionView } from '../src/shared/api'

const fakeAgentScript = join(import.meta.dirname, '..', '..', 'adapters', 'test', 'fixtures', 'fake-acp-agent.mjs')

/** A Kiro-like ACP agent defined in the config, run by the fake ACP agent. */
const fakeKiro: AgentDefinition = {
  id: 'fakekiro',
  name: 'Fake Kiro',
  adapter: 'acp',
  command: process.execPath,
  args: [fakeAgentScript],
  env: { FAKE_ACP_STYLE: 'kiro' },
  capabilities: { ...NO_CAPABILITIES, appMode: true, usage: true, models: true, permissionRequests: true },
  modeSemantics: 'persona'
}

function setup(config: WorkhubConfig) {
  const acp = new AcpRuntime({ clientName: 'workhub-test', clientVersion: '0.0.0' })
  const recorded: unknown[] = []
  const views = new Map<string, SessionView>()
  const manager = new SessionManager({
    config: { current: async () => config, replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    runtimes: { acp },
    terminal: acp as unknown as AgentRuntime,
    transcripts: [],
    history: {},
    emitEvent: () => {},
    emitChanged: (s) => views.set(s.id, s),
    emitReplay: () => {},
    pollMs: 60_000,
    onAgentOptions: (agentId, accountId, options) => recorded.push({ agentId, accountId, options })
  })
  const ready = async (id: string) => {
    await vi.waitFor(() => expect(views.get(id)?.state).toBe('ready'), { timeout: 5000 })
    return views.get(id)!
  }
  return { manager, acp, views, recorded, ready }
}

describe('ACP model and agent controls through the session manager', () => {
  it('starts with the account defaults, offers the agent models and agents, and switches both live', async () => {
    const config: WorkhubConfig = {
      ...emptyConfig(),
      agents: [fakeKiro],
      accounts: [{ id: 'work', agentId: 'fakekiro', name: 'Work', defaultModel: 'claude-sonnet-5.5', defaultMode: 'explorer' }]
    }
    const { manager, acp, views, recorded, ready } = setup(config)
    try {
      const started = await manager.start({ profileId: null, agentKey: 'fakekiro:work', cwd: process.cwd() })
      expect(started).toMatchObject({ modelControl: true, modeControl: true, controls: false })
      let view = await ready(started.id)
      expect(view.models?.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5.5'])
      expect(view).toMatchObject({ currentModelId: 'claude-sonnet-5.5', currentModeId: 'explorer', permissionMode: { id: 'agent-managed' } })
      expect(view.availableModes?.map((m) => m.id)).toEqual(['kiro_default', 'explorer', 'writer'])
      expect(recorded).toContainEqual(expect.objectContaining({ agentId: 'fakekiro', accountId: 'work' }))

      // The header pickers: an agent picker (persona) and a model picker without "default" (ACP cannot ask for it).
      expect(sessionModePicker(view)).toMatchObject({ visible: true, kind: 'agent', value: 'explorer', disabled: false })
      expect(sessionModelPicker(view)).toMatchObject({ visible: true, allowDefault: false, value: 'claude-sonnet-5.5' })

      await manager.setAgentMode(started.id, 'writer')
      await manager.setModel(started.id, 'auto')
      view = views.get(started.id)!
      expect(view).toMatchObject({ currentModeId: 'writer', currentModelId: 'auto', permissionMode: { label: 'Set by agent "writer"' } })
      await expect(manager.setAgentMode(started.id, 'nope')).rejects.toThrow(/not offered/)
    } finally {
      await acp.stopAll()
    }
  })

  it('a pick at start wins over the account default; an unknown agent is reported as ignored', async () => {
    const config: WorkhubConfig = { ...emptyConfig(), agents: [fakeKiro], accounts: [{ id: 'work', agentId: 'fakekiro', name: 'Work', defaultMode: 'explorer' }] }
    const { manager, acp, ready } = setup(config)
    try {
      const a = await manager.start({ profileId: null, agentKey: 'fakekiro:work', cwd: process.cwd(), modeId: 'writer' })
      expect((await ready(a.id)).currentModeId).toBe('writer')
      const b = await manager.start({ profileId: null, agentKey: 'fakekiro', cwd: process.cwd(), modeId: 'gone', model: 'gone-model' })
      expect(await ready(b.id)).toMatchObject({ currentModeId: 'kiro_default', modeIgnored: true, modelIgnored: true, currentModelId: 'auto' })
    } finally {
      await acp.stopAll()
    }
  })

  it('a review session ignores mode defaults and cannot switch its mode', async () => {
    const reviewer: AgentDefinition = { ...fakeKiro, id: 'fakecodex', env: {}, modeSemantics: 'permission' }
    const config: WorkhubConfig = { ...emptyConfig(), agents: [reviewer], accounts: [{ id: 'r', agentId: 'fakecodex', name: 'R', defaultMode: 'bypassPermissions' }] }
    const { manager, acp, ready } = setup(config)
    try {
      const s = await manager.start({ profileId: null, agentKey: 'fakecodex:r', cwd: process.cwd(), readOnly: true })
      const view = await ready(s.id)
      expect(view.currentModeId).toBe('plan')
      expect(sessionModePicker(view).visible).toBe(false)
      await expect(manager.setAgentMode(s.id, 'bypassPermissions')).rejects.toThrow(/read-only/)
    } finally {
      await acp.stopAll()
    }
  })

  it('runs the account command instead of the agent command', async () => {
    const config: WorkhubConfig = {
      ...emptyConfig(),
      agents: [{ ...fakeKiro, command: 'workhub-no-such-kiro' }],
      accounts: [{ id: 'own', agentId: 'fakekiro', name: 'Own build', command: process.execPath }]
    }
    const { manager, acp, ready } = setup(config)
    try {
      const s = await manager.start({ profileId: null, agentKey: 'fakekiro:own', cwd: process.cwd() })
      expect((await ready(s.id)).agentName).toBe('Fake Agent')
    } finally {
      await acp.stopAll()
    }
  })
})

describe('AgentOptionsService', () => {
  const kiro: AgentDefinition = { ...fakeKiro, id: 'kiro', command: 'kiro-cli' }
  const memory = () => {
    let saved: AgentOptionsState = {}
    return { load: (f: AgentOptionsState) => ({ ...f, ...saved }), save: (s: AgentOptionsState) => void (saved = s), read: () => saved }
  }

  it('lists Kiro through its CLI once, reuses the reading, and lists again on refresh', async () => {
    let now = 1_000
    const discover = vi.fn(async () => ({ models: [{ id: 'auto', name: 'auto' }], modes: [{ id: 'kiro_default', name: 'kiro_default' }], defaultModelId: 'auto', defaultModeId: 'kiro_default' }))
    const state = memory()
    const service = new AgentOptionsService({ discover: (a) => (runsKiroCli(a) ? discover() : null), state, now: () => now })
    expect(await service.get(kiro, null)).toMatchObject({ source: 'cli', defaultModelId: 'auto', modeSemantics: 'persona', models: [{ id: 'auto' }] })
    now += 60_000
    await service.get(kiro, null)
    expect(discover).toHaveBeenCalledTimes(1)
    await service.get(kiro, null, true)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(state.read()['kiro']?.source).toBe('cli')
  })

  it('remembers what a session reported for agents without a listing command, per account', async () => {
    const state = memory()
    const opencode: AgentDefinition = { ...fakeKiro, id: 'opencode', command: 'opencode' }
    const service = new AgentOptionsService({ discover: () => null, state, now: () => 5 })
    expect(await service.get(opencode, null)).toMatchObject({ source: 'none', models: [], modes: [] })
    service.record('opencode', 'work', { models: [{ id: 'gpt', name: 'GPT' }], modes: [{ id: 'build', name: 'build' }, { id: 'plan', name: 'plan' }] })
    const account = { id: 'work', agentId: 'opencode', name: 'Work' }
    expect(await service.get(opencode, account)).toMatchObject({ source: 'session', at: 5, modes: [{ id: 'build' }, { id: 'plan' }] })
    // Survives a restart through the state file, and junk in it is dropped.
    const again = new AgentOptionsService({ discover: () => null, state, now: () => 6 })
    expect((await again.get(opencode, account)).models).toEqual([{ id: 'gpt', name: 'GPT' }])
    expect(parseAgentOptionsState({ x: { at: 'no' }, y: { source: 'cli', at: 1, models: [{ id: 1 }, { id: 'a', name: 'A' }] } })).toEqual({ y: { source: 'cli', at: 1, models: [{ id: 'a', name: 'A' }], modes: [] } })
  })

  it('a failing CLI keeps the last reading', async () => {
    const state = memory()
    let fail = false
    const service = new AgentOptionsService({
      discover: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ models: [{ id: 'auto', name: 'auto' }], modes: [] })),
      state,
      now: () => 1,
      maxAgeMs: 0
    })
    await service.get(kiro, null)
    fail = true
    expect((await service.get(kiro, null)).models).toEqual([{ id: 'auto', name: 'auto' }])
  })

  it('knows which agents run the Kiro CLI', () => {
    expect(runsKiroCli({ command: 'kiro-cli' })).toBe(true)
    expect(runsKiroCli({ command: '/opt/kiro/bin/kiro-cli' })).toBe(true)
    expect(runsKiroCli({ command: 'C:\\Kiro\\kiro-cli.exe' })).toBe(true)
    expect(runsKiroCli({ command: 'opencode' })).toBe(false)
  })
})

describe('picker state', () => {
  const base = {
    id: 's',
    agentId: 'codex',
    accountId: null,
    adapter: 'acp',
    mode: 'app',
    state: 'ready',
    modelControl: true,
    modeControl: true,
    controls: false,
    permissionMode: { id: 'auto', label: 'Auto', source: 'agent' }
  } as unknown as SessionView

  it('shows the mode picker as permission presets for a permission agent, and hides it with one mode or in the console', () => {
    const v = { ...base, availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'auto', name: 'Auto' }], currentModeId: 'auto' } as SessionView
    expect(sessionModePicker(v)).toMatchObject({ visible: true, kind: 'permission', value: 'auto', options: [{ value: 'read-only', label: 'Read only' }, { value: 'auto', label: 'Auto' }] })
    expect(sessionModePicker({ ...v, state: 'busy' }).disabled).toBe(true)
    expect(sessionModePicker({ ...v, mode: 'console' }).visible).toBe(false)
    expect(sessionModePicker({ ...v, availableModes: [{ id: 'auto', name: 'Auto' }] }).visible).toBe(false)
    expect(sessionModePicker({ ...v, modeControl: false }).visible).toBe(false)
  })

  it('model picker: native Claude keeps "default"; an ACP model outside the list is shown as reported', () => {
    const models = [{ id: 'a', name: 'A' }]
    expect(sessionModelPicker({ ...base, adapter: 'native', controls: true, modelControl: true, models } as SessionView)).toMatchObject({ visible: true, allowDefault: true, value: '' })
    const acp = sessionModelPicker({ ...base, models, currentModelId: 'z' } as SessionView)
    expect(acp).toMatchObject({ allowDefault: false, value: 'z' })
    expect(acp.options[0]).toEqual({ value: 'z', label: 'z' })
    expect(sessionModelPicker({ ...base, models: [] } as SessionView).visible).toBe(false)
  })

  it('start choice: last pick, else account default, else the agent default; picks no longer offered are dropped', () => {
    const options = { models: [{ id: 'auto', name: 'auto' }, { id: 'sonnet', name: 'sonnet' }], modes: [{ id: 'explorer', name: 'explorer' }, { id: 'plan', name: 'plan' }] }
    expect(initialStartChoice('model', options, 'sonnet', { defaultModel: 'auto' })).toBe('sonnet')
    expect(initialStartChoice('model', options, 'gone', { defaultModel: 'auto' })).toBe('auto')
    expect(initialStartChoice('mode', options, undefined, { defaultMode: 'explorer' })).toBe('explorer')
    expect(initialStartChoice('mode', options, undefined, null)).toBe('')
    expect(initialStartChoice('model', { models: [], modes: [] }, 'remembered', null)).toBe('remembered')
  })

  it('start mode: the defaults set in Settings win over the last pick (account, then agent), then the last pick', () => {
    const options = { models: [], modes: [{ id: 'default', name: 'default' }, { id: 'plan', name: 'plan' }, { id: 'acceptEdits', name: 'acceptEdits' }] }
    expect(initialStartChoice('mode', options, 'plan', { defaultMode: 'acceptEdits' }, 'default')).toBe('acceptEdits')
    expect(initialStartChoice('mode', options, 'plan', null, 'acceptEdits')).toBe('acceptEdits')
    expect(initialStartChoice('mode', options, 'plan', {}, undefined)).toBe('plan')
    // A default the agent no longer offers falls through to the next one.
    expect(initialStartChoice('mode', options, 'plan', { defaultMode: 'gone' }, 'gone-too')).toBe('plan')
  })

  it('keeps the last picked modes in the prefs and drops junk', () => {
    expect(parsePrefs(JSON.stringify({ modes: { kiro: 'explorer', bad: 3 } })).modes).toEqual({ kiro: 'explorer' })
    expect(parsePrefs(null).modes).toEqual({})
  })

  it('lists the last turns credits', () => {
    expect(turnCreditsList([0.25, 1.0365])).toBe('0.25 · 1.04')
    expect(turnCreditsList([1, 2, 3, 4, 5, 6, 12.345], 3)).toBe('… 5.00 · 6.00 · 12.3')
  })
})
