import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_AGENTS, mergeMonitor, type AgentDefinition, type AgentEvent, type SessionMonitorSnapshot } from '@workhub/core'
import { AcpMonitor, AcpRuntime, permissionMode, readModes } from '../src/agent-acp'

// Fixtures were cut from the P0 probe logs (spike/probe/out) and sanitized: server names
// replaced with neutral ones, session ids fixed, OAuth URLs, tool schemas and prompts removed.
const fixtures = join(import.meta.dirname, 'fixtures')
const lines = (name: string) =>
  readFileSync(join(fixtures, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { method?: string; params?: { update?: unknown }; result?: unknown })

function replay(name: string): SessionMonitorSnapshot {
  const monitor = new AcpMonitor()
  let merged: SessionMonitorSnapshot = {}
  for (const msg of lines(name)) {
    let patch: SessionMonitorSnapshot | null = null
    if (msg.method === 'session/update') patch = monitor.applyUpdate(msg.params?.update)
    else if (msg.method?.startsWith('_')) patch = monitor.applyExtension(msg.method, msg.params)
    else if (msg.result) patch = monitor.applyPromptResult(msg.result)
    if (patch) merged = mergeMonitor(merged, patch)
  }
  expect(merged).toEqual(monitor.current())
  return merged
}

describe('AcpMonitor with recorded Kiro extensions', () => {
  const snap = replay('kiro-extensions.jsonl')

  it('builds the MCP server list with status and tool counts', () => {
    expect(snap.mcpServers).toHaveLength(10)
    expect(snap.mcpServers?.find((s) => s.name === 'acme-tracker')).toEqual({ name: 'acme-tracker', state: 'running', toolCount: 41 })
  })

  it('keeps servers waiting for OAuth as needs-auth', () => {
    expect(snap.mcpServers?.find((s) => s.name === 'acme-chat')?.state).toBe('needs-auth')
    expect(snap.mcpServers?.find((s) => s.name === 'acme-logs')?.state).toBe('needs-auth')
  })

  it('maps context percent, credits per turn and turn time', () => {
    expect(snap.context?.percent).toBeCloseTo(8.5516, 3)
    expect(snap.lastTurnCredits).toBeCloseTo(0.5903, 3)
    expect(snap.credits).toBeCloseTo(0.5903, 3)
    expect(snap.activeTimeMs).toBe(12400)
  })

  it('maps the (empty) subagent list', () => {
    expect(snap.subagents).toEqual([])
  })

  it('never keeps the OAuth URL', () => {
    expect(JSON.stringify(snap)).not.toContain('example.com')
  })
})

describe('AcpMonitor with recorded Claude ACP updates', () => {
  const snap = replay('claude-updates.jsonl')

  it('maps title, model and context window', () => {
    expect(snap.title).toBe('List the MCP servers')
    expect(snap.model).toBe('claude-opus-5-5')
    expect(snap.context).toEqual({ used: 55582, size: 400000, percent: (55582 / 400000) * 100 })
  })

  it('tracks tool calls by id', () => {
    expect(snap.toolCalls).toEqual([{ id: 'toolu_fixture_1', title: 'ToolSearch', kind: 'other', status: 'pending' }])
  })

  it('maps prompt usage into token totals', () => {
    expect(snap.tokens).toEqual({ input: 4, output: 1950, cacheRead: 93713, cacheWrite: 23078, total: 118745 })
  })
})

describe('AcpMonitor edge cases', () => {
  it('marks the tool calls of a turn that did not end normally as cancelled', () => {
    const m = new AcpMonitor()
    m.applyUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'in_progress' })
    m.applyUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit', status: 'completed' })
    expect(m.endTurn('end_turn')).toBeNull()
    expect(m.endTurn('cancelled')?.toolCalls?.map((t) => t.status)).toEqual(['cancelled', 'completed'])
    expect(m.endTurn('cancelled')).toBeNull()
  })
  it('sums credits and tokens over turns', () => {
    const m = new AcpMonitor()
    m.applyExtension('_kiro.dev/metadata', { meteringUsage: [{ value: 1, unit: 'credit' }] })
    m.applyExtension('_kiro.dev/metadata', { meteringUsage: [{ value: 0.5, unit: 'credit' }] })
    m.applyPromptResult({ usage: { inputTokens: 1, totalTokens: 2 } })
    m.applyPromptResult({ usage: { inputTokens: 3, totalTokens: 4 } })
    expect(m.current()).toMatchObject({ credits: 1.5, lastTurnCredits: 0.5, tokens: { input: 4, total: 6 } })
  })

  it('maps usage_update cost', () => {
    const m = new AcpMonitor()
    expect(m.applyUpdate({ sessionUpdate: 'usage_update', used: 1, size: 4, cost: { amount: 0.12, currency: 'USD' } })).toEqual({
      context: { used: 1, size: 4, percent: 25 },
      cost: { amount: 0.12, currency: 'USD' }
    })
  })

  it('ignores malformed and unknown input', () => {
    const m = new AcpMonitor()
    expect(m.applyUpdate(null)).toBeNull()
    expect(m.applyUpdate({ sessionUpdate: 'plan' })).toBeNull()
    expect(m.applyExtension('_kiro.dev/metadata', 'x')).toBeNull()
    expect(m.applyExtension('_kiro.dev/commands/available', { commands: [] })).toBeNull()
    expect(m.applyExtension('_other.dev/thing', {})).toBeNull()
    expect(m.applyPromptResult({ stopReason: 'end_turn' })).toBeNull()
    expect(m.current()).toEqual({})
  })
})

