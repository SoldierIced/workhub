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
  it('keeps the newest 40 tool calls and still reports the status of the kept ones', () => {
    const m = new AcpMonitor()
    let last
    for (let i = 1; i <= 45; i++) last = m.applyUpdate({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: `Tool ${i}`, status: 'in_progress' })
    expect(last?.toolCalls).toHaveLength(40)
    expect(last?.toolCalls?.[0]?.id).toBe('t6')
    expect(last?.toolCalls?.at(-1)?.id).toBe('t45')
    const done = m.applyUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't45', status: 'completed' })
    expect(done?.toolCalls).toHaveLength(40)
    expect(done?.toolCalls?.at(-1)).toMatchObject({ id: 't45', title: 'Tool 45', status: 'completed' })
    // A turn that ends badly cancels only what is still kept.
    expect(m.endTurn('cancelled')?.toolCalls?.filter((t) => t.status === 'cancelled')).toHaveLength(39)
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

  describe('resuming a stored session', () => {
    const resume = { agent: fakeAgent, account: null, cwd: process.cwd(), agentSessionId: 'stored-session-7', resume: true }
    const chat = (events: AgentEvent[], id: string) => events.filter((e) => e.sessionId === id && (e.type === 'message' || e.type === 'tool'))

    it('loads it through session/load when the agent advertises loadSession, without replaying it as chat', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, sessionId: 's-load', env: { FAKE_ACP_LOAD: 'ok' } })
        expect(started).toMatchObject({ agentSessionId: 'stored-session-7', currentModeId: 'bypassPermissions', currentModelId: 'acme-model-1' })
        expect(started.resumeFailed).toBeUndefined()
        await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-load', type: 'stderr', line: 'load:stored-session-7' }))
        // The stored conversation the agent sent again is not chat; what it reports about the session is kept.
        expect(chat(events, 's-load')).toEqual([])
        expect(events.filter((e) => e.sessionId === 's-load' && e.type === 'monitor').some((e) => e.type === 'monitor' && e.snapshot.toolCalls)).toBe(false)
        expect(events).toContainEqual(expect.objectContaining({ sessionId: 's-load', type: 'commands' }))
        // The next turn is live again, on the loaded session.
        await rt.prompt('s-load', 'hello')
        expect(chat(events, 's-load')).toContainEqual({ sessionId: 's-load', type: 'message', role: 'agent', text: 'echo: hello' })
      })
    })

    it('starts a new conversation and says so when the agent has no loadSession', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, sessionId: 's-noload', env: {} })
        expect(started).toMatchObject({ agentSessionId: 'fake-session-1', resumeFailed: 'unsupported' })
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: expect.stringMatching(/^load:/) }))
      })
    })

    it('falls back to a new conversation when the load fails', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, sessionId: 's-loadfail', env: { FAKE_ACP_LOAD: 'fail' } })
        expect(started).toMatchObject({ agentSessionId: 'fake-session-1', resumeFailed: 'failed' })
        await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-loadfail', type: 'stderr', line: 'load:stored-session-7' }))
        expect(events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'ready' })
      })
    })

    it('resumes the original session when the agent supports resume without load', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, sessionId: 's-resume', env: { FAKE_ACP_RESUME: 'ok' } })
        expect(started).toMatchObject({ agentSessionId: 'stored-session-7', currentModeId: 'bypassPermissions' })
        expect(started.resumeFailed).toBeUndefined()
        await rt.prompt('s-resume', 'continue')
        await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-resume', type: 'stderr', line: 'prompt-session:stored-session-7' }))
        expect(events).toContainEqual({ sessionId: 's-resume', type: 'stderr', line: 'resume:stored-session-7' })
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: 'new-session' }))
      })
    })

    it('tries native resume after Codex fails to load the history, keeping the original identity', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, agent: { ...fakeAgent, id: 'codex' }, sessionId: 's-codex', env: { FAKE_ACP_LOAD: 'fail', FAKE_ACP_RESUME: 'ok' } })
        expect(started.agentSessionId).toBe('stored-session-7')
        expect(started.resumeFailed).toBeUndefined()
        await rt.prompt('s-codex', 'continue')
        await vi.waitFor(() => expect(events).toContainEqual({ sessionId: 's-codex', type: 'stderr', line: 'prompt-session:stored-session-7' }))
        expect(events.filter((e) => e.type === 'stderr').map((e) => e.type === 'stderr' && e.line)).toEqual([
          'load:stored-session-7', 'resume:stored-session-7', 'prompt-session:stored-session-7'
        ])
      })
    })

    it('does not replace a Codex conversation another client owns with a new empty session', async () => {
      await withRuntime(async (rt, events) => {
        await expect(rt.start({ ...resume, agent: { ...fakeAgent, id: 'codex' }, sessionId: 's-owned', env: { FAKE_ACP_LOAD: 'fail', FAKE_ACP_RESUME: 'fail' } })).rejects.toThrow(/in use by another Codex client/)
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: 'new-session' }))
        expect(events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('Close the session there') })
      })
    })

    it('preserves a failed Codex load when there is no alternative resume method', async () => {
      await withRuntime(async (rt, events) => {
        await expect(rt.start({ ...resume, agent: { ...fakeAgent, id: 'codex' }, sessionId: 's-codex-fail', env: { FAKE_ACP_LOAD: 'fail' } })).rejects.toThrow(/session not found/)
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: 'new-session' }))
      })
    })

    it('does not attempt resume after a successful load even when both are supported', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, sessionId: 's-both', env: { FAKE_ACP_LOAD: 'ok', FAKE_ACP_RESUME: 'ok' } })
        expect(started.agentSessionId).toBe('stored-session-7')
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: expect.stringMatching(/^resume:/) }))
      })
    })

    it('redacts credentials in a failed Codex restore before reporting the error', async () => {
      await withRuntime(async (rt, events) => {
        await expect(rt.start({ ...resume, agent: { ...fakeAgent, id: 'codex' }, sessionId: 's-secret', env: { FAKE_ACP_LOAD: 'fail', FAKE_ACP_LOAD_ERROR: 'restore refused: token=example-sensitive-value' } })).rejects.toThrow('restore refused: token=[redacted]')
        expect(JSON.stringify(events)).not.toContain('example-sensitive-value')
      })
    })

    it('never loads a session that is not resumed', async () => {
      await withRuntime(async (rt, events) => {
        const started = await rt.start({ ...resume, resume: false, sessionId: 's-fresh', env: { FAKE_ACP_LOAD: 'ok', FAKE_ACP_RESUME: 'ok' } })
        expect(started.agentSessionId).toBe('fake-session-1')
        expect(started.resumeFailed).toBeUndefined()
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: expect.stringMatching(/^load:/) }))
        expect(events).not.toContainEqual(expect.objectContaining({ type: 'stderr', line: expect.stringMatching(/^resume:/) }))
      })
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

  it('fails the start with what the agent wrote to stderr when it exits on its own', async () => {
    const rt = new AcpRuntime({ clientName: 'workhub-test', clientVersion: '0.0.0' })
    const events: AgentEvent[] = []
    rt.subscribe((e) => events.push(e))
    try {
      await expect(rt.start({ sessionId: 's-crash', agent: fakeAgent, account: null, cwd: process.cwd(), env: { FAKE_ACP_CRASH: '1' } })).rejects.toThrow(
        'agent exited during start (code 1):\nnpm error 404 Not Found\nError: not logged in, run `fake login`'
      )
      expect(events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('not logged in') })
    } finally {
      await rt.stopAll()
    }
  })

  it('stops the agent and fails the start when it never answers', async () => {
    const rt = new AcpRuntime({ clientName: 'workhub-test', clientVersion: '0.0.0', startTimeoutMs: 200 })
    const events: AgentEvent[] = []
    rt.subscribe((e) => events.push(e))
    try {
      await expect(rt.start({ sessionId: 's-silent', agent: fakeAgent, account: null, cwd: process.cwd(), env: { FAKE_ACP_SILENT: '1' } })).rejects.toThrow(
        /"Fake" did not finish starting within 0 s; it was stopped/
      )
      expect(events.at(-1)).toMatchObject({ type: 'state', state: 'error' })
      await expect(rt.prompt('s-silent', 'hello')).rejects.toThrow(/no ready ACP session/)
    } finally {
      await rt.stopAll()
    }
  })

  it.skipIf(process.platform === 'win32')('stops the agent by signalling its whole process group', async () => {
    const calls: [number, NodeJS.Signals][] = []
    const kill = (pid: number, signal: NodeJS.Signals) => {
      calls.push([pid, signal])
      process.kill(pid, signal)
    }
    const rt = new AcpRuntime({ clientName: 'workhub-test', clientVersion: '0.0.0', killTree: { kill } })
    try {
      await rt.start({ sessionId: 's-group', agent: fakeAgent, account: null, cwd: process.cwd(), env: {} })
      await rt.stop('s-group')
      expect(calls).toHaveLength(1)
      const [pid, signal] = calls[0]!
      expect(pid).toBeLessThan(0)
      expect(signal).toBe('SIGTERM')
    } finally {
      await rt.stopAll()
    }
  })
})
