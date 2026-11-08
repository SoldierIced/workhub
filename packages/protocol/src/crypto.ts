// Symmetric primitives: XChaCha20-Poly1305 with keys from HKDF-SHA256, and sealed boxes (encrypt
// to a public key with an ephemeral one) for messages that cannot wait for a live channel, like a
// push notification to a phone that is offline.
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, randomBytes, utf8ToBytes, toBase64Url, fromBase64Url } from './bytes'
import { publicKeyBytes, type Identity, type PublicIdentity } from './identity'

export const NONCE_BYTES = 24
export const KEY_BYTES = 32

export function deriveKey(ikm: Uint8Array, salt: Uint8Array | undefined, info: string, length = KEY_BYTES): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8ToBytes(info), length)
}

/** nonce ‖ ciphertext ‖ tag, with `aad` authenticated but not sent. */
export function encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES)
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
  return concatBytes(nonce, sealed)
}

/** The plaintext, or null when the key, nonce, tag or aad do not match. Never throws. */
export function decrypt(key: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array | null {
  if (sealed.length < NONCE_BYTES + 16) return null
  try {
    return xchacha20poly1305(key, sealed.subarray(0, NONCE_BYTES), aad).decrypt(sealed.subarray(NONCE_BYTES))
  } catch {
    return null
  }
}

export interface SealedBox {
  /** base64url of the sender's ephemeral X25519 public key. */
  e: string
  /** base64url of nonce ‖ ciphertext ‖ tag. */
  c: string
}

const BOX_INFO = 'workhub-remote/box/v1'

/**
 * Encrypts to `to` so that only its X25519 secret opens it. The sender stays anonymous at this
 * layer (the ephemeral key says nothing); the content carries who sent it when that matters.
 */
export function sealBox(to: PublicIdentity, plaintext: Uint8Array): SealedBox {
  const eSecret = x25519.utils.randomSecretKey()
  const ePublic = x25519.getPublicKey(eSecret)
  const recipient = publicKeyBytes(to.dh)
  const shared = x25519.getSharedSecret(eSecret, recipient)
  const key = deriveKey(shared, concatBytes(ePublic, recipient), BOX_INFO)
  return { e: toBase64Url(ePublic), c: toBase64Url(encrypt(key, plaintext, ePublic)) }
}

export function openBox(me: Identity, box: SealedBox): Uint8Array | null {
  try {
    const ePublic = fromBase64Url(box.e)
    if (ePublic.length !== 32) return null
    const recipient = publicKeyBytes(me.public.dh)
    const shared = x25519.getSharedSecret(me.dhSecret, ePublic)
    const key = deriveKey(shared, concatBytes(ePublic, recipient), BOX_INFO)
    return decrypt(key, fromBase64Url(box.c), ePublic)
  } catch {
    return null
  }
}
