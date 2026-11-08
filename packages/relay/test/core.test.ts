import { describe, expect, it, vi } from 'vitest'
import { generateIdentity, makeAuth, type RelayMessage } from '@workhub/protocol'
import { MemoryPushStore, RelayCore, type PushProvider, type Socket } from '../src/core'

const NOW = 1_800_000_000_000
const E = 'A'.repeat(43)

function fakeSocket() {
  const sent: RelayMessage[] = []
  const closed: [number, string][] = []
  const socket: Socket = { send: (text) => void sent.push(JSON.parse(text)), close: (code, reason) => void closed.push([code, reason]) }
  return { socket, sent, closed }
}

function harness(options: { push?: PushProvider; pushStore?: MemoryPushStore; limits?: Partial<import('../src/core').RelayLimits> } = {}) {
  let now = NOW
  const log = { info: vi.fn(), warn: vi.fn() }
  const core = new RelayCore({ ...options, now: () => now, log })
  const join = (address = '1.2.3.4') => {
    const s = fakeSocket()
    const peer = core.connect(s.socket, address)
    const send = (message: unknown) => core.receive(peer!, JSON.stringify(message))
    return { ...s, peer: peer!, send, last: () => s.sent[s.sent.length - 1] }
  }
  const authed = (identity = generateIdentity(), address?: string) => {
    const c = join(address)
    c.send(makeAuth(identity, now))
    return { ...c, identity }
  }
  return { core, join, authed, advance: (ms: number) => void (now += ms), log }
}

describe('RelayCore auth', () => {
  it('welcomes a signed auth and refuses everything before it', () => {
    const h = harness()
    const c = h.join()
    c.send({ t: 'join', room: 'a'.repeat(32) })
    expect(c.last()).toMatchObject({ t: 'error', code: 'unauthenticated' })
    const me = generateIdentity()
    c.send(makeAuth(me, NOW))
    expect(c.last()).toEqual({ t: 'welcome', id: me.id, now: NOW })
    expect(h.core.isAuthenticated(c.peer)).toBe(true)
  })

  it('closes a forged or stale auth, and refuses junk frames', () => {
    const h = harness()
    const c = h.join()
    c.send({ ...makeAuth(generateIdentity(), NOW), id: generateIdentity().id })
    expect(c.last()).toMatchObject({ t: 'error', code: 'bad-auth' })
    expect(c.closed).toEqual([[1008, 'bad auth']])
    const d = h.join()
    h.core.receive(d.peer, 'not json')
    expect(d.last()).toMatchObject({ t: 'error', code: 'bad-message' })
    d.send({ t: 'nope' })
    expect(d.last()).toMatchObject({ t: 'error', code: 'bad-message' })
  })

  it('tells about the push key when push is configured', () => {
    const push: PushProvider = { publicKey: 'VAPID', send: async () => {} }
    const h = harness({ push })
    const c = h.authed()
    expect(c.last()).toMatchObject({ t: 'welcome', push: { vapidPublicKey: 'VAPID' } })
  })
})

