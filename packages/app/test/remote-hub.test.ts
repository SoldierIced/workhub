import { describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, RemoteRefused, type RemoteDevice } from '../src/main/remote'
import { REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'
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

function setup(caps: RemoteCapability[] = ['sessions', 'pullRequests', 'automations', 'health']) {
  const { ipc: inner, registered } = fakeIpc()
  const { ipc, handlers } = recordIpc(inner)
  const calls: [string, unknown[]][] = []
  ipc.handle('sessions:list', () => [{ id: 's1' }])
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
  ipc.on('sessions:ready', () => void calls.push(['sessions:ready', []]))
  const log = { warn: vi.fn() }
  const hub = new RemoteHub({ handlers, profileFolders: async (profileId) => (profileId === 'work' ? ['/work/api', '/work/web'] : []), log })
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
  it('routes allowed invokes to the registered handler', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'sessions:list', [])).resolves.toEqual([{ id: 's1' }])
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
})
