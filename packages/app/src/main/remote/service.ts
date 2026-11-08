// Remote access from the desktop's side: its identity, the connection to the relay, pairing
// devices, the encrypted channel to each one (over which hub calls and events travel through
// RemoteHub), and repeating notifications to devices (over the channel, or by push when offline).
import type { NotificationKind, SecretStore } from '@workhub/core'
import {
  acceptPairing,
  decodeJson,
  encodeJson,
  fingerprintOf,
  displayFingerprint,
  generateSeed,
  identityFromSeed,
  makeAuth,
  makePairingOffer,
  openBox,
  pairingLink,
  parseChannelMessage,
  parseRelayMessage,
  reconnectDelayMs,
  sealBox,
  startHandshake,
  toBase64Url,
  fromBase64Url,
  verifyPairRequest,
  pairRequestSchema,
  type Body,
  type ChannelMessage,
  type Identity,
  type PairingOffer,
  type PublicIdentity,
  type PushPayload,
  type RelayMessage,
  type SecureChannel
} from '@workhub/protocol'
import type { RemoteCapability, RemoteDevicePlatform, RemoteDeviceView, RemoteStatusView } from '../../shared/remote-api'
import { isRemoteCapability } from '../../shared/remote-api'
import type { MirroredNotification } from '../notifier'
import { RemoteHub, RemoteRefused } from './dispatcher'

export interface RemoteDeviceRecord {
  id: string
  name: string
  platform: RemoteDevicePlatform
  public: PublicIdentity
  capabilities: RemoteCapability[]
  pairedAt: number
  lastSeenAt?: number
}

export interface RemoteState {
  enabled: boolean
  relayUrl: string
  desktopName: string
  devices: RemoteDeviceRecord[]
}

export const EMPTY_REMOTE_STATE: RemoteState = { enabled: false, relayUrl: '', desktopName: '', devices: [] }

/** The browser-style WebSocket surface the service uses (Node's global WebSocket, or a fake). */
export interface WebSocketLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  // Loose on purpose: Node's and the browser's WebSocket type their events differently.
  onopen: ((ev: any) => void) | null
  onmessage: ((ev: any) => void) | null
  onclose: ((ev: any) => void) | null
  onerror: ((ev: any) => void) | null
}

