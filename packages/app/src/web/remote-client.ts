// The phone's side of Workhub Remote: its identity, the desktop it is paired with, the relay
// connection, the encrypted channel, and a HubTransport over it so the same `hub` the desktop
// renderer uses works here. No DOM: the socket, storage and timers are given, so it is tested
// end to end against the desktop service and the relay in one process.
import {
  answerPairingOffer,
  decodeJson,
  encodeJson,
  decrypt,
  deriveKey,
  encrypt,
  fingerprintOf,
  fromBase64Url,
  generateSeed,
  identityFromSeed,
  makeAuth,
  offerFromLink,
  openBox,
  parseChannelMessage,
  parseRelayMessage,
  reconnectDelayMs,
  sealBox,
  startHandshake,
  toBase64Url,
  verifyPairAccept,
  displayFingerprint,
  type ChannelMessage,
  type Identity,
  type PairingOffer,
  type PublicIdentity,
  type RelayMessage,
  type SecureChannel,
  fitsFrame
} from '@workhub/protocol'
import type { HubTransport } from '../shared/hub-client'
import type { RemoteCapability } from '../shared/remote-api'

export interface ClientStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  /** Every key, when the store can list them (localStorage can): what clearing a desktop's cache needs. */
  keys?(): string[]
}

export interface WebSocketLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: any) => void) | null
  onclose: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
}

export interface PairedDesktop {
  id: string
  public: PublicIdentity
  name: string
  /** The relay's WebSocket URL. */
  relay: string
  capabilities: RemoteCapability[]
}

interface Persisted {
  seed: string
  /** The desktops this phone is paired with, by fingerprint; `active` is the one it talks to. */
  desktops: Record<string, PairedDesktop>
  active?: string
  /** The single desktop of the first version; read once and moved into `desktops`. */
  desktop?: PairedDesktop
}

export type ClientState =
  /** No desktop paired: open a pairing link. */
  | 'unpaired'
  /** A pairing link was opened; waiting for the person to confirm and the desktop to accept. */
  | 'pairing'
  | 'connecting'
  /** The desktop is not on the relay right now; what the phone shows is the last state it saw. */
  | 'desktop-offline'
  | 'online'
  /** The desktop revoked this device; it has to pair again. */
  | 'revoked'

export interface ClientStatus {
  state: ClientState
  /** The desktop the phone talks to now. */
  desktop: PairedDesktop | null
  /** Every paired desktop, the active one included, in pairing order. */
  desktops: PairedDesktop[]
  /** This device's fingerprint, as people compare it. */
  fingerprint: string
  /** An offer waiting for the person's confirmation; `relay` is the host the link points at. */
  offer: { desktopName: string; desktopFingerprint: string; relay: string } | null
  error?: string
  vapidPublicKey?: string
}

export interface RemoteClientDeps {
  storage: ClientStorage
  connect: (url: string) => WebSocketLike
  deviceName: () => string
  platform: () => 'ios' | 'android' | 'web' | 'other'
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  log?: { warn(line: string): void }
  /** How long a call waits for the desktop before failing (30 s by default). */
  invokeTimeoutMs?: number
}

const STATE_KEY = 'workhub-remote'
const CACHE_PREFIX = 'workhub-remote-cache:'
/** Twice the largest body the protocol allows, as UTF-16 code units. */
const MAX_RELAY_FRAME_CHARS = 2 * 1024 * 1024
/** How long a connection may stay in `connecting` (relay auth, handshake, `ready`) before it is dropped and retried. */
export const CONNECT_TIMEOUT_MS = 15_000
/** How long a hidden page keeps its socket: a glance at another app or the Control Center does not reconnect. */
export const HIDDEN_GRACE_MS = 30_000
/** How often an open socket is pinged. */
export const LIVENESS_MS = 20_000
/** How long a ping waits for any answer before the socket is treated as dead. */
export const PONG_TIMEOUT_MS = 10_000

/** Calls whose last answer the phone keeps, so it has something to show without network. */
export const CACHED_CHANNELS: ReadonlySet<string> = new Set(['remote:history', 'sessions:list', 'config:get', 'config:effectiveAgents', 'hub:profileFolders', 'agents:availability', 'codeHost:lists', 'metricAlerts:list', 'automations:get', 'health:get', 'plan:get', 'planner:get'])

