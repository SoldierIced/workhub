// The relay's logic, free of sockets and timers so it can be tested: who is authenticated, which
// rooms they listen in, delivering bodies to a peer in a room, presence, rate limits and push.
// The relay never opens a body: it forwards base64url it cannot read.
import { makeChallenge, MAX_BODY_BYTES, parseClientMessage, verifyAuth, type ClientMessage, type PublicIdentity, type RelayErrorCode, type RelayMessage } from '@workhub/protocol'

export interface Socket {
  send(text: string): void
  close(code: number, reason: string): void
  /** Bytes queued for the peer and not yet on the wire, when the transport knows (`ws` does). */
  buffered?(): number
}

export interface Peer {
  socket: Socket
  /** Set once the peer authenticated. */
  id?: string
  pub?: PublicIdentity
  rooms: Set<string>
  /** Address the connection came from, for per-address limits and logs. */
  address: string
  /** The nonce this connection must sign in its auth. */
  nonce: string
  tokens: number
  tokensAt: number
  strikes: number
  /** Pushes this peer asked for that the push service has not answered yet. */
  pushesInFlight: number
}

export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Where a device receives push, and which desktops' rooms it has joined (only those may push to it). */
export interface PushRecord {
  sub: PushSubscriptionRecord
  rooms: string[]
  updatedAt: number
}

export interface PushProvider {
  /** The VAPID public key the browser subscribes with. */
  publicKey: string
  /** Delivers the payload; throws with `gone: true` when the subscription no longer exists. */
  send(sub: PushSubscriptionRecord, payload: string): Promise<void>
  /** Whether a subscription endpoint may be stored and pushed to (a push service, not any URL). */
  allows?(endpoint: string): boolean
}

export interface PushStore {
  get(deviceId: string): PushRecord | undefined
  set(deviceId: string, record: PushRecord): void
  delete(deviceId: string): void
  size?(): number
}

export interface RelayLimits {
  /** Messages a peer may send per `windowMs` (a desktop streams every agent event, so this is generous). */
  messagesPerWindow: number
  windowMs: number
  /** Peers one room admits (a desktop and its devices; strangers cannot pile in). */
  maxPeersPerRoom: number
  /** Connections one address may hold. */
  maxPeersPerAddress: number
  /** Connections one identity may hold at once (a phone's tabs). */
  maxPeersPerId: number
  /** Connections the relay holds in all. */
  maxPeers: number
  /** Rooms one peer may listen in. */
  maxRoomsPerPeer: number
  /** Largest raw frame, a little above the largest body the protocol allows. */
  maxFrameBytes: number
  /** Bytes queued for a peer that does not read; past this it is dropped rather than buffered. */
  maxBufferedBytes: number
  /** Push subscriptions the relay keeps. */
  maxPushRecords: number
  /** Pushes one peer may have waiting on the push service. */
  maxPushesInFlight: number
}

export const DEFAULT_LIMITS: RelayLimits = {
  messagesPerWindow: 3000,
  windowMs: 10_000,
  maxPeersPerRoom: 24,
  maxPeersPerAddress: 32,
  maxPeersPerId: 6,
  maxPeers: 5000,
  maxRoomsPerPeer: 16,
  maxFrameBytes: MAX_BODY_BYTES + 8 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  maxPushRecords: 20_000,
  maxPushesInFlight: 8
}

export interface RelayCoreOptions {
  push?: PushProvider
  pushStore?: PushStore
  limits?: Partial<RelayLimits>
  now?: () => number
  log?: { info(line: string): void; warn(line: string): void }
}

export class MemoryPushStore implements PushStore {
  readonly records = new Map<string, PushRecord>()
  get(id: string) {
    return this.records.get(id)
  }
  set(id: string, record: PushRecord) {
    this.records.set(id, record)
  }
  delete(id: string) {
    this.records.delete(id)
  }
  size() {
    return this.records.size
  }
}

export class RelayCore {
  private readonly rooms = new Map<string, Set<Peer>>()
  private readonly byAddress = new Map<string, number>()
  private readonly peers = new Set<Peer>()
  private readonly limits: RelayLimits
  private readonly now: () => number
  private readonly pushStore: PushStore

  constructor(private readonly options: RelayCoreOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.pushStore = options.pushStore ?? new MemoryPushStore()
  }

  /**
   * A new connection; null (and the socket closed) when the address or the relay holds too many
   * already. The peer gets its challenge at once: the nonce its auth must sign.
   */
  connect(socket: Socket, address: string): Peer | null {
    const held = this.byAddress.get(address) ?? 0
    if (held >= this.limits.maxPeersPerAddress || this.peers.size >= this.limits.maxPeers) {
      socket.close(1008, 'too many connections')
      return null
    }
    this.byAddress.set(address, held + 1)
    const peer: Peer = { socket, rooms: new Set(), address, nonce: makeChallenge(), tokens: this.limits.messagesPerWindow, tokensAt: this.now(), strikes: 0, pushesInFlight: 0 }
    this.peers.add(peer)
    this.send(peer, { t: 'challenge', nonce: peer.nonce })
    return peer
  }

