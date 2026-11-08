import { describe, expect, it } from 'vitest'
import { buildHub, type HubTransport } from '../src/shared/hub-client'

function fakeTransport() {
  const invoked: [string, unknown[]][] = []
  const sent: [string, unknown[]][] = []
  const subscriptions = new Map<string, (...args: unknown[]) => void>()
  const unsubscribed: string[] = []
  const transport: HubTransport = {
    invoke: async (channel, ...args) => {
      invoked.push([channel, args])
      return `${channel} answered`
    },
    send: (channel, ...args) => void sent.push([channel, args]),
    subscribe: (channel, cb) => {
      subscriptions.set(channel, cb as (...args: unknown[]) => void)
      return () => void unsubscribed.push(channel)
    }
  }
  return { transport, invoked, sent, subscriptions, unsubscribed }
}

describe('buildHub', () => {
  it('maps methods to the channels main registers, over any transport', async () => {
    const { transport, invoked, sent } = fakeTransport()
    const hub = buildHub(transport, 'linux')
    expect(hub.platform).toBe('linux')
    await expect(hub.sessions.list()).resolves.toBe('sessions:list answered')
    await hub.sessions.prompt('s1', 'hi', [], 3)
    await hub.codeHost.lists('work', true)
    hub.sessions.respondPermission('s1', 'r1', 'allow', undefined)
    expect(invoked).toEqual([
      ['sessions:list', []],
      ['sessions:prompt', ['s1', 'hi', [], 3]],
      ['codeHost:lists', ['work', true]]
    ])
    expect(sent).toEqual([['sessions:permission', ['s1', 'r1', 'allow', undefined]]])
  })

  it('normalizes optional arguments the way the preload did', async () => {
    const { transport, invoked, sent } = fakeTransport()
    const hub = buildHub(transport, 'mac')
    hub.openExternal('https://example.com')
    await hub.files.read('/tmp/a.txt')
    await hub.files.read('/tmp/a.txt', { stamp: null }, true)
    expect(sent).toEqual([['hub:openExternal', ['https://example.com', null]]])
    expect(invoked).toEqual([
      ['files:read', ['/tmp/a.txt', null, false]],
      ['files:read', ['/tmp/a.txt', { stamp: null }, true]]
    ])
  })

  it('subscribes to main events and returns the unsubscribe', () => {
    const { transport, subscriptions, unsubscribed } = fakeTransport()
    const hub = buildHub(transport, 'windows')
    const seen: unknown[] = []
    const off = hub.sessions.onChanged((view) => void seen.push(view))
    subscriptions.get('session:changed')?.({ id: 's1' })
    expect(seen).toEqual([{ id: 's1' }])
    off()
    expect(unsubscribed).toEqual(['session:changed'])
  })
})
