import { describe, expect, it, vi } from 'vitest'
import { RelayCore, type Peer, type PushProvider, MemoryPushStore } from '@workhub/relay'
import { MAX_FRAME_BYTES } from '@workhub/protocol'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, RemoteService, type RemoteState } from '../src/main/remote'
import { buildHub } from '../src/shared/hub-client'
import { CONNECT_TIMEOUT_MS, HIDDEN_GRACE_MS, LIVENESS_MS, PONG_TIMEOUT_MS, RemoteClient, type ClientStorage, type ClientStatus } from '../src/web/remote-client'

const NOW = 1_800_000_000_000

/** A WebSocket wired to an in-process RelayCore; opens on the next tick like a real one. */
class FakeSocket {
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onclose: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  peer: Peer | null = null
  closed = false
  constructor(
    private readonly core: RelayCore,
    address: string
  ) {
    queueMicrotask(() => {
      this.peer = core.connect({ send: (text) => this.onmessage?.({ data: text }), close: (code, reason) => this.drop(code, reason) }, address)
      // The client answers the relay's challenge while connect() is still running: delivered now that the peer exists.
      for (const text of this.early.splice(0)) if (this.peer) this.core.receive(this.peer, text)
      this.onopen?.({})
    })
  }
  private readonly early: string[] = []
  send(text: string) {
    if (this.closed) return
    if (!this.peer) this.early.push(text)
    else this.core.receive(this.peer, text)
  }
  close(code = 1000, reason = '') {
    this.drop(code, reason)
  }
  /** The network went away (the relay closed us, or the phone lost signal). */
  drop(code: number, reason: string) {
    if (this.closed) return
    this.closed = true
    if (this.peer) this.core.disconnect(this.peer)
    this.onclose?.({ code, reason })
  }
}

/** A socket whose network died without a close event: nothing it sends arrives, nothing comes back. */
class SilentSocket {
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onclose: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  closed = false
  send() {}
  close() {
    this.closed = true
  }
}

class MemStorage implements ClientStorage {
  readonly map = new Map<string, string>()
  keys() {
    return [...this.map.keys()]
  }
  get(key: string) {
    return this.map.get(key) ?? null
  }
  set(key: string, value: string) {
    this.map.set(key, value)
  }
  remove(key: string) {
    this.map.delete(key)
  }
}

function timers() {
  const list: { fn: () => void; ms: number; cancelled: boolean }[] = []
  return {
    list,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false }
      list.push(t)
      return () => void (t.cancelled = true)
    },
    fire: () => {
      for (const t of list.splice(0)) if (!t.cancelled) t.fn()
    }
  }
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A desktop on its own relay, or on `shared` (a second desktop a phone reaches through the same relay). */
function desktop(initial: Partial<RemoteState> = {}, shared?: RelayCore) {
  const pushed: [string, string][] = []
  const push: PushProvider = { publicKey: 'VAPID-PUBLIC', send: async (sub, payload) => void pushed.push([sub.endpoint, payload]) }
  const core = shared ?? new RelayCore({ push, pushStore: new MemoryPushStore(), now: () => NOW })
  const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as IpcRegistrar)
  const views = [{ id: 's1', name: 'Fix tests', cwd: '/work/api' }]
  ipc.handle('sessions:list', () => views)
  ipc.handle('codeHost:lists', () => ({ mine: [], toReview: [] }))
  ipc.handle('remote:history', (_e: unknown, id: string, before?: number) => ({ messages: [{ kind: 'agent', text: `${id} before ${before ?? 'end'}` }], start: before === undefined ? 5 : before - 1, total: 6 }))
  const permissions: unknown[][] = []
  ipc.on('sessions:permission', (_e: unknown, ...args: unknown[]) => void permissions.push(args))
  const hub = new RemoteHub({ handlers, profileFolders: async () => ['/work/api'] })
  const t = timers()
  const service = new RemoteService({
    store: { load: (fallback) => ({ ...fallback, enabled: true, relayUrl: 'https://relay.example.com', desktopName: 'Ana’s MacBook', ...initial }), save: () => {} },
    secrets: { get: async () => null, set: async () => {} },
    hub,
    connect: () => new FakeSocket(core, '10.0.0.1'),
    defaultName: () => 'desk',
    onChanged: () => {},
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => NOW,
    schedule: t.schedule
  })
  return { core, service, hub, pushed, permissions, views, timers: t }
}

