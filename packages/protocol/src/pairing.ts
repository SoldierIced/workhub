// Pairing a device with a desktop, once. The desktop shows a QR with an offer (its identity, the
// relay, a one-time secret, an expiry). The device answers through the relay with a request that
// proves it saw the QR (an HMAC with the secret); the person confirms the device's name and
// fingerprint on the desktop, and the desktop answers with what it granted. From then on both
// ends know each other's identity and connect without pairing again.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import { concatBytes, decodeJson, encodeJson, equalBytes, fromBase64Url, randomBytes, toBase64Url, utf8ToBytes } from './bytes'
import { fingerprintOf, sign, verify, isPublicIdentity, type Identity, type PublicIdentity } from './identity'

const publicIdentitySchema = z.custom<PublicIdentity>(isPublicIdentity, 'a public identity')

export const pairingOfferSchema = z.object({
  v: z.literal(1),
  /** The relay's WebSocket URL. */
  relay: z.string().url(),
  desktop: publicIdentitySchema,
  /** What the desktop calls itself ("Ana's MacBook"). */
  name: z.string().min(1).max(80),
  /** base64url of 32 random bytes; proves the device saw this QR. */
  secret: z.string().min(40).max(48),
  /** Unix ms after which the offer is void. */
  exp: z.number().int().positive()
})
export type PairingOffer = z.infer<typeof pairingOfferSchema>

export const remoteCapabilitySchema = z.enum(['sessions', 'pullRequests', 'automations', 'health'])
export type RemoteCapability = z.infer<typeof remoteCapabilitySchema>

export const pairRequestSchema = z.object({
  v: z.literal(1),
  device: publicIdentitySchema,
  name: z.string().min(1).max(80),
  platform: z.enum(['ios', 'android', 'web', 'other']),
  /** base64url HMAC-SHA256(secret, "workhub-remote/pair" ‖ deviceId ‖ desktopId). */
  proof: z.string()
})
export type PairRequest = z.infer<typeof pairRequestSchema>

export const pairAcceptSchema = z.object({
  v: z.literal(1),
  desktop: publicIdentitySchema,
  name: z.string().min(1).max(80),
  capabilities: z.array(remoteCapabilitySchema),
  /** base64url Ed25519 signature by the desktop over "workhub-remote/accept" ‖ deviceId ‖ desktopId ‖ capabilities. */
  sig: z.string()
})
export type PairAccept = z.infer<typeof pairAcceptSchema>

export const DEFAULT_OFFER_TTL_MS = 5 * 60_000

export function makePairingOffer(me: Identity, relay: string, name: string, now = Date.now(), ttlMs = DEFAULT_OFFER_TTL_MS): PairingOffer {
  return { v: 1, relay, desktop: me.public, name, secret: toBase64Url(randomBytes(32)), exp: now + ttlMs }
}

/** The offer as the QR carries it (base64url JSON); goes in a URL fragment so no server sees it. */
export function encodePairingOffer(offer: PairingOffer): string {
  return toBase64Url(encodeJson(offer))
}

export function decodePairingOffer(encoded: string): PairingOffer | null {
  try {
    const parsed = pairingOfferSchema.safeParse(decodeJson(fromBase64Url(encoded)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The link the QR shows: the web client, with the offer in the fragment. */
export function pairingLink(webClientUrl: string, offer: PairingOffer): string {
  const base = webClientUrl.replace(/#.*$/, '')
  return `${base}#pair=${encodePairingOffer(offer)}`
}

/** The offer in a pairing link, or null when the link has none. */
export function offerFromLink(link: string): PairingOffer | null {
  const match = /#pair=([A-Za-z0-9_-]+)/.exec(link)
  return match ? decodePairingOffer(match[1]!) : null
}

function proofBytes(offer: PairingOffer, device: PublicIdentity): Uint8Array {
  return hmac(sha256, fromBase64Url(offer.secret), concatBytes(utf8ToBytes('workhub-remote/pair'), utf8ToBytes(fingerprintOf(device)), utf8ToBytes(fingerprintOf(offer.desktop))))
}

export function answerPairingOffer(me: Identity, offer: PairingOffer, name: string, platform: PairRequest['platform']): PairRequest {
  return { v: 1, device: me.public, name, platform, proof: toBase64Url(proofBytes(offer, me.public)) }
}

export type PairRequestVerdict = { ok: true; deviceId: string } | { ok: false; reason: 'expired' | 'proof' | 'malformed' }

/** Whether a request answers this offer: made before it expired, with the secret only the QR had. */
export function verifyPairRequest(offer: PairingOffer, request: unknown, now = Date.now()): PairRequestVerdict {
  const parsed = pairRequestSchema.safeParse(request)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  if (now > offer.exp) return { ok: false, reason: 'expired' }
  let proof: Uint8Array
  try {
    proof = fromBase64Url(parsed.data.proof)
  } catch {
    return { ok: false, reason: 'proof' }
  }
  const expected = proofBytes(offer, parsed.data.device)
  if (proof.length !== expected.length || !equalBytes(proof, expected)) return { ok: false, reason: 'proof' }
  return { ok: true, deviceId: fingerprintOf(parsed.data.device) }
}

function acceptBytes(device: PublicIdentity, desktop: PublicIdentity, capabilities: RemoteCapability[]): Uint8Array {
  return encodeJson(['workhub-remote/accept', fingerprintOf(device), fingerprintOf(desktop), [...capabilities].sort()])
}

export function acceptPairing(me: Identity, device: PublicIdentity, name: string, capabilities: RemoteCapability[]): PairAccept {
  return { v: 1, desktop: me.public, name, capabilities, sig: toBase64Url(sign(me, acceptBytes(device, me.public, capabilities))) }
}

/** Whether an accept came from the desktop the offer named, for this device. */
export function verifyPairAccept(offer: PairingOffer, me: Identity, accept: unknown): PairAccept | null {
  const parsed = pairAcceptSchema.safeParse(accept)
  if (!parsed.success) return null
  if (fingerprintOf(parsed.data.desktop) !== fingerprintOf(offer.desktop)) return null
  try {
    if (!verify(parsed.data.desktop, acceptBytes(me.public, parsed.data.desktop, parsed.data.capabilities), fromBase64Url(parsed.data.sig))) return null
  } catch {
    return null
  }
  return parsed.data
}
