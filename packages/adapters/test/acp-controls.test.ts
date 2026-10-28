import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_AGENTS, type AgentDefinition, type AgentEvent } from '@workhub/core'
import { AcpRuntime, discoverKiroOptions, parseKiroAgentList, parseKiroModels, readConfigSelect, readModels, readModes } from '../src/agent-acp'
import type { CliRunner } from '../src/shared/cli'

const fixtures = join(import.meta.dirname, 'fixtures')

const agentFor = (semantics: AgentDefinition['modeSemantics']): AgentDefinition => ({
  ...BUILTIN_AGENTS.find((a) => a.id === 'kiro')!,
  id: 'fake',
  name: 'Fake',
  command: process.execPath,
  args: [join(fixtures, 'fake-acp-agent.mjs')],
  modeSemantics: semantics
})

async function withRuntime(run: (rt: AcpRuntime, events: AgentEvent[]) => Promise<void>) {
  const rt = new AcpRuntime({ clientName: 'workhub-test', clientVersion: '0.0.0' })
  const events: AgentEvent[] = []
  rt.subscribe((e) => events.push(e))
  try {
    await run(rt, events)
  } finally {
    await rt.stopAll()
  }
}

const stderr = (events: AgentEvent[], id: string) => events.flatMap((e) => (e.sessionId === id && e.type === 'stderr' ? [e.line] : []))
const lastModels = (events: AgentEvent[], id: string) => events.filter((e): e is Extract<AgentEvent, { type: 'models' }> => e.sessionId === id && e.type === 'models').at(-1)
const lastMode = (events: AgentEvent[], id: string) => events.filter((e): e is Extract<AgentEvent, { type: 'permissionMode' }> => e.sessionId === id && e.type === 'permissionMode').at(-1)

describe('reading models and modes from session/new', () => {
  it('reads ACP models (modelId) and modes', () => {
    const session = {
      modes: { currentModeId: 'kiro_default', availableModes: [{ id: 'kiro_default', name: 'kiro_default' }] },
      models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'auto', description: 'By task' }, { modelId: 'claude-sonnet-5.5', name: 'Sonnet' }] }
    }
    expect(readModels(session)).toEqual({
      currentModelId: 'auto',
      availableModels: [{ id: 'auto', name: 'auto', description: 'By task' }, { id: 'claude-sonnet-5.5', name: 'Sonnet' }],
      via: { kind: 'method' }
    })
    expect(readModes(session)).toMatchObject({ currentModeId: 'kiro_default', via: { kind: 'method' } })
  })

  it('falls back to the mode and model config options, flat or grouped', () => {
    const session = {
      configOptions: [
        { type: 'boolean', configId: 'fast', category: 'model', currentValue: false },
        { type: 'select', id: 'm', category: 'model', currentValue: 'b', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] },
        { type: 'select', configId: 'mode', category: 'mode', currentValue: 'plan', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan', description: 'Read only' }] }
      ]
    }
    expect(readModels(session)).toEqual({ currentModelId: 'b', availableModels: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], via: { kind: 'config', configId: 'm' } })
    expect(readModes(session)).toEqual({
      currentModeId: 'plan',
      availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan', description: 'Read only' }],
      via: { kind: 'config', configId: 'mode' }
    })
    expect(readConfigSelect(session.configOptions, 'thought_level')).toBeUndefined()
  })

  it('reports nothing for an agent without models or modes', () => {
    expect(readModels({})).toEqual({ currentModelId: undefined, availableModels: [] })
    expect(readModes({ configOptions: 'junk' })).toEqual({ currentModeId: undefined, availableModes: [] })
  })
})

