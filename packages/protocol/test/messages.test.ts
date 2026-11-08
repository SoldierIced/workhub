import { describe, expect, it } from 'vitest'
import { generateIdentity, makeAuth, makeChallenge, parseChannelMessage, parseClientMessage, parsePushPayload, parseRelayMessage, reconnectDelayMs, signPushPayload, verifyAuth, verifyPushPayload } from '../src'

describe('relay auth', () => {
  const me = generateIdentity()
  const NOW = 1_800_000_000_000
  const nonce = makeChallenge()

  it('accepts a fresh signed auth over the relay nonce and parses it as a client message', () => {
    const auth = makeAuth(me, nonce, NOW)
    expect(parseClientMessage(auth)).toEqual(auth)
    expect(verifyAuth(auth, nonce, NOW + 1000)).toEqual({ ok: true, id: me.id, pub: me.public })
  })

  it('refuses a stale, forged, mismatched or replayed auth', () => {
    const auth = makeAuth(me, nonce, NOW)
    expect(verifyAuth(auth, nonce, NOW + 10 * 60_000)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyAuth({ ...auth, id: generateIdentity().id }, nonce, NOW)).toEqual({ ok: false, reason: 'id' })
    expect(verifyAuth({ ...auth, ts: NOW + 1 }, nonce, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyAuth({ ...auth, sig: 'A'.repeat(86) }, nonce, NOW)).toEqual({ ok: false, reason: 'signature' })
    const other = generateIdentity()
    expect(verifyAuth({ ...makeAuth(other, nonce, NOW), id: me.id, pub: me.public }, nonce, NOW)).toEqual({ ok: false, reason: 'signature' })
    // Captured on one connection (or one relay), replayed on another: the nonce differs.
    expect(verifyAuth(auth, makeChallenge(), NOW)).toEqual({ ok: false, reason: 'nonce' })
    expect(verifyAuth({ ...auth, nonce: makeChallenge() }, nonce, NOW)).toEqual({ ok: false, reason: 'nonce' })
  })
})

describe('push payload signature', () => {
  const desktop = generateIdentity()
  const NOW = 1_800_000_000_000
  const payload = { v: 1 as const, kind: 'permission', title: 'Claude asks', body: 'npm test', ts: NOW, desktop: desktop.id, route: '#session/s1' }

  it('verifies the desktop that signed it, within the age window', () => {
    const signed = signPushPayload(desktop, payload)
    expect(parsePushPayload(signed)).toEqual(signed)
    expect(verifyPushPayload(signed, desktop.public, NOW + 1000)).toBe(true)
    expect(verifyPushPayload(signed, generateIdentity().public, NOW)).toBe(false)
    expect(verifyPushPayload({ ...signed, title: 'Tap to approve' }, desktop.public, NOW)).toBe(false)
    expect(verifyPushPayload({ ...signed, route: '#settings' }, desktop.public, NOW)).toBe(false)
    expect(verifyPushPayload(signed, desktop.public, NOW + 11 * 60_000)).toBe(false)
    expect(verifyPushPayload({ ...signed, sig: '!!' }, desktop.public, NOW)).toBe(false)
  })
})

describe('schemas', () => {
  const id = 'a'.repeat(32)
  const e = 'A'.repeat(43)

  it('parses the client, relay and channel messages and refuses junk', () => {
    expect(parseClientMessage({ t: 'join', room: id })).toEqual({ t: 'join', room: id })
    expect(parseClientMessage({ t: 'to', room: id, to: id, body: { k: 'enc', c: 'abc' } })).not.toBeNull()
    expect(parseClientMessage({ t: 'to', room: id, to: id, body: { k: 'hs', e } })).not.toBeNull()
    expect(parseClientMessage({ t: 'to', room: id, to: id, body: { k: 'hs', e: 'short' } })).toBeNull()
    expect(parseClientMessage({ t: 'to', room: 'nope', to: id, body: { k: 'enc', c: 'abc' } })).toBeNull()
    expect(parseClientMessage({ t: 'push', room: id, to: id, box: { e, c: 'abc' } })).not.toBeNull()
    expect(parseClientMessage({ t: 'hack' })).toBeNull()
    expect(parseRelayMessage({ t: 'welcome', id, now: 1 })).not.toBeNull()
    expect(parseRelayMessage({ t: 'error', code: 'offline', message: 'the desktop is offline' })).not.toBeNull()
    expect(parseRelayMessage({ t: 'error', code: 'weird', message: '' })).toBeNull()
    expect(parseChannelMessage({ t: 'invoke', id: 1, channel: 'sessions:list', args: [] })).not.toBeNull()
    expect(parseChannelMessage({ t: 'result', id: 1, ok: false, error: 'nope' })).not.toBeNull()
    expect(parseChannelMessage({ t: 'result', id: 1, ok: true })).toEqual({ t: 'result', id: 1, ok: true })
    expect(parseChannelMessage({ t: 'event', channel: 'session:changed', args: [{ id: 's1' }] })).not.toBeNull()
    expect(parseChannelMessage({ t: 'invoke', id: -1, channel: 'x', args: [] })).toBeNull()
    expect(parseChannelMessage({ t: 'unpair' })).toEqual({ t: 'unpair' })
    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) } }
    expect(parseClientMessage({ t: 'push.subscribe', sub })).not.toBeNull()
    expect(parseClientMessage({ t: 'push.subscribe', sub: { ...sub, endpoint: 'http://10.0.0.5/' } })).toBeNull()
    expect(parseClientMessage({ t: 'push.subscribe', sub: { ...sub, keys: { p256dh: 'p', auth: 'a' } } })).toBeNull()
    expect(parseRelayMessage({ t: 'challenge', nonce: 'B'.repeat(43) })).not.toBeNull()
    expect(parseClientMessage({ t: 'to', room: id, to: id, body: { k: 'enc', c: 'A'.repeat(800_000) } })).toBeNull()
    expect(parsePushPayload({ v: 1, kind: 'permission', title: 'Claude asks', body: 'npm test', ts: 1, desktop: id, sig: 'A'.repeat(86) })).not.toBeNull()
    // Unsigned, or without the desktop that sent it: refused.
    expect(parsePushPayload({ v: 1, kind: 'permission', title: 'Claude asks', body: 'npm test', ts: 1 })).toBeNull()
    expect(parsePushPayload({ v: 2 })).toBeNull()
  })
})

describe('reconnectDelayMs', () => {
  it('backs off from a second to half a minute with bounded jitter', () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1000)
    expect(reconnectDelayMs(1, () => 0.5)).toBe(2000)
    expect(reconnectDelayMs(3, () => 0.5)).toBe(8000)
    expect(reconnectDelayMs(20, () => 0.5)).toBe(30_000)
    expect(reconnectDelayMs(20, () => 0)).toBe(22_500)
    expect(reconnectDelayMs(20, () => 0.999)).toBeLessThanOrEqual(37_500)
    expect(reconnectDelayMs(-3, () => 0.5)).toBe(1000)
  })
})
