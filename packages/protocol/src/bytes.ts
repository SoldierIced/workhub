// Byte helpers shared by Node and the browser: base64url (what travels in JSON and QR codes) and hex.
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes }

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Constant-time comparison: a mismatch takes as long as a match. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    if (c !== undefined) out += B64[c & 63]!
  }
  return out
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    buffer = (buffer << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}

/** JSON as bytes, for signing and encrypting structured messages. */
export function encodeJson(value: unknown): Uint8Array {
  return utf8ToBytes(JSON.stringify(value))
}

export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(bytesToUtf8(bytes))
}