describe('AcpRuntime model and mode controls', () => {
  it('reports the models at start and switches model and agent (Kiro style) with session/set_model and session/set_mode', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 'k1', agent: agentFor('persona'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'kiro' } })
      expect(started.models?.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5.5'])
      expect(started.currentModelId).toBe('auto')
      expect(started.currentModeId).toBe('kiro_default')
      expect(started.permissionMode).toMatchObject({ id: 'agent-managed', label: 'Set by agent "kiro_default"' })
      expect(lastModels(events, 'k1')).toMatchObject({ currentModelId: 'auto' })

      await rt.setModel('k1', 'claude-sonnet-5.5')
      await rt.setSessionMode('k1', 'explorer')
      await vi.waitFor(() => expect(stderr(events, 'k1')).toEqual(['set_model:claude-sonnet-5.5', 'set_mode:explorer']))
      expect(lastModels(events, 'k1')).toMatchObject({ currentModelId: 'claude-sonnet-5.5' })
      expect(events).toContainEqual({ sessionId: 'k1', type: 'monitor', snapshot: { model: 'claude-sonnet-5.5' } })
      expect(lastMode(events, 'k1')).toMatchObject({ currentModeId: 'explorer', mode: { label: 'Set by agent "explorer"' } })

      // Same value again: nothing is sent. Unknown values are refused before reaching the agent.
      await rt.setSessionMode('k1', 'explorer')
      await rt.setModel('k1', null)
      await expect(rt.setModel('k1', 'nope')).rejects.toThrow(/does not offer the model "nope"/)
      await expect(rt.setSessionMode('k1', 'nope')).rejects.toThrow(/does not offer the mode "nope"/)
      expect(stderr(events, 'k1')).toHaveLength(2)
    })
  })

  it('starts in the agent asked for, and says so when the agent does not offer it', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 'k2', agent: agentFor('persona'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'kiro' }, modeId: 'writer', model: 'claude-sonnet-5.5' })
      expect(started.currentModeId).toBe('writer')
      expect(started.currentModelId).toBe('claude-sonnet-5.5')
      expect(started.modeIgnored).toBeUndefined()
      await vi.waitFor(() => expect(stderr(events, 'k2')).toEqual(['set_mode:writer', 'set_model:claude-sonnet-5.5']))

      const other = await rt.start({ sessionId: 'k3', agent: agentFor('persona'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'kiro' }, modeId: 'gone' })
      expect(other.modeIgnored).toBe(true)
      expect(other.currentModeId).toBe('kiro_default')
      expect(stderr(events, 'k3')).toEqual([])
    })
  })

  it('a reviewer ignores the mode asked for and takes the read-only one', async () => {
    await withRuntime(async (rt) => {
      const started = await rt.start({ sessionId: 'r1', agent: agentFor('permission'), account: null, cwd: process.cwd(), env: {}, modeId: 'bypassPermissions', readOnly: true })
      expect(started.currentModeId).toBe('plan')
    })
  })

  it('uses session/set_config_option when the agent reports models and modes as config options', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 'c1', agent: agentFor('permission'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'config' }, modeId: 'plan' })
      expect(started.availableModes?.map((m) => m.id)).toEqual(['default', 'bypassPermissions', 'plan'])
      expect(started.currentModeId).toBe('plan')
      expect(started.permissionMode).toMatchObject({ id: 'plan', label: 'Plan' })
      expect(started.models?.map((m) => m.id)).toEqual(['acme-model-1', 'acme-model-2'])

      await rt.setModel('c1', 'acme-model-2')
      await rt.setSessionMode('c1', 'default')
      await vi.waitFor(() => expect(stderr(events, 'c1')).toEqual(['set_config_option:mode=plan', 'set_config_option:model=acme-model-2', 'set_config_option:mode=default']))
      expect(lastModels(events, 'c1')).toMatchObject({ currentModelId: 'acme-model-2' })
      expect(lastMode(events, 'c1')).toMatchObject({ currentModeId: 'default', mode: { id: 'default', label: 'Manual' } })
    })
  })

  it('follows a change the agent makes itself: current_mode_update and config_option_update', async () => {
    await withRuntime(async (rt, events) => {
      await rt.start({ sessionId: 'u1', agent: agentFor('persona'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'kiro' } })
      await rt.prompt('u1', 'agent-switch')
      expect(lastMode(events, 'u1')).toMatchObject({ currentModeId: 'writer' })

      await rt.start({ sessionId: 'u2', agent: agentFor('permission'), account: null, cwd: process.cwd(), env: { FAKE_ACP_STYLE: 'config' } })
      await rt.prompt('u2', 'agent-switch')
      await vi.waitFor(() => {
        expect(lastMode(events, 'u2')).toMatchObject({ currentModeId: 'plan' })
        expect(lastModels(events, 'u2')).toMatchObject({ currentModelId: 'acme-model-2' })
      })
    })
  })
})

