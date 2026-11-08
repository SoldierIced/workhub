import { describe, expect, it, vi } from 'vitest'
import { generateIdentity, makeAuth, type RelayMessage } from '@workhub/protocol'
import { MemoryPushStore, RelayCore, type PushProvider, type PushRecord, type PushStore, type Socket } from '../src/core'

const NOW = 1_800_000_000_000
const E = 'A'.repeat(43)

function fakeSocket() {
  const sent: RelayMessage[] = []
  const closed: [number, string][] = []
  let buffered = 0
  const socket: Socket = { send: (text) => void sent.push(JSON.parse(text)), close: (code, reason) => void closed.push([code, reason]), buffered: () => buffered }
  return { socket, sent, closed, setBuffered: (n: number) => void (buffered = n) }
}

/** The nonce the relay sent this connection first. */
function nonceOf(sent: RelayMessage[]): string {
  const first = sent[0]
  if (first?.t !== 'challenge') throw new Error('no challenge')
  return first.nonce
}

function harness(options: { push?: PushProvider; pushStore?: PushStore; limits?: Partial<import('../src/core').RelayLimits> } = {}) {
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
    c.send(makeAuth(identity, nonceOf(c.sent), now))
    return { ...c, identity }
  }
  return { core, join, authed, advance: (ms: number) => void (now += ms), log }
}