export interface RemoteServiceDeps {
  store: { load(fallback: RemoteState): RemoteState; save(state: RemoteState): void }
  secrets: Pick<SecretStore, 'get' | 'set'>
  hub: RemoteHub
  connect: (url: string) => WebSocketLike
  /** What the desktop calls itself until the person names it (the computer's name). */
  defaultName: () => string
  onChanged: (status: RemoteStatusView) => void
  log: { info(line: string): void; warn(line: string): void }
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

const IDENTITY_REF = 'remote/identity'

/** Which capability a notification kind belongs to; a device without it does not get the notification. */
const KIND_CAPABILITY: Partial<Record<NotificationKind, RemoteCapability>> = {
  replied: 'sessions',
  needsAnswer: 'sessions',
  error: 'sessions',
  aiReview: 'sessions',
  prEvent: 'pullRequests',
  automations: 'automations',
  health: 'health',
  flowMaps: 'health',
  metricAlert: 'health'
}

interface Link {
  channel: SecureChannel
  /** The device said `ready` over the channel: events and notifications flow. */
  ready: boolean
  detach: () => void
}

/** `https://relay.example.com[/]` → `wss://relay.example.com/ws`; `ws(s)://…/ws` stays. */
export function relayWebSocketUrl(relayUrl: string): string | null {
  let url: URL
  try {
    url = new URL(relayUrl.trim())
  } catch {
    return null
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
  if (!url.pathname.endsWith('/ws')) url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
  url.hash = ''
  url.search = ''
  return url.toString()
}

/** The web client the relay serves, where a pairing link opens: the relay's https origin and path. */
export function relayWebClientUrl(relayUrl: string): string | null {
  const ws = relayWebSocketUrl(relayUrl)
  if (!ws) return null
  const url = new URL(ws)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = url.pathname.replace(/\/ws$/, '/')
  return url.toString()
}

export class RemoteService {
  private state: RemoteState
  private identity: Identity | null = null
  private socket: WebSocketLike | null = null
  private connection: RemoteStatusView['connection'] = 'off'
  private error: string | undefined
  private pushAvailable = false
  private attempt = 0
  private cancelReconnect: (() => void) | null = null
  private readonly online = new Set<string>()
  private readonly links = new Map<string, Link>()
  private pairing: { offer: PairingOffer; link: string; cancel: () => void } | null = null
  private request: { deviceId: string; name: string; platform: RemoteDevicePlatform; public: PublicIdentity } | null = null
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(private readonly deps: RemoteServiceDeps) {
    this.state = deps.store.load(EMPTY_REMOTE_STATE)
    this.now = deps.now ?? Date.now
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
  }

  /** Connects when remote access was left on. */
  async start(): Promise<void> {
    if (this.state.enabled) await this.connect()
  }

  status(): RemoteStatusView {
    return {
      enabled: this.state.enabled,
      relayUrl: this.state.relayUrl,
      desktopName: this.state.desktopName || this.deps.defaultName(),
      desktopId: this.identity?.id ?? null,
      fingerprint: this.identity ? displayFingerprint(this.identity.id) : null,
      connection: this.connection,
      ...(this.error ? { error: this.error } : {}),
      pushAvailable: this.pushAvailable,
      devices: this.state.devices.map((d) => this.deviceView(d)),
      pairing: this.pairing ? { link: this.pairing.link, expiresAt: this.pairing.offer.exp } : null,
      request: this.request ? { deviceId: this.request.deviceId, fingerprint: displayFingerprint(this.request.deviceId), name: this.request.name, platform: this.request.platform } : null
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatusView> {
    this.state = { ...this.state, enabled }
    this.deps.store.save(this.state)
    if (enabled) await this.connect()
    else this.disconnect('off')
    return this.changed()
  }

  async setRelayUrl(url: string): Promise<RemoteStatusView> {
    const trimmed = url.trim()
    if (trimmed && !relayWebSocketUrl(trimmed)) throw new Error('the relay address must be an https:// or wss:// URL')
    this.state = { ...this.state, relayUrl: trimmed }
    this.deps.store.save(this.state)
    if (this.state.enabled) {
      this.disconnect('off')
      await this.connect()
    }
    return this.changed()
  }

  setDesktopName(name: string): RemoteStatusView {
    this.state = { ...this.state, desktopName: name.trim().slice(0, 80) }
    this.deps.store.save(this.state)
    return this.changed()
  }

  /** Shows a QR: an offer good for five minutes, or until a device is accepted. */
  async startPairing(): Promise<RemoteStatusView> {
    if (!this.state.enabled) throw new Error('turn remote access on first')
    const ws = relayWebSocketUrl(this.state.relayUrl)
    const web = relayWebClientUrl(this.state.relayUrl)
    if (!ws || !web) throw new Error('set the relay address first')
    const me = await this.ensureIdentity()
    this.pairing?.cancel()
    const offer = makePairingOffer(me, ws, this.status().desktopName, this.now())
    const cancel = this.schedule(() => {
      if (this.pairing?.offer === offer) this.pairing = null
      this.changed()
    }, offer.exp - this.now())
    this.pairing = { offer, link: pairingLink(web, offer), cancel }
    this.request = null
    return this.changed()
  }

  cancelPairing(): RemoteStatusView {
    this.pairing?.cancel()
    this.pairing = null
    this.request = null
    return this.changed()
  }

  /** The person confirmed the device that answered the QR; it may now connect with what it was granted. */
  acceptPairing(deviceId: string, capabilities: RemoteCapability[]): RemoteStatusView {
    const request = this.request
    const me = this.identity
    if (!request || request.deviceId !== deviceId || !me) throw new Error('no device is waiting to be paired')
    const granted = capabilities.filter(isRemoteCapability)
    const record: RemoteDeviceRecord = { id: deviceId, name: request.name, platform: request.platform, public: request.public, capabilities: granted, pairedAt: this.now() }
    this.state = { ...this.state, devices: [...this.state.devices.filter((d) => d.id !== deviceId), record] }
    this.deps.store.save(this.state)
    this.sendTo(deviceId, this.box(request.public, acceptPairing(me, request.public, this.status().desktopName, granted)))
    this.deps.log.info(`remote: paired ${deviceId} (${request.platform}) with ${granted.join(', ') || 'nothing'}`)
    this.pairing?.cancel()
    this.pairing = null
    this.request = null
    return this.changed()
  }

  rejectPairing(deviceId: string): RemoteStatusView {
    if (this.request?.deviceId === deviceId) this.request = null
    return this.changed()
  }

  setCapabilities(deviceId: string, capabilities: RemoteCapability[]): RemoteStatusView {
    const device = this.state.devices.find((d) => d.id === deviceId)
    if (!device) throw new Error('unknown device')
    device.capabilities = capabilities.filter(isRemoteCapability)
    this.deps.store.save(this.state)
    // A live link keeps the capabilities it was attached with: reconnecting applies the new ones.
    // Dropped first: the device answers `bye` with a new handshake, which must find no stale link.
    const link = this.links.get(deviceId)
    this.dropLink(deviceId)
    if (link) this.sendChannel(deviceId, link, { t: 'bye', reason: 'shutdown' })
    return this.changed()
  }

  revoke(deviceId: string): RemoteStatusView {
    const link = this.links.get(deviceId)
    this.dropLink(deviceId)
    this.state = { ...this.state, devices: this.state.devices.filter((d) => d.id !== deviceId) }
    this.deps.store.save(this.state)
    if (link) this.sendChannel(deviceId, link, { t: 'bye', reason: 'revoked' })
    this.deps.log.info(`remote: revoked ${deviceId}`)
    return this.changed()
  }

  /** A notification the desktop showed: the devices that may see its kind get it, over the channel or by push. */
  notify(notification: MirroredNotification): void {
    const me = this.identity
    if (!me || !this.state.enabled || !this.socket) return
    const capability = KIND_CAPABILITY[notification.kind]
    if (!capability) return
    const payload: PushPayload = {
      v: 1,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      ts: notification.at,
      ...(notification.tag ? { tag: notification.tag } : {}),
      ...(notification.sessionId ? { route: `#session/${encodeURIComponent(notification.sessionId)}` } : {})
    }
    for (const device of this.state.devices) {
      if (!device.capabilities.includes(capability)) continue
      const link = this.links.get(device.id)
      if (link?.ready) this.sendChannel(device.id, link, { t: 'event', channel: 'remote:notification', args: [payload] })
      else if (this.pushAvailable) this.send({ t: 'push', room: me.id, to: device.id, box: sealBox(device.public, encodeJson(payload)) })
    }
  }

  async stop(): Promise<void> {
    for (const [id, link] of this.links) this.sendChannel(id, link, { t: 'bye', reason: 'shutdown' })
    this.disconnect('off')
  }

  // ---- connection to the relay

  private async connect(): Promise<void> {
    const url = relayWebSocketUrl(this.state.relayUrl)
    if (!url) {
      this.connection = 'error'
      this.error = 'no relay address'
      this.changed()
      return
    }
    const me = await this.ensureIdentity()
    this.cancelReconnect?.()
    this.cancelReconnect = null
    if (this.socket) return
    this.connection = 'connecting'
    this.error = undefined
    this.changed()
    let socket: WebSocketLike
    try {
      socket = this.deps.connect(url)
    } catch (err) {
      this.failed(err instanceof Error ? err.message : 'cannot connect')
      return
    }
    this.socket = socket
    socket.onopen = () => socket.send(JSON.stringify(makeAuth(me, this.now())))
    socket.onmessage = (ev: { data: unknown }) => this.receive(socket, typeof ev.data === 'string' ? ev.data : String(ev.data))
    socket.onerror = () => {
      // `close` follows and schedules the retry; the error itself carries no message in browsers or Node.
    }
    socket.onclose = (ev: { code: number; reason: string }) => {
      if (this.socket !== socket) return
      this.socket = null
      this.online.clear()
      for (const id of [...this.links.keys()]) this.dropLink(id)
      if (!this.state.enabled) return
      this.failed(ev.reason ? `disconnected: ${ev.reason}` : 'disconnected')
    }
  }

  /** Records the failure and books the next attempt. */
  private failed(message: string): void {
    this.connection = 'error'
    this.error = message
    this.changed()
    const delay = reconnectDelayMs(this.attempt++)
    this.cancelReconnect?.()
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null
      if (this.state.enabled && !this.socket) void this.connect()
    }, delay)
  }

  private disconnect(state: RemoteStatusView['connection']): void {
    this.cancelReconnect?.()
    this.cancelReconnect = null
    const socket = this.socket
    this.socket = null
    for (const id of [...this.links.keys()]) this.dropLink(id)
    this.online.clear()
    this.connection = state
    this.error = undefined
    try {
      socket?.close(1000, 'bye')
    } catch {
      // Already gone.
    }
  }

  private receive(socket: WebSocketLike, text: string): void {
    if (this.socket !== socket) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const message = parseRelayMessage(parsed)
    if (!message) return
    switch (message.t) {
      case 'welcome':
        this.attempt = 0
        this.connection = 'online'
        this.error = undefined
        this.pushAvailable = Boolean(message.push)
        this.send({ t: 'join', room: message.id })
        this.changed()
        return
      case 'joined':
        for (const id of message.peers) this.online.add(id)
        this.changed()
        return
      case 'peer':
        if (message.online) this.online.add(message.id)
        else {
          this.online.delete(message.id)
          this.dropLink(message.id)
        }
        this.touch(message.id)
        this.changed()
        return
      case 'from':
        this.fromPeer(message)
        return
      case 'error':
        if (message.code === 'offline' || message.code === 'push-failed') return
        this.deps.log.warn(`remote: relay said ${message.code}: ${message.message}`)
        return
      case 'pong':
        return
    }
  }

  private fromPeer(message: Extract<RelayMessage, { t: 'from' }>): void {
    const me = this.identity
    if (!me) return
    const device = this.state.devices.find((d) => d.id === message.from)
    const body = message.body
    if (body.k === 'box') {
      // Only a pairing request arrives boxed, and only while a QR is shown.
      if (!this.pairing) return
      const plain = openBox(me, { e: body.e, c: body.c })
      if (!plain) return
      let request: unknown
      try {
        request = decodeJson(plain)
      } catch {
        return
      }
      const verdict = verifyPairRequest(this.pairing.offer, request, this.now())
      if (!verdict.ok) {
        this.deps.log.warn(`remote: pairing request from ${message.from} refused: ${verdict.reason}`)
        if (verdict.reason === 'expired') this.cancelPairing()
        return
      }
      const parsed = pairRequestSchema.parse(request)
      if (verdict.deviceId !== message.from || fingerprintOf(parsed.device) !== message.from) return
      this.request = { deviceId: message.from, name: parsed.name, platform: parsed.platform, public: parsed.device }
      this.changed()
      return
    }
    if (!device) return
    if (body.k === 'hs') {
      // The device initiates; answer with our ephemeral key and keep the channel.
      this.dropLink(device.id)
      const pending = startHandshake(me, device.public, 'responder')
      let channel: SecureChannel
      try {
        channel = pending.finish({ e: body.e })
      } catch {
        return
      }
      const detach = this.deps.hub.attach({
        id: device.id,
        capabilities: new Set(device.capabilities),
        emit: (channel, args) => {
          const link = this.links.get(device.id)
          if (link?.ready) this.sendChannel(device.id, link, { t: 'event', channel, args })
        }
      })
      // The link is in place before our hello goes out: the device's `ready` may come straight back.
      this.links.set(device.id, { channel, ready: false, detach })
      this.sendTo(device.id, { k: 'hs', e: pending.hello.e })
      this.touch(device.id)
      return
    }
    const link = this.links.get(device.id)
    if (!link) return
    const opened = link.channel.open(body.c)
    if (opened === null) {
      this.deps.log.warn(`remote: a message from ${device.id} did not open; dropping the channel`)
      this.dropLink(device.id)
      return
    }
    const channelMessage = parseChannelMessage(opened)
    if (!channelMessage) return
    void this.handle(device, link, channelMessage)
  }

  private async handle(device: RemoteDeviceRecord, link: Link, message: ChannelMessage): Promise<void> {
    switch (message.t) {
      case 'ready':
        link.ready = true
        this.sendChannel(device.id, link, { t: 'ready', capabilities: device.capabilities, desktop: this.status().desktopName })
        this.touch(device.id)
        this.changed()
        return
      case 'invoke': {
        try {
          const value = await this.deps.hub.invoke(device.id, message.channel, message.args)
          this.sendChannel(device.id, link, { t: 'result', id: message.id, ok: true, value: value === undefined ? null : value })
        } catch (err) {
          const text = err instanceof RemoteRefused ? err.message : err instanceof Error ? err.message : 'failed'
          this.sendChannel(device.id, link, { t: 'result', id: message.id, ok: false, error: text.slice(0, 2000) })
        }
        return
      }
      case 'send':
        try {
          this.deps.hub.message(device.id, message.channel, message.args)
        } catch (err) {
          this.deps.log.warn(`remote: ${message.channel} from ${device.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      case 'bye':
        this.dropLink(device.id)
        return
      case 'result':
      case 'event':
        return
    }
  }

  // ---- helpers

  private async ensureIdentity(): Promise<Identity> {
    if (this.identity) return this.identity
    const stored = await this.deps.secrets.get(IDENTITY_REF)
    let seed: Uint8Array | null = null
    if (stored) {
      try {
        const bytes = fromBase64Url(stored)
        if (bytes.length === 32) seed = bytes
      } catch {
        seed = null
      }
    }
    if (!seed) {
      seed = generateSeed()
      await this.deps.secrets.set(IDENTITY_REF, toBase64Url(seed))
    }
    this.identity = identityFromSeed(seed)
    return this.identity
  }

  private box(to: PublicIdentity, value: unknown): Body {
    const sealed = sealBox(to, encodeJson(value))
    return { k: 'box', e: sealed.e, c: sealed.c }
  }

  private sendTo(deviceId: string, body: Body): void {
    const me = this.identity
    if (!me) return
    this.send({ t: 'to', room: me.id, to: deviceId, body })
  }

  private sendChannel(deviceId: string, link: Link, message: ChannelMessage): void {
    this.sendTo(deviceId, { k: 'enc', c: link.channel.seal(message) })
  }

  private send(message: unknown): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch (err) {
      this.deps.log.warn(`remote: send failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private dropLink(deviceId: string): void {
    const link = this.links.get(deviceId)
    if (!link) return
    this.links.delete(deviceId)
    link.detach()
    this.changed()
  }

  private touch(deviceId: string): void {
    const device = this.state.devices.find((d) => d.id === deviceId)
    if (!device) return
    device.lastSeenAt = this.now()
    this.deps.store.save(this.state)
  }

  private deviceView(d: RemoteDeviceRecord): RemoteDeviceView {
    return {
      id: d.id,
      fingerprint: displayFingerprint(d.id),
      name: d.name,
      platform: d.platform,
      capabilities: d.capabilities,
      pairedAt: d.pairedAt,
      ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
      online: this.links.get(d.id)?.ready === true
    }
  }

  private changed(): RemoteStatusView {
    const status = this.status()
    try {
      this.deps.onChanged(status)
    } catch {
      // The window may be gone.
    }
    return status
  }
}
