import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, type AgentEvent } from '@workhub/core'
import {
  accessToken,
  ClaudeBridgeMapper,
  ClaudeNativeRuntime,
  ClaudePlanUsageReader,
  ClaudeSessionHistory,
  keychainServices,
  parsePlanUsage,
  permissionResult,
  PlanUsageError,
  rateLimitWindow,
  rejectedLimit,
  settleResult,
  toHistoryMessages
} from '../src/agent-claude-native'
import { agentEnv } from '../src/agent-claude-native/bridge/env.mjs'
import { parsePlist, workhub1SettingsFromPlist } from '../src/workhub1-import'

const fixtures = join(import.meta.dirname, 'fixtures')
const fakeBridge = join(fixtures, 'fake-bridge')
const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!

function waitFor(events: AgentEvent[], predicate: (e: AgentEvent) => boolean, ms = 5000): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const found = events.find(predicate)
      if (found) resolve(found)
      else if (Date.now() - started > ms) reject(new Error('timed out'))
      else setTimeout(tick, 10)
    }
    tick()
  })
}

const agentText = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'message' && e.role === 'agent' ? [e.text] : [])).join('')

describe('ClaudeNativeRuntime over the bridge protocol', () => {
  let rt: ClaudeNativeRuntime
  const events: AgentEvent[] = []
  const start = async (id: string, extra: Partial<Parameters<ClaudeNativeRuntime['start']>[0]> = {}) => {
    rt = new ClaudeNativeRuntime({ bridgeDir: fakeBridge, stopTimeoutMs: 2000 })
    events.length = 0
    rt.subscribe((e) => events.push(e))
    return rt.start({ sessionId: id, agent: claude, account: null, cwd: fixtures, env: {}, ...extra })
  }
  afterEach(async () => {
    await rt?.stopAll()
  })

  it('starts with a Workhub-chosen session id, reports models, permission mode, MCP servers and hook output', async () => {
    const started = await start('n1', { agentSessionId: 'aaaaaaaa-1111-4111-8111-111111111111', model: 'haiku', env: { CLAUDE_CONFIG_DIR: '/tmp/acme-claude' } })
    expect(started.agentSessionId).toBe('aaaaaaaa-1111-4111-8111-111111111111')
    expect(events.filter((e) => e.type === 'state').map((e) => e.type === 'state' && e.state)).toEqual(['starting', 'ready'])
    const models = await waitFor(events, (e) => e.type === 'models')
    expect(models.type === 'models' && models.models.map((m) => m.id)).toEqual(['default', 'haiku'])
    const mode = await waitFor(events, (e) => e.type === 'permissionMode')
    expect(mode.type === 'permissionMode' && mode.mode).toMatchObject({ id: 'default', source: 'agent', unattended: false })
    const mcp = await waitFor(events, (e) => e.type === 'monitor' && !!e.snapshot.mcpServers)
    expect(mcp.type === 'monitor' && mcp.snapshot.mcpServers).toEqual([{ name: 'acme-docs', state: 'running', toolCount: 2, tools: ['search', 'read'] }])
    const hook = await waitFor(events, (e) => e.type === 'notice')
    expect(hook).toMatchObject({ kind: 'hook', title: 'SessionStart · SessionStart:startup', text: 'Remember the acme rules.' })

    // The start line carries the session id (not resume), the model and the account folder.
    expect(await rt.prompt('n1', 'echo start')).toEqual({ stopReason: 'end_turn' })
    const echoed = JSON.parse(agentText(events)) as { cwd: string; start: Record<string, unknown>; configEnv: string }
    expect(echoed.start).toMatchObject({ sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', model: 'haiku', configDir: '/tmp/acme-claude' })
    expect(echoed.start['resume']).toBeUndefined()
    expect(echoed.configEnv).toBe('/tmp/acme-claude')
  })

  it('starts with the effort and the Claude permission mode asked for, and ignores a mode it does not know', async () => {
    const echoStart = async (id: string, extra: Partial<Parameters<ClaudeNativeRuntime['start']>[0]>) => {
      await start(id, extra)
      await rt.prompt(id, 'echo start')
      return (JSON.parse(agentText(events)) as { start: Record<string, unknown> }).start
    }
    expect(await echoStart('n-opts', { effort: 'high', modeId: 'acceptEdits' })).toMatchObject({ effort: 'high', permissionMode: 'acceptEdits' })
    await rt.stopAll()
    const other = await echoStart('n-acp', { modeId: 'code-agent' })
    expect(other['permissionMode']).toBeUndefined()
    expect(other['effort']).toBeUndefined()
  })

  it('offers the Claude permission modes and switches the running session to one live', async () => {
    const started = await start('n-mode', { modeId: 'plan' })
    expect(started.availableModes?.map((m) => m.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
    expect(started.currentModeId).toBe('plan')
    expect(started.permissionMode).toMatchObject({ id: 'plan', source: 'workhub' })
    events.length = 0
    await rt.setSessionMode('n-mode', 'acceptEdits')
    expect(events.find((e) => e.type === 'permissionMode')).toMatchObject({ currentModeId: 'acceptEdits', mode: { id: 'acceptEdits', label: 'Accept edits', unattended: false } })
    await rt.prompt('n-mode', 'echo start')
    expect((JSON.parse(agentText(events)) as { start: Record<string, unknown> }).start['switchedTo']).toBe('acceptEdits')
    await expect(rt.setSessionMode('n-mode', 'code-agent')).rejects.toThrow(/no permission mode/)
  })

  it('a reviewer offers no modes to switch to', async () => {
    const started = await start('n-review', { readOnly: true })
    expect(started.availableModes).toBeUndefined()
  })

  it('reports a turn refused by a usage limit', async () => {
    await start('n-limit')
    const result = await rt.prompt('n-limit', 'hit the limit')
    expect(result.stopReason).toBe('success')
    const limits = events.filter((e) => e.type === 'usageLimit')
    expect(limits[0]).toMatchObject({ type: 'usageLimit', window: '5h', resetsAt: 1_790_000_000_000 })
    expect(limits.length).toBeGreaterThanOrEqual(2)
    expect(limits.every((e) => e.sessionId === 'n-limit')).toBe(true)
  })

  it('resumes a session by id', async () => {
    await start('n2', { agentSessionId: 'bbbbbbbb-2222-4222-8222-222222222222', resume: true })
    await rt.prompt('n2', 'echo start')
    expect(JSON.parse(agentText(events)).start).toMatchObject({ resume: 'bbbbbbbb-2222-4222-8222-222222222222' })
  })

  it('streams the reply once (deltas, not the full message again) and sends images as content blocks', async () => {
    await start('n3')
    expect(await rt.prompt('n3', 'Reply with the single word pong.')).toEqual({ stopReason: 'end_turn' })
    expect(agentText(events)).toBe('pong')
    const usage = await waitFor(events, (e) => e.type === 'monitor' && !!e.snapshot.planUsage)
    expect(usage.type === 'monitor' && usage.snapshot.planUsage).toEqual([{ window: '5h', percent: 42, resetsAt: 1790000000000 }])
    events.length = 0
    await rt.prompt('n3', 'look', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }])
    expect(agentText(events)).toBe('pong with 1 image(s)')
  })

  it('asks for permission, answers with the chosen option and tracks the tool call', async () => {
    await start('n4')
    const turn = rt.prompt('n4', 'use a tool')
    const ask = await waitFor(events, (e) => e.type === 'permission')
    expect(ask).toMatchObject({ title: 'List files', detail: '$ ls' })
    expect(ask.type === 'permission' && ask.options.map((o) => o.optionId)).toEqual(['allow', 'allow-always', 'deny'])
    rt.respondPermission('n4', ask.type === 'permission' ? ask.requestId : '', 'allow-always')
    expect(await turn).toEqual({ stopReason: 'end_turn' })
    expect(agentText(events)).toBe('permission allow always')
    expect(events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && e.status)).toEqual(['in_progress', 'completed'])
  })

  it('interrupts a turn, toggles an MCP server and reports a refused setting as a notice', async () => {
    await start('n5')
    const turn = rt.prompt('n5', 'wait')
    await rt.cancel('n5')
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    rt.toggleMcp('n5', 'acme-docs', false)
    await waitFor(events, (e) => e.type === 'monitor' && e.snapshot.mcpServers?.[0]?.state === 'disabled')
    await rt.setModel('n5', 'nope')
    await waitFor(events, (e) => e.type === 'notice' && e.kind === 'warning' && e.text === 'no model nope')
  })

  it('sends a message typed during a turn at priority next: folded into the turn, or run as the next one', async () => {
    await start('n-mid')
    const states = () => events.filter((e) => e.type === 'state').map((e) => e.type === 'state' && e.state)
    events.length = 0
    const first = rt.prompt('n-mid', 'hold')
    const folded = rt.prompt('n-mid', 'fold')
    expect(await first).toEqual({ stopReason: 'end_turn' })
    expect(await folded).toEqual({ stopReason: 'end_turn' })
    expect(agentText(events)).toBe('folded next')
    expect(states()).toEqual(['busy', 'busy', 'ready'])

    events.length = 0
    const turn = rt.prompt('n-mid', 'hold')
    const late = rt.prompt('n-mid', 'after')
    await turn
    // The first turn is over but the late message still waits for its own: the session stays busy.
    expect(states()).toEqual(['busy', 'busy'])
    expect(await late).toEqual({ stopReason: 'end_turn' })
    expect(agentText(events)).toBe('next turn next')
    expect(states()).toEqual(['busy', 'busy', 'ready'])
  })

  it('stops by closing the bridge input and reports the session stopped', async () => {
    await start('n6')
    await rt.stop('n6')
    await waitFor(events, (e) => e.type === 'state' && e.state === 'stopped')
    await expect(rt.prompt('n6', 'x')).rejects.toThrow(/no Claude session/)
  })
})

describe('the environment the bridge hands to Claude Code', () => {
  it('drops Electron internals such as ELECTRON_RUN_AS_NODE and keeps the rest', () => {
    const env = agentEnv(
      { PATH: '/usr/bin', HOME: '/home/dana', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://localhost:5173', ELECTRON_NO_ASAR: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '15000' }
    )
    expect(env).toEqual({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '15000', PATH: '/usr/bin', HOME: '/home/dana' })
  })
  it('lets a value from the bridge env win over a default', () => {
    expect(agentEnv({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '1' }, { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '15000' })).toEqual({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '1' })
  })
  it('is what both bridge scripts pass to the SDK', () => {
    for (const script of ['bridge.mjs', 'oneshot.mjs']) {
      const source = readFileSync(join(import.meta.dirname, '../src/agent-claude-native/bridge', script), 'utf8')
      expect(source).toContain('agentEnv(process.env')
      expect(source).not.toMatch(/\.\.\.process\.env/)
    }
  })
})

describe('settleResult', () => {
  it('settles the prompts a result consumed and keeps later ones waiting while Claude has sends queued', () => {
    expect(settleResult(['a', 'b'], { user_message_uuids: ['a', 'b'], queued_turn_count: 0 })).toEqual({ settled: ['a', 'b'], stillBusy: false })
    expect(settleResult(['a', 'b'], { user_message_uuids: ['a'], queued_turn_count: 1 })).toEqual({ settled: ['a'], stillBusy: true })
    expect(settleResult(['a', 'b'], { user_message_uuid: 'b', queued_turn_count: 1 })).toEqual({ settled: ['a', 'b'], stillBusy: false })
    // A turn of something else (nothing of ours consumed) while ours waits.
    expect(settleResult(['a'], { user_message_uuids: ['x'], queued_turn_count: 1 })).toEqual({ settled: [], stillBusy: true })
  })
  it('settles everything when the CLI reports no uuids or nothing queued (older CLIs, interrupts)', () => {
    expect(settleResult(['a', 'b'], { subtype: 'success' })).toEqual({ settled: ['a', 'b'], stillBusy: false })
    expect(settleResult(['a', 'b'], { user_message_uuids: ['a'], queued_turn_count: 0 })).toEqual({ settled: ['a', 'b'], stillBusy: false })
  })
})

describe('ClaudeBridgeMapper', () => {
  it('ignores subagent traffic and keeps unstreamed text', () => {
    const m = new ClaudeBridgeMapper('s')
    expect(m.map({ type: 'sdk', message: { type: 'assistant', parent_tool_use_id: 'toolu_x', message: { content: [{ type: 'text', text: 'inner' }] } } })).toEqual([])
    const events = m.map({ type: 'sdk', message: { type: 'assistant', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } } })
    // A synthetic usage-limit answer is shown, and reported as a usage limit too.
    expect(events).toEqual([
      { sessionId: 's', type: 'message', role: 'agent', text: "You've hit your limit" },
      { sessionId: 's', type: 'usageLimit', message: "You've hit your limit" }
    ])
  })

  it('reports a usage limit from a rejected rate limit event, the SDK error flag or the old "|epoch" text', () => {
    const m = new ClaudeBridgeMapper('s')
    const rejected = m.map({ type: 'sdk', message: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1790000000, utilization: 1 } } })
    expect(rejected).toContainEqual({ sessionId: 's', type: 'usageLimit', window: 'weekly', resetsAt: 1_790_000_000_000 })
    // Extra usage still covers it: not a limit.
    expect(rejectedLimit({ status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed' })).toBeNull()
    expect(rejectedLimit({ status: 'allowed_warning', rateLimitType: 'five_hour' })).toBeNull()
    const flagged = m.map({ type: 'sdk', message: { type: 'assistant', error: 'rate_limit', message: { id: 'm2', model: 'claude-x', content: [] } } })
    expect(flagged).toEqual([{ sessionId: 's', type: 'monitor', snapshot: { model: 'claude-x' } }, { sessionId: 's', type: 'usageLimit' }])
    const old = m.map({ type: 'sdk', message: { type: 'assistant', message: { id: 'm3', model: '<synthetic>', content: [{ type: 'text', text: 'Claude AI usage limit reached|1760000000' }] } } })
    expect(old[1]).toEqual({ sessionId: 's', type: 'usageLimit', resetsAt: 1_760_000_000_000, message: 'Claude AI usage limit reached|1760000000' })
    // An ordinary synthetic message (an API error that is not a limit) is not.
    expect(m.map({ type: 'sdk', message: { type: 'assistant', message: { id: 'm4', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] } } }).some((e) => e.type === 'usageLimit')).toBe(false)
  })

  it('reads no permission mode in the settings as Claude\'s default mode', () => {
    const m = new ClaudeBridgeMapper('s')
    const modeOf = (defaults: object | undefined) => m.map({ type: 'options', models: [], ...(defaults ? { defaults } : {}) }).find((e) => e.type === 'permissionMode')
    expect(modeOf({ permissionMode: null, effort: null })).toMatchObject({ currentModeId: 'default', mode: { id: 'default', label: 'Ask before edits' } })
    expect(modeOf({ permissionMode: 'acceptEdits' })).toMatchObject({ currentModeId: 'acceptEdits' })
    expect(modeOf(undefined)).toBeUndefined()
  })

  it('drops hooks that said nothing and flags failed ones', () => {
    const m = new ClaudeBridgeMapper('s')
    const hook = (extra: object) => m.map({ type: 'sdk', message: { type: 'system', subtype: 'hook_response', hook_event: 'Stop', hook_name: 'Stop', output: '', stdout: '', stderr: '', ...extra } })
    expect(hook({ outcome: 'success' })).toEqual([])
    expect(hook({ outcome: 'error', stderr: 'boom' })).toMatchObject([{ type: 'notice', kind: 'hook', title: 'Stop', text: 'boom', failed: true }])
  })

  it('builds the permission answers Workhub 1 sends', () => {
    expect(permissionResult('allow', { a: 1 }, [])).toEqual({ behavior: 'allow', updatedInput: { a: 1 } })
    expect(permissionResult(null, {}, [])).toMatchObject({ behavior: 'deny' })
  })

  it('reads plan windows from rate limit events', () => {
    expect(rateLimitWindow({ rateLimitType: 'seven_day', utilization: 87 })).toEqual({ window: 'weekly', percent: 87 })
    expect(rateLimitWindow({ rateLimitType: 'overage', utilization: 0.1 })).toBeNull()
    expect(rateLimitWindow({ rateLimitType: 'five_hour' })).toBeNull()
  })
})

describe('ClaudeNativeRuntime stop', () => {
  it('frees the session id when a bridge had to be killed, so the next engine can start under it', async () => {
    const rt = new ClaudeNativeRuntime({ bridgeDir: fakeBridge, stopTimeoutMs: 300 })
    const events: AgentEvent[] = []
    rt.subscribe((e) => events.push(e))
    try {
      await rt.start({ sessionId: 'hang', agent: claude, account: null, cwd: fixtures, env: {} })
      await rt.prompt('hang', 'ignore close')
      await rt.stop('hang')
      expect(events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'stopped' })
      await expect(rt.start({ sessionId: 'hang', agent: claude, account: null, cwd: fixtures, env: {} })).resolves.toMatchObject({ agentName: 'Claude Code' })
    } finally {
      await rt.stopAll()
    }
  })
})