/** `clock.now` moves the phone's time; `silent` sockets are handed out first, as if the network were dead. */
function phone(core: RelayCore, storage = new MemStorage(), clock = { now: NOW }, silent = 0) {
  const t = timers()
  const sockets: (FakeSocket | SilentSocket)[] = []
  const statuses: ClientStatus[] = []
  const client = new RemoteClient({
    storage,
    connect: () => {
      const s = sockets.length < silent ? new SilentSocket() : new FakeSocket(core, '10.0.0.2')
      sockets.push(s)
      return s
    },
    deviceName: () => 'Ana’s phone',
    platform: () => 'ios',
    now: () => clock.now,
    schedule: t.schedule,
    log: { warn: vi.fn() }
  })
  client.onStatus((s) => statuses.push(s))
  return { client, storage, sockets, statuses, timers: t, hub: buildHub(client.transport, 'mac') }
}

/** The page was hidden long enough to let its socket go (or it was closed). */
function hideForGood(p: ReturnType<typeof phone>) {
  p.client.suspend()
  for (const t of p.timers.list.filter((t) => t.ms === HIDDEN_GRACE_MS && !t.cancelled)) t.fn()
}

/** Pairs a fresh phone with the desktop and brings the channel up. */
async function paired(capabilities: Parameters<RemoteService['acceptPairing']>[1] = ['sessions', 'health']) {
  const d = desktop()
  await d.service.start()
  await settle()
  const link = (await d.service.startPairing()).pairing!.link
  const p = phone(d.core)
  expect(p.client.openPairingLink(link)).toBe(true)
  p.client.pair()
  await settle()
  const request = d.service.status().request!
  expect(request.deviceId).toBe(p.client.identity.id)
  d.service.acceptPairing(request.deviceId, capabilities)
  await settle(6)
  expect(p.client.status().state).toBe('online')
  return { d, p }
}

