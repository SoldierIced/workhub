// How a client proves its identity to the relay: a signature over the nonce the relay sent on
// connect and a fresh timestamp. The relay checks the public keys hash to the claimed id, the
// signature, and that the timestamp is recent. The nonce ties the proof to this connection, so a
// captured auth cannot be replayed on this relay or on another one.
import { encodeJson, fromBase64Url, randomBytes, toBase64Url } from './bytes'
import { fingerprintOf, sign, verify, type Identity, type PublicIdentity } from './identity'
import type { ClientMessage } from './messages'
import { PROTOCOL_VERSION } from './messages'

export const AUTH_MAX_SKEW_MS = 5 * 60_000
export const AUTH_NONCE_BYTES = 32

function authBytes(id: string, ts: number, nonce: string): Uint8Array {
  return encodeJson(['workhub-relay/auth', id, ts, nonce])
}

/** The relay's side: a nonce for one connection, sent before anything else. */
export function makeChallenge(): string {
  return toBase64Url(randomBytes(AUTH_NONCE_BYTES))
}

export function makeAuth(me: Identity, nonce: string, now = Date.now()): Extract<ClientMessage, { t: 'auth' }> {
  return { t: 'auth', v: PROTOCOL_VERSION, id: me.id, pub: me.public, ts: now, nonce, sig: toBase64Url(sign(me, authBytes(me.id, now, nonce))) }
}

export type AuthVerdict = { ok: true; id: string; pub: PublicIdentity } | { ok: false; reason: 'id' | 'signature' | 'stale' | 'nonce' }

export function verifyAuth(auth: Extract<ClientMessage, { t: 'auth' }>, nonce: string, now = Date.now(), maxSkewMs = AUTH_MAX_SKEW_MS): AuthVerdict {
  if (auth.nonce !== nonce) return { ok: false, reason: 'nonce' }
  if (fingerprintOf(auth.pub) !== auth.id) return { ok: false, reason: 'id' }
  if (Math.abs(now - auth.ts) > maxSkewMs) return { ok: false, reason: 'stale' }
  let sig: Uint8Array
  try {
    sig = fromBase64Url(auth.sig)
  } catch {
    return { ok: false, reason: 'signature' }
  }
  if (!verify(auth.pub, authBytes(auth.id, auth.ts, nonce), sig)) return { ok: false, reason: 'signature' }
  return { ok: true, id: auth.id, pub: auth.pub }
}
