import { describe, expect, it } from 'vitest'
import { generateIdentity, startHandshake } from '../src'

function pair() {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  const i = startHandshake(phone, desktop.public, 'initiator')
  const r = startHandshake(desktop, phone.public, 'responder')
  return { desktop, phone, phoneChannel: i.finish(r.hello), desktopChannel: r.finish(i.hello) }
}

describe('SecureChannel', () => {
  it('carries messages both ways once both ends finish the handshake', () => {
    const { phoneChannel, desktopChannel } = pair()
    expect(desktopChannel.open(phoneChannel.seal({ t: 'invoke', id: 1, channel: 'sessions:list', args: [] }))).toEqual({ t: 'invoke', id: 1, channel: 'sessions:list', args: [] })
    expect(phoneChannel.open(desktopChannel.seal({ t: 'result', id: 1, ok: true, value: [] }))).toEqual({ t: 'result', id: 1, ok: true, value: [] })
    expect(desktopChannel.open(phoneChannel.seal('second'))).toBe('second')
  })

  it('refuses a replayed, reordered or tampered message', () => {
    const { phoneChannel, desktopChannel } = pair()
    const first = phoneChannel.seal(1)
    const second = phoneChannel.seal(2)
    expect(desktopChannel.open(second)).toBeNull()
    expect(desktopChannel.open(first)).toBe(1)
    expect(desktopChannel.open(first)).toBeNull()
    expect(desktopChannel.open(second)).toBe(2)
    expect(desktopChannel.open('not base64url!')).toBeNull()
    expect(desktopChannel.open(phoneChannel.seal(3).slice(0, -4) + 'AAAA')).toBeNull()
  })

  it('leaves a stranger who only knows the public identities with keys that open nothing', () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()
    const stranger = generateIdentity()
    // The stranger claims to be the phone (uses the phone's public identity as what the desktop expects).
    const fake = startHandshake(stranger, desktop.public, 'initiator')
    const r = startHandshake(desktop, phone.public, 'responder')
    const strangerChannel = fake.finish(r.hello)
    const desktopChannel = r.finish(fake.hello)
    expect(desktopChannel.open(strangerChannel.seal('let me in'))).toBeNull()
    expect(strangerChannel.open(desktopChannel.seal('hello'))).toBeNull()
  })

  it('gives every connection its own keys', () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()
    const first = startHandshake(phone, desktop.public, 'initiator')
    const second = startHandshake(phone, desktop.public, 'initiator')
    expect(first.hello.e).not.toBe(second.hello.e)
  })

  it('rejects a malformed hello', () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()
    expect(() => startHandshake(phone, desktop.public, 'initiator').finish({ e: 'AAAA' })).toThrow(/bad hello/)
  })
})
