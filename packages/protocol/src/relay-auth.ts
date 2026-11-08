// How a client proves its identity to the relay: a signature over a fresh timestamp. The relay
// checks the public keys hash to the claimed id, the signature, and that the timestamp is recent.
import { encodeJson, fromBase64Url, toBase64Url } from './bytes'
import { fingerprintOf, sign, verify, type Identity, type PublicIdentity } from './identity'
import type { ClientMessage } from './messages'
import { PROTOCOL_VERSION } from './messages'

export const AUTH_MAX_SKEW_MS = 5 * 60_000

function authBytes(id: string, ts: number): Uint8Array {
  return encodeJson(['workhub-relay/auth', id, ts])
}

export function makeAuth(me: Identity, now = Date.now()): Extract<ClientMessage, { t: 'auth' }> {
  return { t: 'auth', v: PROTOCOL_VERSION, id: me.id, pub: me.public, ts: now, sig: toBase64Url(sign(me, authBytes(me.id, now))) }
}

export type AuthVerdict = { ok: true; id: string; pub: PublicIdentity } | { ok: false; reason: 'id' | 'signature' | 'stale' }

export function verifyAuth(auth: Extract<ClientMessage, { t: 'auth' }>, now = Date.now(), maxSkewMs = AUTH_MAX_SKEW_MS): AuthVerdict {
  if (fingerprintOf(auth.pub) !== auth.id) return { ok: false, reason: 'id' }
  if (Math.abs(now - auth.ts) > maxSkewMs) return { ok: false, reason: 'stale' }
  let sig: Uint8Array
  try {
    sig = fromBase64Url(auth.sig)
  } catch {
    return { ok: false, reason: 'signature' }
  }
  if (!verify(auth.pub, authBytes(auth.id, auth.ts), sig)) return { ok: false, reason: 'signature' }
  return { ok: true, id: auth.id, pub: auth.pub }
}
