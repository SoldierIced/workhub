import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, RemoteRefused, type RemoteDevice } from '../src/main/remote'
import { REMOTE_EVENTS, REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'
import { isRemoteForbiddenMode, REMOTE_COSTLY_RATE, REMOTE_GENERIC_ERROR, REMOTE_MAX_IN_FLIGHT, REMOTE_RATE } from '../src/main/remote/dispatcher'
import type { RemoteCapability } from '../src/shared/remote-api'

function fakeIpc() {
  const registered: string[] = []
  const ipc: IpcRegistrar = {
    handle: (channel) => void registered.push(`handle ${channel}`),
    on: (channel) => void registered.push(`on ${channel}`)
  }
  return { ipc, registered }
}

function device(id: string, caps: RemoteCapability[]): RemoteDevice & { events: [string, unknown[]][] } {
  const events: [string, unknown[]][] = []
  return { id, capabilities: new Set(caps), emit: (channel, args) => void events.push([channel, args]), events }
}

function setup(caps: RemoteCapability[] = ['sessions', 'pullRequests', 'automations', 'health', 'plan'], clock?: () => number) {
  const { ipc: inner, registered } = fakeIpc()
  const { ipc, handlers } = recordIpc(inner)
  const calls: [string, unknown[]][] = []
  ipc.handle('sessions:list', () => [{ id: 's1' }, { id: 'reviewer', readOnly: true }])
  ipc.handle('sessions:setAgentMode', (_e, id, modeId) => ({ id, modeId }))
  ipc.handle('sessions:setModel', (_e, id, model) => ({ id, model }))
  ipc.handle('automations:save', () => true)
  ipc.handle('automations:runNow', () => true)
  ipc.handle('health:get', () => {
    throw new Error('ENOENT: no such file /home/someone/private/thing')
  })
  ipc.handle('sessions:start', (_e, input) => ({ started: input }))
  ipc.handle('sessions:reopen', (_e, identity, input) => ({ identity, started: input }))
  ipc.handle('sessions:prompt', (e, id, text, _images, token) => {
    e.sender.send('sessions:promptStarted', id, token)
    return `${e.sender.id}:${token}:${text}`
  })
  ipc.handle('config:get', () => ({ config: { profiles: [] }, dataDir: '/home/ana/.workhub', issues: [] }))
  ipc.handle('hub:pickFolder', () => '/anywhere')
  ipc.handle('codeHost:lists', (_e, profileId) => ({ profileId }))
  ipc.on('sessions:permission', (_e, ...args) => void calls.push(['sessions:permission', args]))
  ipc.on('sessions:mcp', (_e, ...args) => void calls.push(['sessions:mcp', args]))
  ipc.on('sessions:ready', () => void calls.push(['sessions:ready', []]))
  const log = { warn: vi.fn() }
  const hub = new RemoteHub({ handlers, profileFolders: async (profileId) => (profileId === 'work' ? ['/work/api', '/work/web'] : []), log, now: clock })
  const phone = device('phone', caps)
  const detach = hub.attach(phone)
  return { hub, phone, detach, calls, registered, log }
}

describe('recordIpc', () => {
  it('registers every handler with the wrapped registrar as before', () => {
    const { registered } = setup()
    expect(registered).toContain('handle sessions:list')
    expect(registered).toContain('on sessions:permission')
  })
})

describe('RemoteHub', () => {
  it('lets a device drive MCP servers with the four actions only (an unknown one would disable a server)', () => {
    const { hub, calls } = setup()
    hub.message('phone', 'sessions:mcp', ['s1', 'refresh'])
    hub.message('phone', 'sessions:mcp', ['s1', 'reconnect', 'docs'])
    expect(calls).toEqual([
      ['sessions:mcp', ['s1', 'refresh']],
      ['sessions:mcp', ['s1', 'reconnect', 'docs']]
    ])
    expect(() => hub.message('phone', 'sessions:mcp', ['s1', 'nuke', 'docs'])).toThrow(/MCP action/)
    expect(() => hub.message('phone', 'sessions:mcp', ['s1', 'enable', '--flag'])).toThrow(/server name/)
    expect(() => hub.message('phone', 'sessions:permission', ['s1', { id: 'r1' }, 'allow'])).toThrow(/request id/)
    expect(calls).toHaveLength(2)
  })

  it('routes allowed invokes to the registered handler', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'sessions:list', [])).resolves.toEqual([{ id: 's1' }, { id: 'reviewer', readOnly: true }])
    await expect(hub.invoke('phone', 'codeHost:lists', ['work'])).resolves.toEqual({ profileId: 'work' })
  })

  it('refuses channels outside the allowlist, even when a handler exists', async () => {
    const { hub, log } = setup()
    await expect(hub.invoke('phone', 'hub:pickFolder', [])).rejects.toBeInstanceOf(RemoteRefused)
    await expect(hub.invoke('phone', 'hub:pickFolder', [])).rejects.toThrow(/not available remotely/)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refused hub:pickFolder'))
  })

  it('refuses a channel whose capability the device was not granted', async () => {
    const { hub } = setup(['pullRequests'])
    await expect(hub.invoke('phone', 'sessions:list', [])).rejects.toBeInstanceOf(RemoteRefused)
    await expect(hub.invoke('phone', 'codeHost:lists', ['work'])).resolves.toEqual({ profileId: 'work' })
    await expect(hub.invoke('phone', 'config:get', [])).resolves.toMatchObject({ dataDir: '' })
  })

  it('refuses a device that is not connected', async () => {
    const { hub, detach } = setup()
    detach()
    await expect(hub.invoke('phone', 'sessions:list', [])).rejects.toThrow(/not connected/)
    expect(() => hub.message('phone', 'sessions:permission', [])).toThrow(/not connected/)
  })

  it('only starts sessions in a folder the profile lists', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'sessions:start', [{ profileId: 'work', agentKey: 'claude', cwd: '/work/api' }])).resolves.toEqual({
      started: { profileId: 'work', agentKey: 'claude', cwd: '/work/api' }
    })
    await expect(hub.invoke('phone', 'sessions:start', [{ profileId: 'work', agentKey: 'claude', cwd: '/etc' }])).rejects.toThrow(/profile folders/)
    await expect(hub.invoke('phone', 'sessions:start', [{ profileId: 'other', agentKey: 'claude', cwd: '/work/api' }])).rejects.toThrow(/profile folders/)
    await expect(hub.invoke('phone', 'sessions:start', [{ profileId: 'work', agentKey: 'claude', cwd: '' }])).rejects.toThrow(/folder is required/)
    await expect(hub.invoke('phone', 'sessions:start', [null])).rejects.toThrow(/session input/)
    await expect(hub.invoke('phone', 'sessions:reopen', ['id-1', { profileId: 'work', agentKey: 'claude', cwd: '/tmp' }])).rejects.toThrow(/profile folders/)
    await expect(hub.invoke('phone', 'sessions:reopen', ['id-1', { profileId: 'work', agentKey: 'claude', cwd: '/work/web' }])).resolves.toMatchObject({ identity: 'id-1' })
  })

  it('answers a handler that talks back to its sender by sending to the device', async () => {
    const { hub, phone } = setup()
    const result = await hub.invoke('phone', 'sessions:prompt', ['s1', 'hello', [], 7])
    expect(result).toBe('1000000:7:hello')
    expect(phone.events).toEqual([['sessions:promptStarted', ['s1', 7]]])
  })

  it('gives every device a sender id of its own, apart from any window', async () => {
    const { hub, phone } = setup()
    const tablet = device('tablet', ['sessions'])
    hub.attach(tablet)
    expect(hub.connected()).toEqual(['phone', 'tablet'])
    const a = await hub.invoke('phone', 'sessions:prompt', ['s1', 'a', [], 1])
    const b = await hub.invoke('tablet', 'sessions:prompt', ['s1', 'b', [], 1])
    expect(a).toBe('1000000:1:a')
    expect(b).toBe('1000001:1:b')
    expect(phone.events).toEqual([['sessions:promptStarted', ['s1', 1]]])
    expect(tablet.events).toEqual([['sessions:promptStarted', ['s1', 1]]])
  })

  it('redacts the data folder from the config snapshot', async () => {
    const { hub } = setup()
    const snapshot = (await hub.invoke('phone', 'config:get', [])) as { dataDir: string; issues: unknown[] }
    expect(snapshot.dataDir).toBe('')
    expect(snapshot.issues).toEqual([])
  })

  it('never starts a session, nor switches one, to a mode that skips permissions', async () => {
    const { hub } = setup()
    const base = { profileId: 'work', agentKey: 'claude', cwd: '/work/api' }
    for (const modeId of ['bypassPermissions', 'BYPASSPERMISSIONS', 'auto', 'yolo', 'full-access', 'full-auto']) {
      await expect(hub.invoke('phone', 'sessions:start', [{ ...base, modeId }])).rejects.toThrow(/not available remotely/)
      await expect(hub.invoke('phone', 'sessions:reopen', ['id-1', { ...base, modeId }])).rejects.toThrow(/not available remotely/)
      await expect(hub.invoke('phone', 'sessions:setAgentMode', ['s1', modeId])).rejects.toThrow(/not available remotely/)
    }
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, modeId: 'plan' }])).resolves.toMatchObject({ started: { modeId: 'plan' } })
    await expect(hub.invoke('phone', 'sessions:setAgentMode', ['s1', 'acceptEdits'])).resolves.toEqual({ id: 's1', modeId: 'acceptEdits' })
    expect(isRemoteForbiddenMode('default')).toBe(false)
  })

  it('keeps the mode of a read-only session', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'sessions:setAgentMode', ['reviewer', 'default'])).rejects.toThrow(/read-only/)
    await expect(hub.invoke('phone', 'sessions:setAgentMode', ['s1', ''])).rejects.toThrow(/mode id is required/)
  })

  it('refuses argv-like strings that could become options', async () => {
    const { hub } = setup()
    const base = { profileId: 'work', agentKey: 'claude', cwd: '/work/api' }
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, model: '--dangerously-skip-permissions' }])).rejects.toThrow(/model is not valid/)
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, effort: 'high value' }])).rejects.toThrow(/effort is not valid/)
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, resumeAgentSessionId: '-x' }])).rejects.toThrow(/session id is not valid/)
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, worktree: { branch: '--force' } }])).rejects.toThrow(/branch is not valid/)
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, model: 'a'.repeat(129) }])).rejects.toThrow(/model is not valid/)
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, model: 42 }])).rejects.toThrow(/must be text/)
    await expect(hub.invoke('phone', 'sessions:reopen', ['-id', base])).rejects.toThrow(/identity is not valid/)
    await expect(hub.invoke('phone', 'sessions:setModel', ['s1', '--model=x'])).rejects.toThrow(/model is not valid/)
    await expect(hub.invoke('phone', 'sessions:setModel', ['s1', null])).resolves.toEqual({ id: 's1', model: null })
    await expect(hub.invoke('phone', 'sessions:setModel', ['s1', 'vendor/model-1.5:latest'])).resolves.toEqual({ id: 's1', model: 'vendor/model-1.5:latest' })
    const ok = { ...base, model: 'model-x', effort: 'high', resumeAgentSessionId: 'abc-123', worktree: { branch: 'feat/thing' } }
    await expect(hub.invoke('phone', 'sessions:start', [ok])).resolves.toEqual({ started: ok })
    await expect(hub.invoke('phone', 'sessions:start', [{ ...base, worktree: { branch: '' } }])).resolves.toMatchObject({ started: { worktree: { branch: '' } } })
  })

  it('refuses automations:save even when a handler exists', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'automations:save', [{ id: 'a' }])).rejects.toThrow(/not available remotely/)
    await expect(hub.invoke('phone', 'automations:runNow', ['a'])).resolves.toBe(true)
  })

  it('sends a generic message for handler errors and logs the real one', async () => {
    const { hub, log } = setup()
    const err = await hub.invoke('phone', 'health:get', []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RemoteRefused)
    expect((err as Error).message).toBe(REMOTE_GENERIC_ERROR)
    expect((err as Error).message).not.toContain('/home')
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ENOENT'))
  })

  it('limits how often a device calls, and recovers over time', async () => {
    let now = 0
    const { hub } = setup(undefined, () => now)
    for (let i = 0; i < REMOTE_RATE.calls; i++) await hub.invoke('phone', 'sessions:list', [])
    await expect(hub.invoke('phone', 'sessions:list', [])).rejects.toThrow(/too many calls/)
    expect(() => hub.message('phone', 'sessions:permission', ['s1', 'r1', 'allow'])).toThrow(/too many calls/)
    now += REMOTE_RATE.windowMs
    await expect(hub.invoke('phone', 'sessions:list', [])).resolves.toBeTruthy()
  })

  it('gives agent runs a tighter budget of their own', async () => {
    let now = 0
    const { hub } = setup(undefined, () => now)
    for (let i = 0; i < REMOTE_COSTLY_RATE.calls; i++) await hub.invoke('phone', 'automations:runNow', ['a'])
    await expect(hub.invoke('phone', 'automations:runNow', ['a'])).rejects.toThrow(/too many new agent runs/)
    await expect(hub.invoke('phone', 'sessions:start', [{ profileId: 'work', agentKey: 'claude', cwd: '/work/api' }])).rejects.toThrow(/too many new agent runs/)
    await expect(hub.invoke('phone', 'sessions:list', [])).resolves.toBeTruthy()
    now += REMOTE_COSTLY_RATE.windowMs
    await expect(hub.invoke('phone', 'automations:runNow', ['a'])).resolves.toBe(true)
  })

  it('caps the calls a device has waiting at once', async () => {
    const { ipc: inner } = fakeIpc()
    const { ipc, handlers } = recordIpc(inner)
    const pending: (() => void)[] = []
    ipc.handle('sessions:list', () => new Promise<void>((resolve) => void pending.push(resolve)))
    const hub = new RemoteHub({ handlers, profileFolders: async () => [] })
    hub.attach(device('phone', ['sessions']))
    const waiting = Array.from({ length: REMOTE_MAX_IN_FLIGHT }, () => hub.invoke('phone', 'sessions:list', []))
    await Promise.resolve()
    await expect(hub.invoke('phone', 'sessions:list', [])).rejects.toThrow(/at once/)
    pending.forEach((resolve) => resolve())
    await Promise.all(waiting)
    const next = hub.invoke('phone', 'sessions:list', [])
    await Promise.resolve()
    pending.at(-1)!()
    await expect(next).resolves.toBeUndefined()
  })

  it('sends a device only the config fields it shows', async () => {
    const { ipc: inner } = fakeIpc()
    const { ipc, handlers } = recordIpc(inner)
    const criticalities = [{ id: 'high', label: 'High' }]
    ipc.handle('config:get', () => ({
      config: {
        version: 1,
        connections: [{ id: 'c1', kind: 'tracker', settings: { baseUrl: 'https://tracker.example.com' } }],
        agents: [{ id: 'custom', env: { TOKEN: 'secret' } }],
        accounts: [{ id: 'acc', configDir: '/private/acc' }],
        automations: [{ id: 'nightly', prompt: 'do things', folder: '/private/repo' }],
        profiles: [{ id: 'work', name: 'Work', color: '#fff', connections: { tracker: 'c1' }, accountIds: ['acc'], modules: { plan: true }, folders: ['/private/repo'], envNames: ['TOKEN'], planner: { inbox: { criticalities, project: 'SECRET' } } }],
        activeProfileId: 'work'
      },
      issues: [{ path: 'x', message: '/private/config.json' }],
      agents: [{ id: 'custom' }],
      providers: [{ kind: 'tracker' }],
      connectionsWithSecret: ['c1'],
      dataDir: '/private/data',
      loadError: 'could not read /private/config.json'
    }))
    ipc.handle('config:effectiveAgents', () => [
      { key: 'claude:acc', label: 'Claude', agent: { id: 'claude', name: 'Claude', adapter: 'acp', command: '/private/bin/claude', args: ['--x'], env: { TOKEN: 'secret' }, capabilities: {}, modeSemantics: 'permission', modelArgs: ['--model', '{model}'] }, account: { id: 'acc', agentId: 'claude', name: 'Personal', configDir: '/private/acc', env: { K: 'v' } } }
    ])
    const hub = new RemoteHub({ handlers, profileFolders: async () => [] })
    hub.attach(device('phone', []))
    const snapshot = await hub.invoke('phone', 'config:get', [])
    expect(snapshot).toEqual({
      config: {
        version: 1,
        connections: [],
        agents: [],
        accounts: [],
        profiles: [{ id: 'work', name: 'Work', color: '#fff', connections: {}, accountIds: [], modules: { plan: true }, planner: { inbox: { criticalities } } }],
        activeProfileId: 'work'
      },
      issues: [],
      agents: [],
      providers: [],
      connectionsWithSecret: [],
      dataDir: '',
      loadError: 'the desktop could not load its config'
    })
    const agents = await hub.invoke('phone', 'config:effectiveAgents', ['work'])
    expect(agents).toEqual([
      { key: 'claude:acc', label: 'Claude', agent: { id: 'claude', name: 'Claude', adapter: 'acp', command: '', args: [], capabilities: {}, modeSemantics: 'permission' }, account: { id: 'acc', agentId: 'claude', name: 'Personal' } }
    ])
    expect(JSON.stringify([snapshot, agents])).not.toMatch(/private|secret|SECRET/)
  })

  it('delivers allowed one-way messages and refuses the rest', () => {
    const { hub, calls } = setup()
    hub.message('phone', 'sessions:permission', ['s1', 'r1', 'allow'])
    expect(calls).toEqual([['sessions:permission', ['s1', 'r1', 'allow']]])
    expect(() => hub.message('phone', 'sessions:ready', [])).toThrow(RemoteRefused)
    expect(calls).toHaveLength(1)
  })

  it('fans events out to the devices whose capabilities cover them', () => {
    const { hub, phone } = setup(['sessions'])
    const watch = device('watch', ['health'])
    hub.attach(watch)
    hub.tap('session:changed', [{ id: 's1' }])
    hub.tap('metricAlerts:changed', ['work'])
    hub.tap('config:changed', [])
    hub.tap('settings:navigate', ['general'])
    expect(phone.events).toEqual([
      ['session:changed', [{ id: 's1' }]],
      ['config:changed', []]
    ])
    expect(watch.events).toEqual([
      ['metricAlerts:changed', ['work']],
      ['config:changed', []]
    ])
  })

  it('keeps delivering to other devices when one throws', () => {
    const { hub, phone, log } = setup(['sessions'])
    hub.attach({ id: 'broken', capabilities: new Set(['sessions']), emit: () => { throw new Error('gone') } })
    hub.tap('session:removed', ['s1'])
    expect(phone.events).toEqual([['session:removed', ['s1']]])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('broken'))
  })

  it('stops events after detach, and a stale detach does not drop a reconnected device', () => {
    const { hub, phone, detach } = setup(['sessions'])
    detach()
    hub.tap('session:removed', ['s1'])
    expect(phone.events).toEqual([])
    const again = device('phone', ['sessions'])
    hub.attach(again)
    detach()
    hub.tap('session:removed', ['s2'])
    expect(again.events).toEqual([['session:removed', ['s2']]])
  })
})

describe('allowlist', () => {
  it('never exposes window, folder, secret or desktop-opening channels', () => {
    const exposed = [...Object.keys(REMOTE_INVOKES), ...Object.keys(REMOTE_MESSAGES)]
    const forbidden = /^(windows|tray|trayPopover|settings|setup|files|localReview|profileEnv|accountEnv|updates|diag|notifications|systemNotifications):|pickFolder|openExternal|openWindow|reveal|:test$|sessions:ready|sessions:write|sessions:resize|config:(save|delete|set|apply|import)/
    expect(exposed.filter((c) => forbidden.test(c))).toEqual([])
  })

  it('never lets a device define or delete an automation', () => {
    expect(REMOTE_INVOKES['automations:save']).toBeUndefined()
    expect(REMOTE_INVOKES['automations:remove']).toBeUndefined()
    expect(REMOTE_INVOKES['automations:runNow']).toBe('automations')
  })

  it('lists only events main taps', () => {
    expect(REMOTE_EVENTS['remote:notification']).toBeUndefined()
  })
})
