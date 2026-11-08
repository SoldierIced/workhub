// A pushed notification travels sealed to the device, but a sealed box does not say who made it:
// the relay knows every device's public keys. The desktop signs the payload, and the device
// checks the signature against the desktop it paired with before showing anything.
import { encodeJson, fromBase64Url, toBase64Url } from './bytes'
import { sign, verify, type Identity, type PublicIdentity } from './identity'
import type { PushPayload, UnsignedPushPayload } from './messages'

/** At most this old (or this far in the future) to be shown: a relay cannot replay last week's. */
export const PUSH_MAX_AGE_MS = 10 * 60_000

function payloadBytes(payload: UnsignedPushPayload): Uint8Array {
  // A fixed field order, so both ends sign the same bytes whatever the JSON looked like.
  return encodeJson(['workhub-remote/push', payload.v, payload.desktop, payload.kind, payload.title, payload.body, payload.ts, payload.route ?? null, payload.tag ?? null])
}

export function signPushPayload(desktop: Identity, payload: UnsignedPushPayload): PushPayload {
  return { ...payload, sig: toBase64Url(sign(desktop, payloadBytes(payload))) }
}

/** Whether the desktop named in the payload signed it, and it is recent. */
export function verifyPushPayload(payload: PushPayload, desktop: PublicIdentity, now = Date.now(), maxAgeMs = PUSH_MAX_AGE_MS): boolean {
  if (Math.abs(now - payload.ts) > maxAgeMs) return false
  const { sig, ...rest } = payload
  try {
    return verify(desktop, payloadBytes(rest), fromBase64Url(sig))
  } catch {
    return false
  }
}