describe('Claude session history', () => {
  it('lists every session of an account with its folder and title', async () => {
    const history = new ClaudeSessionHistory({ bridgeDir: fakeBridge })
    const entries = await history.list({ agentId: 'claude', accountId: 'work', configDir: '/tmp/acme-work' })
    expect(entries).toEqual([
      { agentId: 'claude', accountId: 'work', agentSessionId: 'sess-1', title: 'Build fix', firstPrompt: 'fix it', cwd: '/tmp/acme-web', gitBranch: 'main', lastModified: 2000, createdAt: 1000 },
      { agentId: 'claude', accountId: 'work', agentSessionId: 'sess-2', title: 'Account /tmp/acme-work', lastModified: 1500 }
    ])
    expect(await history.messages('sess-1', '/tmp/acme-web')).toEqual([{ kind: 'user', text: 'hello from sess-1 in /tmp/acme-web' }])
  })

  it('looks a conversation up in every project when its folder does not hold it', async () => {
    const history = new ClaudeSessionHistory({ bridgeDir: fakeBridge })
    expect(await history.messages('sess-1', '/tmp/moved')).toEqual([{ kind: 'user', text: 'hello from sess-1 in undefined' }])
  })

  it('turns stored messages into a replayable conversation', () => {
    const messages = toHistoryMessages([
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: [{ type: 'text', text: 'Look at this' }, { type: 'image', source: {} }] } },
      {
        type: 'user',
        message: {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/PNG', data: 'iVBORw0K' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
            { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'Qk0=' } }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } },
      { type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'subagent' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
    ])
    expect(messages).toEqual([
      { kind: 'user', text: 'Look at this', images: 1 },
      // Only the stored images that can be shown again come back; the count keeps all of them.
      { kind: 'user', text: '', images: 3, imageData: [{ mediaType: 'image/png', data: 'iVBORw0K' }] },
      { kind: 'agent', text: 'Sure.' },
      { kind: 'tool', id: 't1', title: 'Read b.ts', detail: '/a/b.ts', failed: true, view: { kind: 'read', path: '/a/b.ts' }, result: { isError: true } },
      { kind: 'agent', text: 'Done.' }
    ])
  })
})

