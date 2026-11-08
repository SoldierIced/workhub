// A long-term identity for one end (the desktop, or one phone): a 32-byte seed that derives an
// Ed25519 key for signatures (proving who speaks to the relay, accepting a pairing) and an X25519
// key for key agreement (the encrypted channel, sealed boxes). The seed is what the host stores;
// the fingerprint names the identity everywhere else.
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes, toBase64Url, fromBase64Url, utf8ToBytes, bytesToHex } from './bytes'

export interface PublicIdentity {
  /** base64url of the Ed25519 public key (32 bytes). */
  sign: string
  /** base64url of the X25519 public key (32 bytes). */
  dh: string
}

export interface Identity {
  seed: Uint8Array
  signSecret: Uint8Array
  dhSecret: Uint8Array
  public: PublicIdentity
  /** Names the identity: `fingerprintOf(public)`. */
  id: string
}

const SEED_BYTES = 32

export function generateSeed(): Uint8Array {
  return randomBytes(SEED_BYTES)
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== SEED_BYTES) throw new Error('an identity seed has 32 bytes')
  const signSecret = hkdf(sha256, seed, undefined, utf8ToBytes('workhub-remote/identity/sign'), 32)
  const dhSecret = hkdf(sha256, seed, undefined, utf8ToBytes('workhub-remote/identity/dh'), 32)
  const pub: PublicIdentity = { sign: toBase64Url(ed25519.getPublicKey(signSecret)), dh: toBase64Url(x25519.getPublicKey(dhSecret)) }
  return { seed, signSecret, dhSecret, public: pub, id: fingerprintOf(pub) }
}

export function generateIdentity(): Identity {
  return identityFromSeed(generateSeed())
}

/** 32 hex characters (the first 128 bits of SHA-256 over both public keys): the identity's name on the wire. */
export function fingerprintOf(pub: PublicIdentity): string {
  const digest = sha256(concatBytes(utf8ToBytes('workhub-remote/fingerprint'), publicKeyBytes(pub.sign), publicKeyBytes(pub.dh)))
  return bytesToHex(digest.subarray(0, 16))
}

/** The fingerprint as people compare it: eight groups of four, upper case. */
export function displayFingerprint(id: string): string {
  return (id.match(/.{1,4}/g) ?? []).join(' ').toUpperCase()
}

export function publicKeyBytes(encoded: string): Uint8Array {
  const bytes = fromBase64Url(encoded)
  if (bytes.length !== 32) throw new Error('a public key has 32 bytes')
  return bytes
}

export function isPublicIdentity(value: unknown): value is PublicIdentity {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  try {
    return typeof v['sign'] === 'string' && typeof v['dh'] === 'string' && publicKeyBytes(v['sign']).length === 32 && publicKeyBytes(v['dh']).length === 32
  } catch {
    return false
  }
}

export function sign(identity: Identity, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, identity.signSecret)
}

export function verify(pub: PublicIdentity, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKeyBytes(pub.sign))
  } catch {
    return false
  }
}