  disconnect(peer: Peer): void {
    if (!this.peers.delete(peer)) return
    const held = this.byAddress.get(peer.address) ?? 1
    if (held <= 1) this.byAddress.delete(peer.address)
    else this.byAddress.set(peer.address, held - 1)
    for (const room of [...peer.rooms]) this.leave(peer, room)
  }

  /**
   * A frame from the peer. Everything that goes wrong answers with an `error` and drops the frame;
   * before authentication anything but a valid auth closes the connection.
   */
  receive(peer: Peer, raw: string | Uint8Array): void {
    if (!this.takeToken(peer)) {
      peer.strikes++
      this.error(peer, 'rate-limited', 'too many messages; slow down')
      if (peer.strikes >= 20 || !peer.id) peer.socket.close(1008, 'rate limited')
      return
    }
    const size = typeof raw === 'string' ? utf8Length(raw) : raw.byteLength
    if (size > this.limits.maxFrameBytes) {
      this.error(peer, 'too-large', `a frame may have at most ${this.limits.maxFrameBytes} bytes`)
      if (!peer.id) peer.socket.close(1009, 'too large')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      parsed = undefined
    }
    const message = parsed === undefined ? null : parseClientMessage(parsed)
    if (!message) {
      this.error(peer, 'bad-message', parsed === undefined ? 'not JSON' : 'not a relay message')
      if (!peer.id) peer.socket.close(1008, 'bad message')
      return
    }
    if (message.t === 'auth') return this.auth(peer, message)
    if (!peer.id) {
      this.error(peer, 'unauthenticated', 'send auth first')
      peer.socket.close(1008, 'auth first')
      return
    }
    switch (message.t) {
      case 'join':
        return this.join(peer, message.room)
      case 'leave':
        return this.leave(peer, message.room)
      case 'to':
        return this.deliver(peer, message)
      case 'ping':
        return this.send(peer, { t: 'pong', now: this.now() })
      case 'push.subscribe':
        return this.subscribePush(peer, message.sub)
      case 'push.unsubscribe':
        this.storeDelete(peer.id)
        return
      case 'push':
        void this.push(peer, message)
        return
    }
  }

  /** The largest frame accepted, for the transport to enforce before buffering. */
  get frameLimit(): number {
    return this.limits.maxFrameBytes
  }

  /** Whether the peer is still allowed to be here without authenticating (the server enforces the deadline). */
  isAuthenticated(peer: Peer): boolean {
    return peer.id !== undefined
  }

  /** The ids online in a room, each once. */
  peersIn(room: string): string[] {
    return [...new Set([...(this.rooms.get(room) ?? [])].map((p) => p.id!))]
  }

  private auth(peer: Peer, message: Extract<ClientMessage, { t: 'auth' }>): void {
    if (peer.id) return this.error(peer, 'bad-auth', 'already authenticated')
    const verdict = verifyAuth(message, peer.nonce, this.now())
    if (!verdict.ok) {
      this.error(peer, 'bad-auth', `auth refused: ${verdict.reason}`)
      peer.socket.close(1008, 'bad auth')
      return
    }
    let held = 0
    for (const other of this.peers) if (other.id === verdict.id) held++
    if (held >= this.limits.maxPeersPerId) {
      this.error(peer, 'rate-limited', 'too many connections for this identity')
      peer.socket.close(1008, 'too many connections')
      return
    }
    peer.id = verdict.id
    peer.pub = verdict.pub
    this.options.log?.info(`auth ${peer.id} from ${peer.address}`)
    this.send(peer, { t: 'welcome', id: peer.id, now: this.now(), ...(this.options.push ? { push: { vapidPublicKey: this.options.push.publicKey } } : {}) })
  }

  private join(peer: Peer, room: string): void {
    const members = this.rooms.get(room) ?? new Set<Peer>()
    if (!members.has(peer)) {
      const owner = peer.id === room
      if (peer.rooms.size >= this.limits.maxRoomsPerPeer) return this.error(peer, 'rate-limited', 'too many rooms')
      if (!owner && this.peersIn(room).filter((id) => id !== peer.id).length >= this.limits.maxPeersPerRoom) return this.error(peer, 'rate-limited', 'the room is full')
      const wasOnline = this.peersIn(room).includes(peer.id!)
      members.add(peer)
      this.rooms.set(room, members)
      peer.rooms.add(room)
      if (!wasOnline) this.broadcast(room, { t: 'peer', room, id: peer.id!, online: true }, peer.id!)
      if (!owner) this.rememberRoom(peer.id!, room)
    }
    this.send(peer, { t: 'joined', room, peers: this.peersIn(room).filter((id) => id !== peer.id) })
  }