describe('RelayCore rooms and delivery', () => {
  it('delivers a body to the named peer in the room and tells presence both ways', () => {
    const h = harness()
    const desktop = h.authed()
    const phone = h.authed()
    desktop.send({ t: 'join', room: desktop.identity.id })
    expect(desktop.last()).toEqual({ t: 'joined', room: desktop.identity.id, peers: [] })
    phone.send({ t: 'join', room: desktop.identity.id })
    expect(phone.last()).toEqual({ t: 'joined', room: desktop.identity.id, peers: [desktop.identity.id] })
    expect(desktop.last()).toEqual({ t: 'peer', room: desktop.identity.id, id: phone.identity.id, online: true })

    phone.send({ t: 'to', room: desktop.identity.id, to: desktop.identity.id, body: { k: 'hs', e: E }, ref: 'r1' })
    expect(desktop.last()).toEqual({ t: 'from', room: desktop.identity.id, from: phone.identity.id, body: { k: 'hs', e: E } })
    desktop.send({ t: 'to', room: desktop.identity.id, to: phone.identity.id, body: { k: 'enc', c: 'abc' } })
    expect(phone.last()).toEqual({ t: 'from', room: desktop.identity.id, from: desktop.identity.id, body: { k: 'enc', c: 'abc' } })

    h.core.disconnect(phone.peer)
    expect(desktop.last()).toEqual({ t: 'peer', room: desktop.identity.id, id: phone.identity.id, online: false })
    expect(h.core.peersIn(desktop.identity.id)).toEqual([desktop.identity.id])
  })

  it('answers offline when the recipient is not in the room, and not-joined when the sender is not', () => {
    const h = harness()
    const desktop = h.authed()
    const phone = h.authed()
    const room = desktop.identity.id
    phone.send({ t: 'to', room, to: desktop.identity.id, body: { k: 'enc', c: 'abc' }, ref: 'x' })
    expect(phone.last()).toEqual({ t: 'error', code: 'not-joined', message: 'join the room first', ref: 'x' })
    phone.send({ t: 'join', room })
    phone.send({ t: 'to', room, to: desktop.identity.id, body: { k: 'enc', c: 'abc' }, ref: 'y' })
    expect(phone.last()).toMatchObject({ t: 'error', code: 'offline', ref: 'y' })
  })

  it('reaches every connection of the same identity (two tabs) and counts presence once', () => {
    const h = harness()
    const desktop = h.authed()
    const phoneId = generateIdentity()
    const tabA = h.authed(phoneId)
    const tabB = h.authed(phoneId)
    const room = desktop.identity.id
    desktop.send({ t: 'join', room })
    tabA.send({ t: 'join', room })
    tabB.send({ t: 'join', room })
    expect(desktop.sent.filter((m) => m.t === 'peer')).toHaveLength(1)
    desktop.send({ t: 'to', room, to: phoneId.id, body: { k: 'enc', c: 'hi' } })
    expect(tabA.last()).toMatchObject({ t: 'from', body: { k: 'enc', c: 'hi' } })
    expect(tabB.last()).toMatchObject({ t: 'from', body: { k: 'enc', c: 'hi' } })
    h.core.disconnect(tabA.peer)
    expect(desktop.sent.filter((m) => m.t === 'peer' && !m.online)).toHaveLength(0)
    h.core.disconnect(tabB.peer)
    expect(desktop.sent.filter((m) => m.t === 'peer' && !m.online)).toHaveLength(1)
  })

  it('caps a room, connections per address and frame size', () => {
    const h = harness({ limits: { maxPeersPerRoom: 3, maxPeersPerAddress: 3, maxFrameBytes: 600 } })
    const desktop = h.authed(undefined, '10.0.0.1')
    const room = desktop.identity.id
    desktop.send({ t: 'join', room })
    const a = h.authed(undefined, '10.0.0.2')
    const b = h.authed(undefined, '10.0.0.3')
    const c = h.authed(undefined, '10.0.0.4')
    a.send({ t: 'join', room })
    b.send({ t: 'join', room })
    expect(b.last()).toMatchObject({ t: 'joined' })
    c.send({ t: 'join', room })
    expect(c.last()).toMatchObject({ t: 'error', code: 'rate-limited', message: 'the room is full' })
    // The owner always gets in, even to a full room.
    const desktop2 = h.authed(desktop.identity, '10.0.0.5')
    desktop2.send({ t: 'join', room })
    expect(desktop2.last()).toMatchObject({ t: 'joined' })

    h.authed(undefined, '10.0.0.9')
    h.authed(undefined, '10.0.0.9')
    h.authed(undefined, '10.0.0.9')
    const extra = fakeSocket()
    expect(h.core.connect(extra.socket, '10.0.0.9')).toBeNull()
    expect(extra.closed).toEqual([[1008, 'too many connections']])

    h.core.receive(desktop.peer, 'x'.repeat(601))
    expect(desktop.last()).toMatchObject({ t: 'error', code: 'too-large' })
  })

  it('rate-limits a flood and refills with time', () => {
    const h = harness({ limits: { messagesPerWindow: 5, windowMs: 1000 } })
    const c = h.authed()
    for (let i = 0; i < 4; i++) c.send({ t: 'ping' })
    expect(c.sent.filter((m) => m.t === 'pong')).toHaveLength(4)
    c.send({ t: 'ping' })
    expect(c.last()).toMatchObject({ t: 'error', code: 'rate-limited' })
    h.advance(400)
    c.send({ t: 'ping' })
    expect(c.last()).toMatchObject({ t: 'pong' })
  })
})