describe('permission mode', () => {
  const claudeSession = {
    modes: {
      currentModeId: 'bypassPermissions',
      availableModes: [
        { id: 'default', name: 'Manual' },
        { id: 'bypassPermissions', name: 'Bypass permissions' }
      ]
    }
  }

  it('reports permission modes as the agent states them', () => {
    const { currentModeId, availableModes } = readModes(claudeSession)
    expect(permissionMode('permission', currentModeId, availableModes)).toEqual({
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      source: 'agent',
      unattended: true
    })
  })

  it('reports persona agents as managed by the agent', () => {
    expect(permissionMode('persona', 'acme-persona', [])).toEqual({
      id: 'agent-managed',
      label: 'Set by agent "acme-persona"',
      source: 'agent'
    })
  })

  it('reports unknown when the agent exposes nothing', () => {
    expect(permissionMode('permission', undefined, []).id).toBe('unknown')
    expect(readModes({})).toEqual({ currentModeId: undefined, availableModes: [] })
  })
})

describe('AcpRuntime against a fake ACP agent', () => {
  const fakeAgent: AgentDefinition = {
    ...BUILTIN_AGENTS.find((a) => a.id === 'claude')!,
    id: 'fake',
    name: 'Fake',
    command: process.execPath,
    args: [join(fixtures, 'fake-acp-agent.mjs')]
  }

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

  it('starts, prompts, maps events and stops', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 's1', agent: fakeAgent, account: null, cwd: process.cwd(), env: {} })
      expect(started).toMatchObject({ agentSessionId: 'fake-session-1', agentName: 'Fake Agent' })
      expect(started.permissionMode).toMatchObject({ id: 'bypassPermissions', unattended: true })

      const res = await rt.prompt('s1', 'hello')
      expect(res.stopReason).toBe('end_turn')
      const types = events.map((e) => (e.type === 'state' ? `state:${e.state}` : e.type))
      expect(types.slice(0, 3)).toEqual(['state:starting', 'models', 'monitor'])
      expect(types).toContain('state:ready')
      expect(types).toContain('state:busy')
      expect(events).toContainEqual({ sessionId: 's1', type: 'message', role: 'agent', text: 'echo: hello' })
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool', toolCallId: 't1', kind: 'read' }))

      // Extension notifications go through the SDK's async fallback handler and may land just
      // after the prompt response.
      await vi.waitFor(() => {
        const snapshot = events.reduce((s, e) => (e.type === 'monitor' ? mergeMonitor(s, e.snapshot) : s), {} as SessionMonitorSnapshot)
        expect(snapshot).toMatchObject({ model: 'acme-model-1', credits: 0.25, context: { percent: 12.5 }, tokens: { total: 15 } })
      })

      await rt.stop('s1')
      await expect(rt.prompt('s1', 'again')).rejects.toThrow(/no ready ACP session/)
    })
  })

  it('passes a slash command through as typed and reports the commands the agent lists', async () => {
    await withRuntime(async (rt, events) => {
      await rt.start({ sessionId: 's-c', agent: fakeAgent, account: null, cwd: process.cwd(), env: {} })
      await rt.prompt('s-c', '/review main')
      expect(events).toContainEqual({ sessionId: 's-c', type: 'message', role: 'agent', text: 'echo: /review main' })
      await rt.prompt('s-c', 'commands')
      // ACP's list and Kiro's extension list are merged, one entry per name.
      await vi.waitFor(() =>
        expect(events.filter((e) => e.type === 'commands').at(-1)).toEqual({
          sessionId: 's-c',
          type: 'commands',
          commands: [
            { name: 'review', description: 'Review the changes', argumentHint: '<branch>', group: 'agent' },
            { name: 'compact', description: 'Compact', group: 'agent' },
            { name: 'agent', description: 'Select an agent', group: 'agent' }
          ]
        })
      )
    })
  })

  it('starts a read-only session in the agent\'s plan mode', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 's-ro', agent: { ...fakeAgent, modeSemantics: 'permission' }, account: null, cwd: process.cwd(), env: {}, readOnly: true })
      expect(started.currentModeId).toBe('plan')
      expect(started.permissionMode).toMatchObject({ id: 'plan', unattended: false })
      await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-ro', type: 'stderr', line: 'set_mode:plan' }))
    })
  })

  it('selects the asked model through session/set_model, and ignores one the agent does not offer', async () => {
    await withRuntime(async (rt, events) => {
      const started = await rt.start({ sessionId: 's-m1', agent: fakeAgent, account: null, cwd: process.cwd(), env: {}, model: 'acme-model-2' })
      expect(started.modelIgnored).toBeUndefined()
      await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-m1', type: 'stderr', line: 'set_model:acme-model-2' }))
      expect(events).toContainEqual({ sessionId: 's-m1', type: 'monitor', snapshot: { model: 'acme-model-2' } })
      const other = await rt.start({ sessionId: 's-m2', agent: fakeAgent, account: null, cwd: process.cwd(), env: {}, model: 'nope' })
      expect(other.modelIgnored).toBe(true)
      expect(events).not.toContainEqual({ sessionId: 's-m2', type: 'stderr', line: 'set_model:nope' })
    })
  })

  it('relays permission requests and their answer', async () => {
    await withRuntime(async (rt, events) => {
      rt.subscribe((e) => {
        if (e.type === 'permission') rt.respondPermission(e.sessionId, e.requestId, 'deny')
      })
      await rt.start({ sessionId: 's2', agent: fakeAgent, account: null, cwd: process.cwd(), env: {} })
      await rt.prompt('s2', 'ask')
      expect(events).toContainEqual(expect.objectContaining({ type: 'permission', title: 'Write file' }))
      expect(events).toContainEqual({ sessionId: 's2', type: 'message', role: 'agent', text: 'echo: ask (selected:deny)' })
    })
  })

  it('fails cleanly when the command does not exist', async () => {
    await withRuntime(async (rt, events) => {
      const missing = { ...fakeAgent, command: 'workhub-no-such-agent-binary', args: [] }
      await expect(rt.start({ sessionId: 's3', agent: missing, account: null, cwd: process.cwd(), env: {} })).rejects.toThrow(
        /could not start "workhub-no-such-agent-binary"/
      )
      expect(events.at(-1)).toMatchObject({ type: 'state', state: 'error' })
    })
  })
})