describe('RemoteClient', () => {
  it('starts unpaired with a fresh identity it keeps across loads', () => {
    const storage = new MemStorage()
    const a = phone(new RelayCore({ now: () => NOW }), storage)
    expect(a.client.status()).toMatchObject({ state: 'unpaired', desktop: null, offer: null })
    expect(a.client.status().fingerprint).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
    const b = phone(new RelayCore({ now: () => NOW }), storage)
    expect(b.client.identity.id).toBe(a.client.identity.id)
  })

  it('reads a pairing link, shows the desktop to confirm, and refuses expired or foreign links', () => {
    const p = phone(new RelayCore({ now: () => NOW }))
    expect(p.client.openPairingLink('https://relay.example.com/#nothing')).toBe(false)
    const d = desktop()
    const stale = new RemoteService({
      store: { load: (f) => ({ ...f, enabled: true, relayUrl: 'https://relay.example.com', desktopName: 'Old' }), save: () => {} },
      secrets: { get: async () => null, set: async () => {} },
      hub: d.hub,
      connect: () => new FakeSocket(d.core, '10.0.0.3'),
      defaultName: () => 'desk',
      onChanged: () => {},
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW - 10 * 60_000,
      schedule: () => () => {}
    })
    return (async () => {
      await stale.start()
      await settle()
      const link = (await stale.startPairing()).pairing!.link
      expect(p.client.openPairingLink(link)).toBe(false)
      expect(p.client.status().error).toBe('expired')
    })()
  })

  it('pairs through the QR link, then calls hub methods over the encrypted channel', async () => {
    const { d, p } = await paired()
    expect(p.client.status().desktop).toMatchObject({ name: 'Ana’s MacBook', capabilities: ['sessions', 'health'], relay: 'wss://relay.example.com/ws' })
    expect(p.client.status().vapidPublicKey).toBe('VAPID-PUBLIC')
    expect(d.service.status().devices[0]).toMatchObject({ id: p.client.identity.id, online: true, name: 'Ana’s phone', platform: 'ios' })

    await expect(p.hub.sessions.list()).resolves.toEqual(d.views)
    // The answer stays on the phone for the next time it is offline.
    expect(p.client.cached('sessions:list')).toEqual(d.views)
    // Not granted: refused by the desktop, with the reason.
    await expect(p.hub.codeHost.lists(null)).rejects.toThrow(/not available remotely/)

    // One-way messages and events travel too.
    const seen: unknown[] = []
    p.hub.sessions.onChanged((v) => seen.push(v))
    p.hub.sessions.respondPermission('s1', 'r1', 'allow')
    d.hub.tap('session:changed', [{ id: 's1', state: 'busy' }])
    await settle()
    expect(d.permissions).toEqual([['s1', 'r1', 'allow', null]])
    expect(seen).toEqual([{ id: 's1', state: 'busy' }])
  })

  it('shows notifications over the channel while online, and by push once the page is hidden', async () => {
    const { d, p } = await paired()
    const notes: unknown[] = []
    p.client.transport.subscribe('remote:notification', (n) => notes.push(n))
    p.client.setPushSubscription({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) } })
    await settle()
    d.service.notify({ kind: 'replied', title: 'Fix tests', body: 'Done', at: NOW, sessionId: 's1' })
    await settle()
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'replied', route: '#session/s1' })
    expect(d.pushed).toHaveLength(0)

    // Hidden: the socket stays for a quick return, but the desktop already pushes instead.
    p.client.suspend()
    await settle()
    expect(p.client.status().state).toBe('online')
    d.service.notify({ kind: 'needsAnswer', title: 'Permission', body: 'npm test', at: NOW, sessionId: 's1' })
    await settle()
    expect(notes).toHaveLength(1)
    expect(d.pushed).toHaveLength(1)
    expect(d.pushed[0]![0]).toBe('https://push.example.com/abc')
    expect(JSON.parse(d.pushed[0]![1])).toHaveProperty('box.c')

    // Back within the grace period: no reconnect, and notifications use the socket again.
    p.client.start()
    await settle()
    expect(p.sockets).toHaveLength(1)
    d.service.notify({ kind: 'replied', title: 'Fix tests', body: 'Again', at: NOW, sessionId: 's1' })
    await settle()
    expect(notes).toHaveLength(2)
    expect(d.pushed).toHaveLength(1)

    // Hidden past the grace period: the socket goes.
    p.client.suspend()
    for (const t of p.timers.list.filter((t) => t.ms === HIDDEN_GRACE_MS && !t.cancelled)) t.fn()
    await settle()
    expect(p.client.status().state).toBe('desktop-offline')
    expect(d.service.status().devices[0]!.online).toBe(false)
    d.service.notify({ kind: 'needsAnswer', title: 'Permission', body: 'npm test', at: NOW, sessionId: 's1' })
    await settle()
    expect(d.pushed).toHaveLength(2)

    // Back in front: reconnects with the identity it has, no pairing.
    p.client.start()
    await settle(6)
    expect(p.client.status().state).toBe('online')
  })

  it('answers from the cache while the desktop is away and reconnects on its own', async () => {
    const { p } = await paired()
    await p.hub.sessions.list()
    ;(p.sockets.at(-1) as FakeSocket).drop(1006, '')
    await settle()
    expect(p.client.status().state).toBe('desktop-offline')
    await expect(p.hub.sessions.list()).resolves.toEqual([{ id: 's1', name: 'Fix tests', cwd: '/work/api' }])
    await expect(p.hub.codeHost.lists(null)).rejects.toThrow('offline')
    expect(p.timers.list.some((t) => !t.cancelled)).toBe(true)
    p.timers.fire()
    await settle(6)
    expect(p.client.status().state).toBe('online')
    expect(p.sockets).toHaveLength(2)
  })

  it('keeps only the last page of a chat for offline use, and forgets it once the chat closes', async () => {
    const { d, p } = await paired()
    const history = (...args: unknown[]) => p.client.transport.invoke('remote:history', ...args)
    await expect(history('s1')).resolves.toMatchObject({ start: 5, messages: [{ text: 's1 before end' }] })
    await expect(history('s1', 5)).resolves.toMatchObject({ start: 4 })
    ;(p.sockets.at(-1) as FakeSocket).drop(1006, '')
    await settle()
    await expect(history('s1')).resolves.toMatchObject({ start: 5 })
    await expect(history('s1', 5)).rejects.toThrow('offline')

    p.timers.fire()
    await settle(6)
    d.views.splice(0)
    await p.hub.sessions.list()
    expect([...p.storage.map.keys()].some((k) => k.includes('remote:history'))).toBe(false)
  })

  it('reconnects a phone that was paired before, from what it stored', async () => {
    const { d, p } = await paired()
    hideForGood(p)
    await settle()
    const again = phone(d.core, p.storage)
    again.client.start()
    await settle(6)
    expect(again.client.status().state).toBe('online')
    await expect(again.hub.sessions.list()).resolves.toHaveLength(1)
  })

  it('applies new capabilities after the desktop changes them', async () => {
    const { d, p } = await paired(['sessions'])
    expect(p.client.capabilities()).toEqual(['sessions'])
    d.service.setCapabilities(p.client.identity.id, ['sessions', 'pullRequests'])
    await settle(8)
    expect(p.client.status().state).toBe('online')
    expect(p.client.capabilities()).toEqual(['sessions', 'pullRequests'])
    await expect(p.hub.codeHost.lists(null)).resolves.toEqual({ mine: [], toReview: [] })
  })

  it('forgets the desktop and its cache when revoked, and when the person unpairs', async () => {
    const { d, p } = await paired()
    await p.hub.sessions.list()
    d.service.revoke(p.client.identity.id)
    await settle()
    expect(p.client.status()).toMatchObject({ state: 'revoked', desktop: null })
    expect(p.client.cached('sessions:list')).toBeNull()
    expect(JSON.parse(p.storage.get('workhub-remote')!).desktops).toEqual({})
    // No reconnect attempts without a desktop.
    p.timers.fire()
    await settle()
    expect(p.sockets).toHaveLength(1)

    const { d: desk, p: other } = await paired(['sessions', 'pullRequests'])
    await other.hub.sessions.list()
    await other.hub.codeHost.lists('p1')
    expect([...other.storage.map.keys()].filter((k) => k.startsWith('workhub-remote-cache:'))).toHaveLength(2)
    expect(desk.service.status().devices).toHaveLength(1)
    other.client.unpair()
    await settle()
    expect(other.client.status()).toMatchObject({ state: 'unpaired', desktop: null })
    // Every cached answer went, the keyed ones too; and the desktop dropped the phone as well.
    expect([...other.storage.map.keys()].filter((k) => k.startsWith('workhub-remote-cache:'))).toEqual([])
    expect(desk.service.status().devices).toEqual([])
  })

  it('tells the person which relay a pairing link points at', async () => {
    const d = desktop()
    await d.service.start()
    await settle()
    const link = (await d.service.startPairing()).pairing!.link
    const p = phone(d.core)
    expect(p.client.openPairingLink(link)).toBe(true)
    expect(p.client.status().offer).toMatchObject({ desktopName: 'Ana’s MacBook', relay: 'wss://relay.example.com/ws' })
  })

  it('pairs with a second desktop, switches between them with separate caches, and keeps the other when one revokes', async () => {
    const { d: home, p } = await paired()
    await p.hub.sessions.list()
    const homeId = p.client.status().desktop!.id

    // A second desktop, reached through the same relay in this test: pairing makes it the active one.
    const work = desktop({ desktopName: 'Work PC' }, home.core)
    work.views[0] = { id: 'w1', name: 'Deploy', cwd: '/work/web' }
    await work.service.start()
    await settle()
    const link = (await work.service.startPairing()).pairing!.link
    expect(p.client.openPairingLink(link)).toBe(true)
    p.client.pair()
    await settle()
    work.service.acceptPairing(work.service.status().request!.deviceId, ['sessions'])
    await settle(6)
    const status = p.client.status()
    expect(status.state).toBe('online')
    expect(status.desktop?.name).toBe('Work PC')
    expect(status.desktops.map((x) => x.name)).toEqual(['Ana’s MacBook', 'Work PC'])
    expect(p.client.capabilities()).toEqual(['sessions'])
    // The caches are per desktop: nothing from home shows for work until work answers.
    expect(p.client.cached('sessions:list')).toBeNull()
    expect(await p.hub.sessions.list()).toMatchObject([{ id: 'w1' }])

    // Back to home: its cache is still there, and the connection follows.
    expect(p.client.switchDesktop(homeId)).toBe(true)
    expect(p.client.cached('sessions:list')).toMatchObject([{ id: 's1' }])
    await settle(6)
    expect(p.client.status()).toMatchObject({ state: 'online', desktop: { id: homeId } })

    // Home revokes the phone: the phone moves on to work instead of ending up unpaired.
    home.service.revoke(p.client.identity.id)
    await settle(6)
    expect(p.client.status()).toMatchObject({ state: 'online', desktop: { name: 'Work PC' } })
    expect(p.client.desktops()).toHaveLength(1)
    expect(p.client.switchDesktop('nope')).toBe(false)
  })

  it('moves the single desktop of the first version into the list', async () => {
    const { p } = await paired()
    const saved = JSON.parse(p.storage.get('workhub-remote')!)
    const old = new MemStorage()
    old.set('workhub-remote', JSON.stringify({ seed: saved.seed, desktop: saved.desktops[saved.active] }))
    const { d } = await paired()
    const again = phone(d.core, old)
    expect(again.client.status()).toMatchObject({ state: 'connecting', desktop: { name: 'Ana’s MacBook' } })
    expect(again.client.desktops()).toHaveLength(1)
  })

  it('drops a connection stuck before the desktop answers and connects again', async () => {
    const { d, p } = await paired()
    hideForGood(p)
    // Back in front, but the first socket never hears from the relay (a dead network, no close event).
    const again = phone(d.core, p.storage, { now: NOW }, 1)
    again.client.start()
    await settle(6)
    expect(again.client.status().state).toBe('connecting')
    const watchdog = again.timers.list.find((t) => t.ms === CONNECT_TIMEOUT_MS && !t.cancelled)!
    watchdog.fn()
    expect((again.sockets[0] as SilentSocket).closed).toBe(true)
    expect(again.client.status()).toMatchObject({ state: 'desktop-offline', error: 'timed out connecting' })
    again.timers.fire()
    await settle(6)
    expect(again.client.status().state).toBe('online')
    expect(again.sockets).toHaveLength(2)
    // Online, the watchdog of the working socket does nothing.
    for (const t of again.timers.list.filter((t) => t.ms === CONNECT_TIMEOUT_MS && !t.cancelled)) t.fn()
    expect(again.client.status().state).toBe('online')
  })

  it('pings the relay while online and reconnects when the socket goes silent', async () => {
    const { d, p } = await paired()
    hideForGood(p)
    const clock = { now: NOW }
    const again = phone(d.core, p.storage, clock)
    again.client.start()
    await settle(6)
    expect(again.client.status().state).toBe('online')
    const run = (ms: number) => {
      const due = again.timers.list.filter((t) => t.ms === ms && !t.cancelled)
      again.timers.list.splice(0, again.timers.list.length, ...again.timers.list.filter((t) => !due.includes(t)))
      for (const t of due) t.fn()
    }

    // A live socket answers the ping before the deadline: still online.
    clock.now += LIVENESS_MS
    run(LIVENESS_MS)
    await settle()
    clock.now += PONG_TIMEOUT_MS
    run(PONG_TIMEOUT_MS)
    expect(again.client.status().state).toBe('online')

    // The network dies without a close event: the next ping goes unanswered and the phone notices.
    const socket = again.sockets[0] as FakeSocket
    socket.onmessage = null
    clock.now += LIVENESS_MS
    run(LIVENESS_MS)
    await settle()
    expect(again.client.status().state).toBe('online')
    clock.now += PONG_TIMEOUT_MS
    run(PONG_TIMEOUT_MS)
    expect(socket.closed).toBe(true)
    expect(again.client.status()).toMatchObject({ state: 'desktop-offline', error: 'no answer from the relay' })
    again.timers.fire()
    await settle(6)
    expect(again.client.status().state).toBe('online')
  })

  it('checks the socket when the page comes back, and retries at once instead of after the backoff', async () => {
    const { d, p } = await paired()
    hideForGood(p)
    const clock = { now: NOW }
    const again = phone(d.core, p.storage, clock)
    again.client.start()
    await settle(6)
    // The phone froze the page with the socket open; it went silent meanwhile.
    const socket = again.sockets[0] as FakeSocket
    socket.onmessage = null
    clock.now += LIVENESS_MS + 1
    again.client.start()
    expect(socket.closed).toBe(true)
    expect(again.client.status().state).toBe('desktop-offline')
    // Coming back again does not wait for the scheduled retry.
    again.client.start()
    await settle(6)
    expect(again.client.status().state).toBe('online')
    expect(again.sockets).toHaveLength(2)
  })

  it('drops the socket at once when hidden if the desktop does not understand away', async () => {
    const { d, p } = await paired()
    // A desktop from before `away` sends no features in its ready.
    ;(p.client as unknown as { desktopTakesAway: boolean }).desktopTakesAway = false
    p.client.suspend()
    await settle()
    expect(p.client.status().state).toBe('desktop-offline')
    expect(d.service.status().devices[0]!.online).toBe(false)
  })

  it('answers an oversized result with an error instead of sending a frame the relay would close the socket over', async () => {
    const { d, p } = await paired()
    const frames: number[] = []
    const receive = d.core.receive.bind(d.core)
    d.core.receive = (peer, raw) => {
      frames.push(typeof raw === 'string' ? raw.length : raw.byteLength)
      receive(peer, raw)
    }
    d.views.push({ id: 'big', name: 'x'.repeat(600_000), cwd: '/work/api' })
    await expect(p.hub.sessions.list()).rejects.toThrow('too large')
    expect(Math.max(...frames)).toBeLessThan(MAX_FRAME_BYTES)
    // The channel stays in step: the next answer opens fine.
    d.views.pop()
    await expect(p.hub.sessions.list()).resolves.toHaveLength(1)
    expect(p.client.status().state).toBe('online')
  })

  it('refuses a call too large to send instead of losing the connection', async () => {
    const { p } = await paired()
    await expect(p.client.transport.invoke('sessions:list', 'x'.repeat(600_000))).rejects.toThrow('too large')
    await expect(p.hub.sessions.list()).resolves.toHaveLength(1)
  })
})