describe('Kiro options from its CLI', () => {
  const listModels = JSON.stringify({
    models: [
      { model_name: 'auto', description: 'Models chosen by task', model_id: 'auto', context_window_tokens: 1000000, rate_multiplier: 1, rate_unit: 'Credit' },
      { model_name: 'claude-haiku-5.5', model_id: 'claude-haiku-5.5', rate_multiplier: 0.06, rate_unit: 'Credit' },
      { model_name: 'broken' }
    ],
    default_model: 'auto'
  })
  // `kiro-cli agent list` as Kiro 2.33.1 prints it (colors included), with neutral agents.
  const agentList = [
    '\u001b[38;5;244mWorkspace: \u001b[0m/tmp/acme/.kiro/agents',
    '\u001b[38;5;244mGlobal:    \u001b[0m~/.kiro/agents',
    '',
    '* acme-main       Global        Main agent for the Acme API: memory,',
    '                                 tickets and chat.',
    '  explorer        Workspace     Read-only code mapper.',
    '  kiro_default    \u001b[38;5;244m(Built-in)\u001b[0m    Default agent',
    '  bare            Global'
  ].join('\n')

  it('parses the model list with its credit rate and the default model', () => {
    expect(parseKiroModels(listModels)).toEqual({
      models: [
        { id: 'auto', name: 'auto', description: 'Models chosen by task · 1x credit' },
        { id: 'claude-haiku-5.5', name: 'claude-haiku-5.5', description: '0.06x credit' }
      ],
      defaultModelId: 'auto'
    })
    expect(parseKiroModels('not json')).toEqual({ models: [] })
  })

  it('parses the agent list, wrapped descriptions and the default agent', () => {
    expect(parseKiroAgentList(agentList)).toEqual({
      modes: [
        { id: 'acme-main', name: 'acme-main', description: 'Main agent for the Acme API: memory, tickets and chat.' },
        { id: 'explorer', name: 'explorer', description: 'Read-only code mapper.' },
        { id: 'kiro_default', name: 'kiro_default', description: 'Default agent' },
        { id: 'bare', name: 'bare' }
      ],
      defaultModeId: 'acme-main'
    })
  })

  it('runs only the listing commands, reads the agent list from stderr, and fails soft', async () => {
    const calls: string[][] = []
    const run: CliRunner = async (command, args) => {
      calls.push([command, ...args])
      return args[0] === 'chat' ? { code: 0, stdout: listModels, stderr: '' } : { code: 0, stdout: '', stderr: agentList }
    }
    const options = await discoverKiroOptions(run, '/opt/kiro-cli')
    expect(calls).toEqual([
      ['/opt/kiro-cli', 'chat', '--list-models', '-f', 'json'],
      ['/opt/kiro-cli', 'agent', 'list']
    ])
    expect(options).toMatchObject({ defaultModelId: 'auto', defaultModeId: 'acme-main' })
    expect(options.modes).toHaveLength(4)

    const failing: CliRunner = async () => {
      throw new Error('not installed')
    }
    expect(await discoverKiroOptions(failing)).toEqual({ models: [], modes: [] })
  })
})
