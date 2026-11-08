import { describe, expect, it } from 'vitest'
import { generateIdentity, makeAuth, parseChannelMessage, parseClientMessage, parsePushPayload, parseRelayMessage, reconnectDelayMs, verifyAuth } from '../src'

describe('relay auth', () => {
  const me = generateIdentity()
  const NOW = 1_800_000_000_000

  it('accepts a fresh signed auth and parses it as a client message', () => {
    const auth = makeAuth(me, NOW)
    expect(parseClientMessage(auth)).toEqual(auth)
    expect(verifyAuth(auth, NOW + 1000)).toEqual({ ok: true, id: me.id, pub: me.public })
  })

  it('refuses a stale, forged or mismatched auth', () => {
    const auth = makeAuth(me, NOW)
    expect(verifyAuth(auth, NOW + 10 * 60_000)).toEqual({ ok: false, reason: 'stale' })
    expect(verifyAuth({ ...auth, id: generateIdentity().id }, NOW)).toEqual({ ok: false, reason: 'id' })
    expect(verifyAuth({ ...auth, ts: NOW + 1 }, NOW)).toEqual({ ok: false, reason: 'signature' })
    expect(verifyAuth({ ...auth, sig: '!!' }, NOW)).toEqual({ ok: false, reason: 'signature' })
    const other = generateIdentity()
    expect(verifyAuth({ ...makeAuth(other, NOW), id: me.id, pub: me.public }, NOW)).toEqual({ ok: false, reason: 'signature' })
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
    expect(parsePushPayload({ v: 1, kind: 'permission', title: 'Claude asks', body: 'npm test', ts: 1 })).not.toBeNull()
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