describe('Claude plan usage (opt-in)', () => {
  const body = { five_hour: { utilization: 37.5, resets_at: '2026-10-01T15:00:00Z' }, seven_day: { utilization: '80', resets_at: null }, seven_day_opus: null, extra_usage: { is_enabled: false } }

  it('parses the windows of a usage response', () => {
    expect(parsePlanUsage(body)).toEqual([
      { window: '5h', percent: 37.5, resetsAt: Date.parse('2026-10-01T15:00:00Z') },
      { window: 'weekly', percent: 80 }
    ])
  })

  it('reads the token from the folder credentials and sends it only to the usage endpoint', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const reader = new ClaudePlanUsageReader({
      readCredentials: async (p) => (p.endsWith('.credentials.json') ? JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } }) : null),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return new Response(JSON.stringify(body), { status: 200 })
      }) as typeof fetch
    })
    expect((await reader.read('/tmp/acme-claude')).map((w) => w.window)).toEqual(['5h', 'weekly'])
    // Cached for 45 s.
    await reader.read('/tmp/acme-claude')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage')
    expect((calls[0]?.[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-123')
  })

  it('reports a missing or expired login', async () => {
    const none = new ClaudePlanUsageReader({ readCredentials: async () => null, platform: 'linux' })
    await expect(none.read('/tmp/x')).rejects.toMatchObject({ code: 'noLogin' })
    const expired = new ClaudePlanUsageReader({
      readCredentials: async () => JSON.stringify({ claudeAiOauth: { accessToken: 't' } }),
      fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    })
    await expect(expired.read('/tmp/x')).rejects.toBeInstanceOf(PlanUsageError)
  })

  it('names Keychain items the way Claude Code does', () => {
    expect(keychainServices('/u/.claude', '/u/.claude', '/u/.claude').at(-1)).toBe('Claude Code-credentials')
    expect(keychainServices('/u/.claude-work', '/u/.claude-work', '/u/.claude')).toEqual([expect.stringMatching(/^Claude Code-credentials-[0-9a-f]{8}$/)])
    expect(accessToken('not json')).toBeNull()
  })
})