describe('RelayCore push', () => {
  function pushHarness() {
    const sent: [string, string][] = []
    let fail: 'gone' | 'other' | null = null
    const push: PushProvider = {
      publicKey: 'VAPID',
      send: async (sub, payload) => {
        if (fail) {
          const err = new Error('nope') as Error & { gone?: boolean }
          err.gone = fail === 'gone'
          throw err
        }
        sent.push([sub.endpoint, payload])
      }
    }
    const store = new MemoryPushStore()
    const h = harness({ push, pushStore: store })
    return { ...h, sent, store, setFail: (f: typeof fail) => void (fail = f) }
  }
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } }
  const box = { e: E, c: 'cipher' }

  it('lets a desktop push a sealed box to a device that joined its room, even after it disconnects', async () => {
    const h = pushHarness()
    const desktop = h.authed()
    const phone = h.authed()
    const room = desktop.identity.id
    desktop.send({ t: 'join', room })
    phone.send({ t: 'join', room })
    phone.send({ t: 'push.subscribe', sub })
    expect(h.store.get(phone.identity.id)).toMatchObject({ sub, rooms: [room] })
    h.core.disconnect(phone.peer)
    desktop.send({ t: 'push', room, to: phone.identity.id, box })
    await vi.waitFor(() => expect(h.sent).toEqual([[sub.endpoint, JSON.stringify({ box })]]))
    expect(desktop.sent.filter((m) => m.t === 'error')).toEqual([])
  })

  it('refuses a push from someone who is not the room owner, or to a device that never joined', async () => {
    const h = pushHarness()
    const desktop = h.authed()
    const other = h.authed()
    const phone = h.authed()
    phone.send({ t: 'join', room: other.identity.id })
    phone.send({ t: 'push.subscribe', sub })
    other.send({ t: 'push', room: desktop.identity.id, to: phone.identity.id, box })
    expect(other.last()).toMatchObject({ t: 'error', code: 'not-joined' })
    desktop.send({ t: 'push', room: desktop.identity.id, to: phone.identity.id, box })
    expect(desktop.last()).toMatchObject({ t: 'error', code: 'offline' })
    expect(h.sent).toEqual([])
  })

  it('drops a subscription the push service says is gone, and reports other failures', async () => {
    const h = pushHarness()
    const desktop = h.authed()
    const phone = h.authed()
    const room = desktop.identity.id
    phone.send({ t: 'join', room })
    phone.send({ t: 'push.subscribe', sub })
    h.setFail('other')
    desktop.send({ t: 'push', room, to: phone.identity.id, box })
    await vi.waitFor(() => expect(desktop.last()).toMatchObject({ t: 'error', code: 'push-failed' }))
    expect(h.store.get(phone.identity.id)).toBeDefined()
    h.setFail('gone')
    desktop.send({ t: 'push', room, to: phone.identity.id, box })
    await vi.waitFor(() => expect(h.store.get(phone.identity.id)).toBeUndefined())
    phone.send({ t: 'push.unsubscribe' })
    expect(h.store.get(phone.identity.id)).toBeUndefined()
  })

  it('answers no-push when the relay has no VAPID keys', () => {
    const h = harness()
    const phone = h.authed()
    phone.send({ t: 'push.subscribe', sub })
    expect(phone.last()).toMatchObject({ t: 'error', code: 'no-push' })
  })
})