  private leave(peer: Peer, room: string): void {
    const members = this.rooms.get(room)
    if (!members?.delete(peer)) return
    peer.rooms.delete(room)
    if (members.size === 0) this.rooms.delete(room)
    if (!this.peersIn(room).includes(peer.id!)) this.broadcast(room, { t: 'peer', room, id: peer.id!, online: false }, peer.id!)
  }

  private deliver(peer: Peer, message: Extract<ClientMessage, { t: 'to' }>): void {
    if (!peer.rooms.has(message.room)) return this.error(peer, 'not-joined', 'join the room first', message.ref)
    const targets = [...(this.rooms.get(message.room) ?? [])].filter((p) => p.id === message.to)
    if (targets.length === 0) return this.error(peer, 'offline', `${message.to} is not in the room`, message.ref)
    const out: RelayMessage = { t: 'from', room: message.room, from: peer.id!, body: message.body }
    for (const target of targets) this.send(target, out)
  }

  private subscribePush(peer: Peer, sub: PushSubscriptionRecord): void {
    if (!this.options.push) return this.error(peer, 'no-push', 'this relay does not send push notifications')
    if (this.options.push.allows && !this.options.push.allows(sub.endpoint)) return this.error(peer, 'bad-message', 'the push endpoint is not a known push service')
    const current = this.pushStore.get(peer.id!)
    if (!current && (this.pushStore.size?.() ?? 0) >= this.limits.maxPushRecords) return this.error(peer, 'rate-limited', 'the relay holds too many push subscriptions')
    this.storeSet(peer.id!, { sub, rooms: current?.rooms ?? [...peer.rooms].filter((r) => r !== peer.id), updatedAt: this.now() })
  }

  /** A device that joined a desktop's room may be pushed to by that desktop, connected or not. */
  private rememberRoom(deviceId: string, room: string): void {
    const current = this.pushStore.get(deviceId)
    if (!current || current.rooms.includes(room)) return
    this.storeSet(deviceId, { ...current, rooms: [...current.rooms, room].slice(-16), updatedAt: this.now() })
  }

  private async push(peer: Peer, message: Extract<ClientMessage, { t: 'push' }>): Promise<void> {
    if (!this.options.push) return this.error(peer, 'no-push', 'this relay does not send push notifications')
    if (message.room !== peer.id) return this.error(peer, 'not-joined', 'only a desktop pushes to its own devices')
    const record = this.pushStore.get(message.to)
    if (!record || !record.rooms.includes(message.room)) return this.error(peer, 'offline', `${message.to} has no push subscription for this desktop`)
    if (peer.pushesInFlight >= this.limits.maxPushesInFlight) return this.error(peer, 'rate-limited', 'too many pushes waiting on the push service')
    peer.pushesInFlight++
    try {
      await this.options.push.send(record.sub, JSON.stringify({ box: message.box }))
    } catch (err) {
      const gone = Boolean(err && typeof err === 'object' && (err as { gone?: boolean }).gone)
      if (gone) this.storeDelete(message.to)
      this.options.log?.warn(`push to ${message.to} failed${gone ? ' (subscription gone)' : ''}`)
      this.error(peer, 'push-failed', gone ? 'the device unsubscribed from push' : 'the push service refused the message')
    } finally {
      peer.pushesInFlight--
    }
  }

  /** The store may sit on a full or read-only disk: that must not take the relay down. */
  private storeSet(id: string, record: PushRecord): void {
    try {
      this.pushStore.set(id, record)
    } catch (err) {
      this.options.log?.warn(`push store write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private storeDelete(id: string): void {
    try {
      this.pushStore.delete(id)
    } catch (err) {
      this.options.log?.warn(`push store write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private takeToken(peer: Peer): boolean {
    const now = this.now()
    const elapsed = now - peer.tokensAt
    if (elapsed > 0) {
      peer.tokens = Math.min(this.limits.messagesPerWindow, peer.tokens + (elapsed / this.limits.windowMs) * this.limits.messagesPerWindow)
      peer.tokensAt = now
    }
    if (peer.tokens < 1) return false
    peer.tokens -= 1
    return true
  }

  private broadcast(room: string, message: RelayMessage, exceptId: string): void {
    for (const member of this.rooms.get(room) ?? []) if (member.id !== exceptId) this.send(member, message)
  }

  private send(peer: Peer, message: RelayMessage): void {
    // A peer that stops reading would make the relay buffer without end; it is dropped instead.
    if ((peer.socket.buffered?.() ?? 0) > this.limits.maxBufferedBytes) {
      this.options.log?.warn(`dropping ${peer.id ?? peer.address}: not reading`)
      try {
        peer.socket.close(1008, 'not reading')
      } catch {
        // Already gone.
      }
      return
    }
    try {
      peer.socket.send(JSON.stringify(message))
    } catch (err) {
      this.options.log?.warn(`send to ${peer.id ?? peer.address} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private error(peer: Peer, code: RelayErrorCode, message: string, ref?: string): void {
    this.send(peer, { t: 'error', code, message, ...(ref ? { ref } : {}) })
  }
}

/** UTF-8 length of a string without encoding it (frames arrive as text). */
function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