export class RemoteClient {
  readonly identity: Identity
  readonly transport: HubTransport
  private persisted: Persisted
  private state: ClientState
  private error: string | undefined
  private vapidPublicKey: string | undefined
  private socket: WebSocketLike | null = null
  private channel: SecureChannel | null = null
  private pendingHandshake: ReturnType<typeof startHandshake> | null = null
  private ready = false
  /** The desktop understands `away`; an older one keeps sending notifications over the socket, so a hidden page drops it at once. */
  private desktopTakesAway = false
  private attempt = 0
  private cancelReconnect: (() => void) | null = null
  private cancelWatchdog: (() => void) | null = null
  private cancelGrace: (() => void) | null = null
  private cancelLiveness: (() => void) | null = null
  /** When the relay last sent anything on the current socket. */
  private lastHeard = 0
  private pendingOffer: PairingOffer | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; cancel: () => void }>()
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>()
  private readonly statusListeners = new Set<(status: ClientStatus) => void>()
  /** One cache key per desktop, derived from the seed; entries of one desktop never open as another's. */
  private readonly cacheKeys = new Map<string, Uint8Array>()
  private pushSubscription: unknown | null = null
  /** The page is in the background: no socket, so the desktop pushes notifications instead. */
  private suspended = false
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(private readonly deps: RemoteClientDeps) {
    this.now = deps.now ?? Date.now
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
    this.persisted = this.loadPersisted()
    this.identity = identityFromSeed(fromBase64Url(this.persisted.seed))
    this.state = this.desktop ? 'connecting' : 'unpaired'
    this.transport = {
      invoke: (channel, ...args) => this.invoke(channel, args),
      send: (channel, ...args) => this.sendMessage({ t: 'send', channel, args }),
      subscribe: (channel, cb) => {
        const set = this.listeners.get(channel) ?? new Set()
        set.add(cb as (...args: any[]) => void)
        this.listeners.set(channel, set)
        return () => void set.delete(cb as (...args: any[]) => void)
      }
    }
  }

  /** The desktop the phone talks to now. */
  private get desktop(): PairedDesktop | undefined {
    return this.persisted.active ? this.persisted.desktops[this.persisted.active] : undefined
  }

  /** Connects to the active desktop, if any. */
  start(): void {
    this.suspended = false
    this.cancelGrace?.()
    this.cancelGrace = null
    const desktop = this.desktop
    if (!desktop || this.state === 'pairing') return
    // The person is looking: retry now, not after the backoff a hidden or offline page built up.
    this.attempt = 0
    if (!this.socket) return this.connect(desktop.relay)
    if (this.ready && this.desktopTakesAway) this.sendMessage({ t: 'away', away: false })
    // A socket that survived a freeze may be dead without a close event (network changed, phone slept).
    if (this.lastHeard && this.now() - this.lastHeard > LIVENESS_MS) this.dropDead('no answer from the relay')
    else this.probe()
  }

  /** Every paired desktop, in pairing order. */
  desktops(): PairedDesktop[] {
    return Object.values(this.persisted.desktops)
  }

  /**
   * Talks to another paired desktop from now on. The caller reloads the page afterwards: the
   * renderer's store and `window.hub` were built for the previous one.
   */
  switchDesktop(id: string): boolean {
    if (!this.persisted.desktops[id] || id === this.persisted.active) return false
    this.disconnect()
    this.persisted.active = id
    this.savePersisted()
    this.error = undefined
    this.state = 'connecting'
    this.changed()
    if (!this.suspended) this.connect(this.desktop!.relay)
    return true
  }

  /**
   * The page is hidden. The desktop is told at once, so notifications go by push (a frozen page
   * would not show them); the socket stays for `HIDDEN_GRACE_MS` so a quick return (the Control
   * Center, another app for a moment) needs no reconnect, then it is dropped. `start()` resumes.
   */
  suspend(): void {
    if (this.state === 'pairing') return
    this.suspended = true
    if (this.ready && this.socket && this.desktopTakesAway) {
      this.sendMessage({ t: 'away', away: true })
      this.cancelGrace?.()
      this.cancelGrace = this.schedule(() => {
        this.cancelGrace = null
        if (this.suspended) this.goDormant()
      }, HIDDEN_GRACE_MS)
      return
    }
    this.goDormant()
  }

  /** No socket while hidden: the page shows what it cached until `start()`. */
  private goDormant(): void {
    this.disconnect()
    if (this.desktop && this.state !== 'revoked') {
      this.state = 'desktop-offline'
      this.error = undefined
      this.changed()
    }
  }

  status(): ClientStatus {
    const offer = this.pendingOffer
    return {
      state: this.state,
      desktop: this.desktop ?? null,
      desktops: this.desktops(),
      fingerprint: displayFingerprint(this.identity.id),
      offer: offer ? { desktopName: offer.name, desktopFingerprint: displayFingerprint(fingerprintOf(offer.desktop)), relay: offer.relay } : null,
      ...(this.error ? { error: this.error } : {}),
      ...(this.vapidPublicKey ? { vapidPublicKey: this.vapidPublicKey } : {})
    }
  }

  onStatus(cb: (status: ClientStatus) => void): () => void {
    this.statusListeners.add(cb)
    return () => void this.statusListeners.delete(cb)
  }

  /** The capabilities the desktop granted, as of the last `ready`. */
  capabilities(): RemoteCapability[] {
    return this.desktop?.capabilities ?? []
  }

  // ---- pairing

  /** Reads a pairing link; the person then sees the desktop's name and fingerprint and confirms with `pair()`. */
  openPairingLink(link: string): boolean {
    const offer = offerFromLink(link)
    if (!offer) return false
    if (offer.exp < this.now()) {
      this.error = 'expired'
      this.changed()
      return false
    }
    this.pendingOffer = offer
    this.error = undefined
    this.changed()
    return true
  }

  /** Confirms the pending offer: connects to its relay and sends the request; the desktop's accept completes it. */
  pair(): void {
    const offer = this.pendingOffer
    if (!offer) return
    this.disconnect()
    this.state = 'pairing'
    this.error = undefined
    this.changed()
    this.connect(offer.relay, offer)
  }

  cancelPairing(): void {
    this.pendingOffer = null
    if (this.state === 'pairing') {
      this.disconnect()
      this.state = this.desktop ? 'connecting' : 'unpaired'
      if (this.desktop) this.connect(this.desktop.relay)
    }
    this.changed()
  }

  /**
   * Forgets a desktop (the active one by default) and its cached state; the identity stays, so
   * pairing again is quick. Another paired desktop, if any, becomes the active one.
   */
  unpair(id = this.persisted.active): void {
    if (!id || !this.persisted.desktops[id]) return
    // Tell the desktop while the channel is up, so it drops this phone too; forgetting alone would
    // leave it trusted there. The channel is let go first: the desktop's `bye` must not count as a revoke.
    const desktop = this.desktop
    const channel = this.channel
    if (id === this.persisted.active && this.ready && channel && desktop) {
      this.channel = null
      this.ready = false
      this.sendRelay({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'enc', c: channel.seal({ t: 'unpair' }) } })
    }
    this.forget(id, 'unpaired')
  }

  /** Drops a desktop from the list; `state` is the state to be in when no desktop is left. */
  private forget(id: string, state: 'unpaired' | 'revoked'): void {
    const wasActive = id === this.persisted.active
    delete this.persisted.desktops[id]
    this.clearCache(id)
    if (wasActive) {
      this.disconnect()
      const next = Object.keys(this.persisted.desktops)[0]
      this.persisted.active = next
      this.savePersisted()
      this.error = undefined
      this.state = next ? 'connecting' : state
      this.changed()
      if (next && !this.suspended) this.connect(this.desktop!.relay)
    } else {
      this.savePersisted()
      this.changed()
    }
  }

  /** Where the browser receives push; sent to the relay now and on every reconnect. */
  setPushSubscription(subscription: { endpoint: string; keys: { p256dh: string; auth: string } } | null): void {
    this.pushSubscription = subscription
    if (this.socket && this.state !== 'pairing') this.sendRelay(subscription ? { t: 'push.subscribe', sub: subscription } : { t: 'push.unsubscribe' })
  }

  /** The last answer the desktop gave to this call, if any (what the phone shows without network). */
  cached<T>(channel: string, args: unknown[] = []): T | null {
    const desktop = this.desktop
    if (!desktop) return null
    const raw = this.deps.storage.get(cacheKeyOf(desktop.id, channel, args))
    if (!raw) return null
    try {
      const plain = decrypt(this.cacheKeyFor(desktop.id), fromBase64Url(raw))
      return plain ? (decodeJson(plain) as T) : null
    } catch {
      return null
    }
  }

  // ---- connection

  private connect(relay: string, offer?: PairingOffer): void {
    this.cancelReconnect?.()
    this.cancelReconnect = null
    if (this.socket) return
    if (!offer) {
      this.state = 'connecting'
      this.changed()
    }
    this.lastHeard = 0
    let socket: WebSocketLike
    try {
      socket = this.deps.connect(relay)
    } catch (err) {
      this.failed(err instanceof Error ? err.message : 'cannot connect', relay)
      return
    }
    this.socket = socket
    if (!offer) this.armWatchdog()
    // The relay speaks first, with the nonce our auth signs.
    socket.onopen = () => {}
    socket.onmessage = (ev: { data: unknown }) => this.receive(socket, typeof ev.data === 'string' ? ev.data : String(ev.data), offer)
    socket.onerror = () => {}
    socket.onclose = (ev: { code: number; reason: string }) => {
      if (this.socket !== socket) return
      this.socket = null
      this.dropChannel()
      if (this.state === 'revoked' || this.state === 'unpaired') return
      if (offer && this.state === 'pairing') {
        this.error = ev.reason || 'disconnected'
        this.changed()
        return
      }
      this.failed(ev.reason ? `disconnected: ${ev.reason}` : 'disconnected', relay)
    }
  }

  private failed(message: string, relay: string): void {
    this.state = 'desktop-offline'
    this.error = message
    this.changed()
    const delay = reconnectDelayMs(this.attempt++)
    this.cancelReconnect?.()
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null
      if (!this.socket && !this.suspended && this.desktop) this.connect(relay)
    }, delay)
  }

  /**
   * Drops a connection that stopped making progress: stuck connecting, or silent past the liveness
   * window. Without this a half-open socket keeps the phone "connecting" or "online" for minutes.
   */
  private dropDead(reason: string): void {
    const relay = this.desktop?.relay
    this.deps.log?.warn(`remote: ${reason}; reconnecting`)
    this.disconnect(4000, reason)
    if (this.suspended) this.goDormant()
    else if (relay) this.failed(reason, relay)
  }

  /** Gives the current socket `CONNECT_TIMEOUT_MS` to reach `online`. */
  private armWatchdog(): void {
    this.cancelWatchdog?.()
    const socket = this.socket
    this.cancelWatchdog = this.schedule(() => {
      this.cancelWatchdog = null
      if (socket && this.socket === socket && this.state === 'connecting') this.dropDead('timed out connecting')
    }, CONNECT_TIMEOUT_MS)
  }

  private clearWatchdog(): void {
    this.cancelWatchdog?.()
    this.cancelWatchdog = null
  }

  /** Pings the relay every `LIVENESS_MS` while the socket lives. */
  private startLiveness(): void {
    this.cancelLiveness?.()
    const socket = this.socket
    const tick = () => {
      this.cancelLiveness = null
      if (!socket || this.socket !== socket) return
      this.probe()
      this.cancelLiveness = this.schedule(tick, LIVENESS_MS)
    }
    this.cancelLiveness = this.schedule(tick, LIVENESS_MS)
  }

  /** Pings now; with nothing heard within `PONG_TIMEOUT_MS` the socket is dropped and dialed again. */
  private probe(): void {
    const socket = this.socket
    if (!socket) return
    const sentAt = this.now()
    this.sendRelay({ t: 'ping' })
    this.schedule(() => {
      if (this.socket === socket && this.lastHeard < sentAt) this.dropDead('no answer from the relay')
    }, PONG_TIMEOUT_MS)
  }

  private disconnect(code = 1000, reason = 'bye'): void {
    this.cancelReconnect?.()
    this.cancelReconnect = null
    this.clearWatchdog()
    this.cancelLiveness?.()
    this.cancelLiveness = null
    const socket = this.socket
    this.socket = null
    this.dropChannel()
    try {
      socket?.close(code, reason)
    } catch {
      // Already gone.
    }
  }

  private receive(socket: WebSocketLike, text: string, offer?: PairingOffer): void {
    if (this.socket !== socket) return
    this.lastHeard = this.now()
    // A relay frame is never this large; a hostile relay must not make the phone parse one.
    if (text.length > MAX_RELAY_FRAME_CHARS) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const message = parseRelayMessage(parsed)
    if (!message) return
    if (message.t === 'challenge') {
      this.sendRelay(makeAuth(this.identity, message.nonce, this.now()))
      return
    }
    const desktopId = offer ? fingerprintOf(offer.desktop) : this.desktop?.id
    if (!desktopId) return
    switch (message.t) {
      case 'welcome':
        this.attempt = 0
        this.startLiveness()
        this.vapidPublicKey = message.push?.vapidPublicKey
        this.sendRelay({ t: 'join', room: desktopId })
        if (this.pushSubscription && !offer) this.sendRelay({ t: 'push.subscribe', sub: this.pushSubscription as { endpoint: string; keys: { p256dh: string; auth: string } } })
        return
      case 'joined':
        if (!message.peers.includes(desktopId)) {
          if (offer) {
            this.error = 'desktop-offline'
            this.changed()
          } else this.desktopOffline()
          return
        }
        if (offer) this.sendPairRequest(offer)
        else this.handshake()
        return
      case 'peer':
        if (message.id !== desktopId) return
        if (message.online) {
          if (offer) this.sendPairRequest(offer)
          else this.handshake()
        } else this.desktopOffline()
        return
      case 'from':
        if (message.from !== desktopId) return
        this.fromDesktop(message, offer)
        return
      case 'error':
        if (message.code === 'offline') this.desktopOffline()
        else this.deps.log?.warn(`remote: relay said ${message.code}: ${message.message}`)
        return
      case 'pong':
        return
    }
  }

  private desktopOffline(): void {
    this.clearWatchdog()
    this.dropChannel()
    if (this.state !== 'pairing') {
      this.state = 'desktop-offline'
      this.error = undefined
      this.changed()
    }
  }

  private sendPairRequest(offer: PairingOffer): void {
    const request = answerPairingOffer(this.identity, offer, this.deps.deviceName(), this.deps.platform())
    const box = sealBox(offer.desktop, encodeJson(request))
    this.sendRelay({ t: 'to', room: fingerprintOf(offer.desktop), to: fingerprintOf(offer.desktop), body: { k: 'box', e: box.e, c: box.c } })
  }

  private handshake(): void {
    const desktop = this.desktop
    if (!desktop) return
    this.dropChannel()
    this.pendingHandshake = startHandshake(this.identity, desktop.public, 'initiator')
    this.state = 'connecting'
    this.changed()
    this.armWatchdog()
    this.sendRelay({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'hs', e: this.pendingHandshake.hello.e } })
  }

  private fromDesktop(message: Extract<RelayMessage, { t: 'from' }>, offer?: PairingOffer): void {
    const body = message.body
    if (body.k === 'box') {
      if (!offer) return
      const plain = openBox(this.identity, { e: body.e, c: body.c })
      if (!plain) return
      let accept: unknown
      try {
        accept = decodeJson(plain)
      } catch {
        return
      }
      const verified = verifyPairAccept(offer, this.identity, accept)
      if (!verified) {
        this.deps.log?.warn('remote: the desktop sent an accept that does not verify')
        return
      }
      // A new desktop becomes the active one; a desktop paired again keeps its place.
      const id = fingerprintOf(verified.desktop)
      this.persisted.desktops[id] = { id, public: verified.desktop, name: verified.name, relay: offer.relay, capabilities: verified.capabilities }
      this.persisted.active = id
      this.savePersisted()
      this.pendingOffer = null
      this.error = undefined
      // Same socket, same room: go straight to the handshake.
      const socket = this.socket!
      socket.onmessage = (ev: { data: unknown }) => this.receive(socket, typeof ev.data === 'string' ? ev.data : String(ev.data))
      socket.onclose = (ev: { code: number; reason: string }) => {
        if (this.socket !== socket) return
        this.socket = null
        this.dropChannel()
        if (this.state !== 'revoked') this.failed(ev.reason ? `disconnected: ${ev.reason}` : 'disconnected', offer.relay)
      }
      if (this.pushSubscription) this.sendRelay({ t: 'push.subscribe', sub: this.pushSubscription as { endpoint: string; keys: { p256dh: string; auth: string } } })
      this.handshake()
      return
    }
    if (body.k === 'hs') {
      if (!this.pendingHandshake) return
      try {
        this.channel = this.pendingHandshake.finish({ e: body.e })
      } catch {
        return
      }
      this.pendingHandshake = null
      this.sendMessage({ t: 'ready', client: this.deps.platform() })
      return
    }
    if (!this.channel) return
    const opened = this.channel.open(body.c)
    if (opened === null) {
      this.deps.log?.warn('remote: a message from the desktop did not open; reconnecting the channel')
      this.handshake()
      return
    }
    const channelMessage = parseChannelMessage(opened)
    if (!channelMessage) return
    this.handle(channelMessage)
  }

  private handle(message: ChannelMessage): void {
    switch (message.t) {
      case 'ready': {
        this.clearWatchdog()
        this.ready = true
        this.desktopTakesAway = message.features?.includes('away') ?? false
        this.state = 'online'
        this.error = undefined
        const desktop = this.desktop
        if (desktop) {
          if (message.capabilities) desktop.capabilities = message.capabilities
          if (message.desktop) desktop.name = message.desktop
          this.savePersisted()
        }
        this.changed()
        return
      }
      case 'result': {
        const waiting = this.pending.get(message.id)
        if (!waiting) return
        this.pending.delete(message.id)
        waiting.cancel()
        if (message.ok) waiting.resolve(message.value)
        else waiting.reject(new Error(message.error ?? 'failed'))
        return
      }
      case 'event':
        this.emit(message.channel, message.args)
        return
      case 'bye':
        if (message.reason === 'revoked') {
          if (this.persisted.active) this.forget(this.persisted.active, 'revoked')
        } else {
          // The desktop re-keys (capabilities changed) or restarts: handshake again when it is back.
          this.dropChannel()
          this.state = 'connecting'
          this.changed()
          this.handshake()
        }
        return
      case 'invoke':
      case 'send':
      case 'away':
        return
    }
  }

  private emit(channel: string, args: unknown[]): void {
    for (const cb of this.listeners.get(channel) ?? []) {
      try {
        cb(...args)
      } catch (err) {
        this.deps.log?.warn(`remote: a listener of ${channel} threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ---- hub transport

  private invoke(channel: string, args: unknown[]): Promise<unknown> {
    if (!this.ready || !this.channel) {
      if (isCachedCall(channel, args)) {
        const cached = this.cached(channel, args)
        if (cached !== null) return Promise.resolve(cached)
      }
      return Promise.reject(new Error(this.state === 'revoked' ? 'revoked' : 'offline'))
    }
    // The relay closes the socket of whoever sends an oversized frame: refuse the call instead.
    if (!fitsFrame({ t: 'invoke', id: this.nextId, channel, args })) return Promise.reject(new Error('too large to send to the desktop'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cancel = this.schedule(() => {
        if (this.pending.delete(id)) reject(new Error('the desktop did not answer'))
      }, this.deps.invokeTimeoutMs ?? 30_000)
      this.pending.set(id, {
        resolve: (value) => {
          if (isCachedCall(channel, args)) this.remember(channel, args, value)
          if (channel === 'sessions:list' && Array.isArray(value)) this.forgetClosedHistories(value)
          resolve(value)
        },
        reject,
        cancel
      })
      this.sendMessage({ t: 'invoke', id, channel, args })
    })
  }

  private sendMessage(message: ChannelMessage): void {
    const desktop = this.desktop
    if (!this.channel || !desktop) return
    this.sendRelay({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'enc', c: this.channel.seal(message) } })
  }

  private sendRelay(message: unknown): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch (err) {
      this.deps.log?.warn(`remote: send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private dropChannel(): void {
    this.channel = null
    this.pendingHandshake = null
    this.ready = false
    for (const [, waiting] of this.pending) {
      waiting.cancel()
      waiting.reject(new Error('disconnected'))
    }
    this.pending.clear()
  }

  // ---- persistence

  private loadPersisted(): Persisted {
    const raw = this.deps.storage.get(STATE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<Persisted>
        if (typeof parsed.seed === 'string' && fromBase64Url(parsed.seed).length === 32) {
          const desktops = parsed.desktops ?? {}
          // The first version kept one desktop: it becomes the active entry of the list.
          if (parsed.desktop) desktops[parsed.desktop.id] = parsed.desktop
          const active = parsed.active && desktops[parsed.active] ? parsed.active : (parsed.desktop?.id ?? Object.keys(desktops)[0])
          return { seed: parsed.seed, desktops, ...(active ? { active } : {}) }
        }
      } catch {
        // Start over below.
      }
    }
    const fresh: Persisted = { seed: toBase64Url(generateSeed()), desktops: {} }
    this.deps.storage.set(STATE_KEY, JSON.stringify(fresh))
    return fresh
  }

  private savePersisted(): void {
    this.deps.storage.set(STATE_KEY, JSON.stringify(this.persisted))
  }

  private remember(channel: string, args: unknown[], value: unknown): void {
    const desktop = this.desktop
    if (!desktop) return
    try {
      this.deps.storage.set(cacheKeyOf(desktop.id, channel, args), toBase64Url(encrypt(this.cacheKeyFor(desktop.id), encodeJson(value ?? null))))
    } catch {
      // Storage full or unavailable: the live answer still returned.
    }
  }

  /** The cached last page of every chat that is no longer open: nothing will show it again. */
  private forgetClosedHistories(views: unknown[]): void {
    const desktop = this.desktop
    const keys = this.deps.storage.keys?.()
    if (!desktop || !keys) return
    const open = new Set(views.map((v) => cacheKeyOf(desktop.id, 'remote:history', [(v as { id?: unknown }).id])))
    const prefix = `${CACHE_PREFIX}${desktop.id}:remote:history:`
    for (const key of keys) if (key.startsWith(prefix) && !open.has(key)) this.deps.storage.remove(key)
  }

  private cacheKeyFor(desktopId: string): Uint8Array {
    let key = this.cacheKeys.get(desktopId)
    if (!key) {
      key = deriveKey(this.identity.seed, undefined, `workhub-remote/cache/v2/${desktopId}`)
      this.cacheKeys.set(desktopId, key)
    }
    return key
  }

  /** Every cached answer of a desktop, whatever its arguments. */
  private clearCache(desktopId: string): void {
    const prefix = `${CACHE_PREFIX}${desktopId}:`
    const keys = this.deps.storage.keys?.() ?? [...CACHED_CHANNELS].map((channel) => cacheKeyOf(desktopId, channel, []))
    for (const key of keys) if (key.startsWith(prefix)) this.deps.storage.remove(key)
    this.cacheKeys.delete(desktopId)
  }

  private changed(): void {
    const status = this.status()
    for (const cb of this.statusListeners) {
      try {
        cb(status)
      } catch {
        // A listener must not break the client.
      }
    }
  }
}

/** Whether this call's answer is kept for offline use: of a chat's history, only its last page. */
export function isCachedCall(channel: string, args: unknown[]): boolean {
  if (!CACHED_CHANNELS.has(channel)) return false
  return channel !== 'remote:history' || args.length === 1
}

function cacheKeyOf(desktopId: string, channel: string, args: unknown[]): string {
  return `${CACHE_PREFIX}${desktopId}:${channel}:${JSON.stringify(args)}`
}
