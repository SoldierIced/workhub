// The end-to-end encrypted channel between a desktop and one paired device, over any transport
// that keeps order (a WebSocket through the relay). Both ends know each other's static identity
// (from pairing); each connection adds ephemeral keys, so a recorded connection cannot be read
// later even with a stolen identity. The device always initiates; the desktop responds.
import { x25519 } from '@noble/curves/ed25519.js'
import { concatBytes, decodeJson, encodeJson, fromBase64Url, toBase64Url } from './bytes'
import { decrypt, deriveKey, encrypt } from './crypto'
import { publicKeyBytes, type Identity, type PublicIdentity } from './identity'

export interface HandshakeHello {
  /** base64url of this end's ephemeral X25519 public key. */
  e: string
}

export type Role = 'initiator' | 'responder'

const INFO = 'workhub-remote/channel/v1'

/** Sequence number as the 8-byte big-endian AAD, so a replayed or reordered message fails to open. */
function seqBytes(seq: number): Uint8Array {
  const out = new Uint8Array(8)
  let n = seq
  for (let i = 7; i >= 0; i--) {
    out[i] = n % 256
    n = Math.floor(n / 256)
  }
  return out
}

/** An established channel: `seal` for what this end sends, `open` for what it receives. */
export class SecureChannel {
  private sendSeq = 0
  private recvSeq = 0

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly recvKey: Uint8Array,
    readonly role: Role
  ) {}

  /** base64url of the sealed JSON message. */
  seal(message: unknown): string {
    const seq = this.sendSeq++
    return toBase64Url(encrypt(this.sendKey, encodeJson(message), seqBytes(seq)))
  }

  /** The message, or null when it does not open (wrong key, tampered, replayed, out of order). */
  open(sealed: string): unknown | null {
    let bytes: Uint8Array
    try {
      bytes = fromBase64Url(sealed)
    } catch {
      return null
    }
    const plain = decrypt(this.recvKey, bytes, seqBytes(this.recvSeq))
    if (!plain) return null
    this.recvSeq++
    try {
      return decodeJson(plain)
    } catch {
      return null
    }
  }
}

export interface PendingHandshake {
  hello: HandshakeHello
  /** Completes with the peer's hello; the channel it returns is only usable if the peer holds its static key. */
  finish(peerHello: HandshakeHello): SecureChannel
}

/**
 * Starts a handshake with a known peer. Key material is DH(e, E) ‖ DH(s_i, E_r) ‖ DH(e_i, S_r) in
 * the initiator's terms, so each side needs its own static secret to get the same keys: a stranger
 * with only the public identities ends up with keys that open nothing.
 */
export function startHandshake(me: Identity, peer: PublicIdentity, role: Role): PendingHandshake {
  const eSecret = x25519.utils.randomSecretKey()
  const ePublic = x25519.getPublicKey(eSecret)
  const peerStatic = publicKeyBytes(peer.dh)
  return {
    hello: { e: toBase64Url(ePublic) },
    finish(peerHello) {
      const peerEphemeral = fromBase64Url(peerHello.e)
      if (peerEphemeral.length !== 32) throw new Error('a bad hello')
      const ee = x25519.getSharedSecret(eSecret, peerEphemeral)
      // DH(s_initiator, e_responder) and DH(e_initiator, s_responder), named from the initiator's side.
      const se = role === 'initiator' ? x25519.getSharedSecret(me.dhSecret, peerEphemeral) : x25519.getSharedSecret(eSecret, peerStatic)
      const es = role === 'initiator' ? x25519.getSharedSecret(eSecret, peerStatic) : x25519.getSharedSecret(me.dhSecret, peerEphemeral)
      const initiatorE = role === 'initiator' ? ePublic : peerEphemeral
      const responderE = role === 'initiator' ? peerEphemeral : ePublic
      const ikm = concatBytes(ee, se, es)
      const salt = concatBytes(initiatorE, responderE)
      const toResponder = deriveKey(ikm, salt, `${INFO}/i2r`)
      const toInitiator = deriveKey(ikm, salt, `${INFO}/r2i`)
      return role === 'initiator' ? new SecureChannel(toResponder, toInitiator, role) : new SecureChannel(toInitiator, toResponder, role)
    }
  }
}