describe('RelayCore auth', () => {
  it('sends a challenge first, welcomes an auth signed over it and closes anything else before auth', () => {
    const h = harness()
    const c = h.join()
    expect(c.sent[0]).toMatchObject({ t: 'challenge' })
    c.send({ t: 'join', room: 'a'.repeat(32) })
    expect(c.last()).toMatchObject({ t: 'error', code: 'unauthenticated' })
    expect(c.closed).toEqual([[1008, 'auth first']])
    const d = h.join()
    const me = generateIdentity()
    d.send(makeAuth(me, nonceOf(d.sent), NOW))
    expect(d.last()).toEqual({ t: 'welcome', id: me.id, now: NOW })
    expect(h.core.isAuthenticated(d.peer)).toBe(true)
  })

  it('refuses an auth captured on another connection (the nonce differs)', () => {
    const h = harness()
    const me = generateIdentity()
    const a = h.join()
    const auth = makeAuth(me, nonceOf(a.sent), NOW)
    const b = h.join()
    b.send(auth)
    expect(b.last()).toMatchObject({ t: 'error', code: 'bad-auth', message: 'auth refused: nonce' })
    expect(b.closed).toEqual([[1008, 'bad auth']])
    a.send(auth)
    expect(a.last()).toMatchObject({ t: 'welcome', id: me.id })
  })

  it('closes a forged or stale auth, and junk frames before auth', () => {
    const h = harness()
    const c = h.join()
    c.send({ ...makeAuth(generateIdentity(), nonceOf(c.sent), NOW), id: generateIdentity().id })
    expect(c.last()).toMatchObject({ t: 'error', code: 'bad-auth' })
    expect(c.closed).toEqual([[1008, 'bad auth']])
    const d = h.join()
    h.core.receive(d.peer, 'not json')
    expect(d.last()).toMatchObject({ t: 'error', code: 'bad-message' })
    expect(d.closed).toEqual([[1008, 'bad message']])
    const e = h.join()
    e.send({ t: 'nope' })
    expect(e.last()).toMatchObject({ t: 'error', code: 'bad-message' })
    expect(e.closed).toEqual([[1008, 'bad message']])
    // Authenticated peers only get an error for junk.
    const f = h.authed()
    f.send({ t: 'nope' })
    expect(f.last()).toMatchObject({ t: 'error', code: 'bad-message' })
    expect(f.closed).toEqual([])
  })

  it('caps the connections one identity holds', () => {
    const h = harness({ limits: { maxPeersPerId: 2 } })
    const me = generateIdentity()
    h.authed(me, '10.0.0.1')
    h.authed(me, '10.0.0.2')
    const third = h.authed(me, '10.0.0.3')
    expect(third.last()).toMatchObject({ t: 'error', code: 'rate-limited' })
    expect(third.closed).toEqual([[1008, 'too many connections']])
    expect(h.core.isAuthenticated(third.peer)).toBe(false)
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
    // Measured in bytes, not characters.
    h.core.receive(desktop.peer, '€'.repeat(201))
    expect(desktop.last()).toMatchObject({ t: 'error', code: 'too-large' })
  })

  it('caps the rooms a peer listens in, and the relay as a whole', () => {
    const h = harness({ limits: { maxRoomsPerPeer: 2, maxPeers: 3 } })
    const c = h.authed()
    c.send({ t: 'join', room: 'a'.repeat(32) })
    c.send({ t: 'join', room: 'b'.repeat(32) })
    expect(c.last()).toMatchObject({ t: 'joined' })
    c.send({ t: 'join', room: 'c'.repeat(32) })
    expect(c.last()).toMatchObject({ t: 'error', code: 'rate-limited', message: 'too many rooms' })
    h.join('10.0.0.2')
    h.join('10.0.0.3')
    const extra = fakeSocket()
    expect(h.core.connect(extra.socket, '10.0.0.4')).toBeNull()
    expect(extra.closed).toEqual([[1008, 'too many connections']])
  })

  it('drops a peer that stops reading instead of buffering for it', () => {
    const h = harness({ limits: { maxBufferedBytes: 1000 } })
    const desktop = h.authed()
    const phone = h.authed()
    const room = desktop.identity.id
    desktop.send({ t: 'join', room })
    phone.send({ t: 'join', room })
    phone.setBuffered(5000)
    const before = phone.sent.length
    desktop.send({ t: 'to', room, to: phone.identity.id, body: { k: 'enc', c: 'abc' } })
    expect(phone.sent.length).toBe(before)
    expect(phone.closed).toEqual([[1008, 'not reading']])
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
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) } }
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

  it('refuses an endpoint the provider does not know, and caps the records and the pushes in flight', async () => {
    const push: PushProvider = { publicKey: 'VAPID', send: () => new Promise(() => {}), allows: (endpoint) => endpoint.startsWith('https://push.example.com/') }
    const store = new MemoryPushStore()
    const h = harness({ push, pushStore: store, limits: { maxPushRecords: 1, maxPushesInFlight: 1 } })
    const desktop = h.authed()
    const room = desktop.identity.id
    desktop.send({ t: 'join', room })
    const phone = h.authed()
    phone.send({ t: 'join', room })
    phone.send({ t: 'push.subscribe', sub: { ...sub, endpoint: 'https://10.0.0.5/internal' } })
    expect(phone.last()).toMatchObject({ t: 'error', code: 'bad-message' })
    expect(store.size()).toBe(0)
    phone.send({ t: 'push.subscribe', sub })
    expect(store.size()).toBe(1)
    const second = h.authed()
    second.send({ t: 'join', room })
    second.send({ t: 'push.subscribe', sub })
    expect(second.last()).toMatchObject({ t: 'error', code: 'rate-limited' })
    expect(store.size()).toBe(1)
    desktop.send({ t: 'push', room, to: phone.identity.id, box })
    desktop.send({ t: 'push', room, to: phone.identity.id, box })
    expect(desktop.last()).toMatchObject({ t: 'error', code: 'rate-limited' })
  })

  it('keeps running when the store cannot write', () => {
    const store: PushStore = {
      get: () => undefined,
      set: () => {
        throw new Error('disk full')
      },
      delete: () => {
        throw new Error('disk full')
      }
    }
    const h = harness({ push: { publicKey: 'VAPID', send: async () => {} }, pushStore: store })
    const phone = h.authed()
    expect(() => phone.send({ t: 'push.subscribe', sub })).not.toThrow()
    expect(() => phone.send({ t: 'push.unsubscribe' })).not.toThrow()
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('push store write failed'))
    expect(phone.closed).toEqual([])
  })
})
