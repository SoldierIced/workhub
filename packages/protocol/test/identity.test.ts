import { describe, expect, it } from 'vitest'
import { displayFingerprint, fingerprintOf, generateIdentity, identityFromSeed, isPublicIdentity, sign, verify, utf8ToBytes, toBase64Url, fromBase64Url, equalBytes } from '../src'

describe('identity', () => {
  it('derives the same keys and fingerprint from the same seed', () => {
    const seed = new Uint8Array(32).fill(7)
    const a = identityFromSeed(seed)
    const b = identityFromSeed(seed)
    expect(a.public).toEqual(b.public)
    expect(a.id).toBe(b.id)
    expect(a.id).toMatch(/^[0-9a-f]{32}$/)
    expect(fingerprintOf(a.public)).toBe(a.id)
    expect(displayFingerprint(a.id)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
  })

  it('gives different identities different fingerprints and separate sign and dh keys', () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(a.id).not.toBe(b.id)
    expect(a.public.sign).not.toBe(a.public.dh)
    expect(isPublicIdentity(a.public)).toBe(true)
    expect(isPublicIdentity({ sign: 'short', dh: a.public.dh })).toBe(false)
    expect(isPublicIdentity(null)).toBe(false)
  })

  it('rejects seeds of the wrong size', () => {
    expect(() => identityFromSeed(new Uint8Array(16))).toThrow(/32 bytes/)
  })

  it('signs and verifies, and refuses a signature by another identity or over another message', () => {
    const me = generateIdentity()
    const other = generateIdentity()
    const message = utf8ToBytes('hello')
    const sig = sign(me, message)
    expect(verify(me.public, message, sig)).toBe(true)
    expect(verify(other.public, message, sig)).toBe(false)
    expect(verify(me.public, utf8ToBytes('hullo'), sig)).toBe(false)
    expect(verify(me.public, message, new Uint8Array(3))).toBe(false)
  })
})

describe('bytes', () => {
  it('round-trips base64url without padding', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)
      const text = toBase64Url(bytes)
      expect(text).not.toContain('=')
      expect(fromBase64Url(text)).toEqual(bytes)
    }
    expect(() => fromBase64Url('a+b/')).toThrow(/base64url/)
  })

  it('compares bytes', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false)
  })
})