describe('Workhub 1 settings (read-only import)', () => {
  const xml = readFileSync(join(fixtures, 'workhub1-defaults.plist'), 'utf8')

  it('parses an XML property list', () => {
    const root = parsePlist(xml) as Record<string, unknown>
    expect(root['AppleLanguages']).toEqual(['es'])
    expect(root['settings.prBabysitter']).toBe(false)
    expect(root['terminal.fontSize']).toBe(14.5)
    expect(root['title']).toBe('Fish & chips <3')
    expect(root['empty']).toEqual({})
  })

  it('decodes the JSON values Workhub 1 keeps as data', () => {
    const v1 = workhub1SettingsFromPlist(xml)
    expect(v1.mainAccount).toEqual({ name: 'Personal', configDirectory: '~/.claude', command: '' })
    expect(v1.secondAccount?.configDirectory).toBe('~/.claude-work')
    expect(v1.profiles?.[0]).toMatchObject({ id: 'acme', githubScope: 'org:acme', folders: [{ path: '~/acme' }] })
    expect(v1.jira?.['acme']?.site).toBe('acme.example.com')
  })

  it('reads the modules, options and sidebar keys, and leaves runtime state out', () => {
    const v1 = workhub1SettingsFromPlist(readFileSync(join(fixtures, 'workhub1-modules.plist'), 'utf8'))
    expect(v1.automations?.[0]).toMatchObject({ name: 'PR reviews', useSecondAccount: true, triggers: { slackChannelIds: ['C000REVIEW'] } })
    expect(v1.slack).toMatchObject({ enabled: true, profileID: 'acme', channels: [{ id: 'C000REVIEW' }] })
    // Threads are only counted: nothing but whether they are closed is kept.
    expect(v1.slackThreads).toEqual([{ closed: false }, { closed: true }])
    expect(v1.observability?.['acme']).toMatchObject({ elasticURL: 'https://elastic.example.com:9200', auth: { basic: { username: 'reader' } } })
    expect(v1.openSessions?.groups).toHaveLength(1)
    expect(v1.notifications).toEqual({ pullRequests: false, slack: false })
    expect(v1).toMatchObject({ healthAlerts: false, usageChecker: '~/usageChecker', usageRefreshMinutes: 10, promptLanguage: 'spanish', appLanguage: 'es', sidebarProfile: 'acme' })
    expect(v1.protectedBranches).toBe('main, trunk')
    expect(v1.sessionModels).toEqual({ '.claude': 'opus' })
    expect(v1.sessionEfforts).toEqual({ '.claude-work': 'medium' })
    expect(v1.appearance).toEqual({ 'terminal.fontSize': 17, 'terminal.fontFamily': '' })
    expect(JSON.stringify(v1)).not.toContain('cursors')
  })
})
