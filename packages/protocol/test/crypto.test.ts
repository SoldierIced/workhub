import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, generateIdentity, openBox, sealBox, utf8ToBytes, bytesToUtf8, deriveKey } from '../src'

describe('encrypt / decrypt', () => {
  const key = deriveKey(new Uint8Array(32).fill(1), undefined, 'test')

  it('round-trips with a fresh nonce each time', () => {
    const a = encrypt(key, utf8ToBytes('same'))
    const b = encrypt(key, utf8ToBytes('same'))
    expect(a).not.toEqual(b)
    expect(bytesToUtf8(decrypt(key, a)!)).toBe('same')
    expect(bytesToUtf8(decrypt(key, b)!)).toBe('same')
  })

  it('returns null for a tampered message, another key, another aad, or garbage', () => {
    const sealed = encrypt(key, utf8ToBytes('secret'), utf8ToBytes('ctx'))
    expect(decrypt(key, sealed, utf8ToBytes('ctx'))).not.toBeNull()
    const tampered = Uint8Array.from(sealed)
    tampered[tampered.length - 1]! ^= 1
    expect(decrypt(key, tampered, utf8ToBytes('ctx'))).toBeNull()
    expect(decrypt(key, sealed, utf8ToBytes('other'))).toBeNull()
    expect(decrypt(deriveKey(new Uint8Array(32).fill(2), undefined, 'test'), sealed, utf8ToBytes('ctx'))).toBeNull()
    expect(decrypt(key, new Uint8Array(5))).toBeNull()
  })
})

describe('sealed boxes', () => {
  it('opens only for the recipient', () => {
    const phone = generateIdentity()
    const other = generateIdentity()
    const box = sealBox(phone.public, utf8ToBytes('a push for the phone'))
    expect(bytesToUtf8(openBox(phone, box)!)).toBe('a push for the phone')
    expect(openBox(other, box)).toBeNull()
    expect(openBox(phone, { e: box.e, c: box.c.slice(0, -2) + 'AA' })).toBeNull()
    expect(openBox(phone, { e: 'nope', c: box.c })).toBeNull()
  })
})
