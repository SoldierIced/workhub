import { describe, expect, it } from 'vitest'
import {
  acceptPairing,
  answerPairingOffer,
  decodePairingOffer,
  encodePairingOffer,
  generateIdentity,
  makePairingOffer,
  offerFromLink,
  pairingLink,
  verifyPairAccept,
  verifyPairRequest
} from '../src'

const NOW = 1_800_000_000_000

describe('pairing', () => {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  const offer = makePairingOffer(desktop, 'wss://relay.example.com/ws', "Ana's MacBook", NOW)

  it('encodes the offer for a QR and reads it back from the link fragment', () => {
    expect(offer.exp).toBe(NOW + 5 * 60_000)
    expect(decodePairingOffer(encodePairingOffer(offer))).toEqual(offer)
    const link = pairingLink('https://remote.example.com/app/#home', offer)
    expect(link.startsWith('https://remote.example.com/app/#pair=')).toBe(true)
    expect(offerFromLink(link)).toEqual(offer)
    expect(offerFromLink('https://remote.example.com/')).toBeNull()
    expect(decodePairingOffer('AAAA')).toBeNull()
    expect(decodePairingOffer('not base64url!')).toBeNull()
  })

  it('accepts a request made with the secret from the QR, before the offer expires', () => {
    const request = answerPairingOffer(phone, offer, 'Ana’s phone', 'ios')
    expect(verifyPairRequest(offer, request, NOW + 1000)).toEqual({ ok: true, deviceId: phone.id })
    expect(verifyPairRequest(offer, request, NOW + 6 * 60_000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a request without the secret, for another desktop, or malformed', () => {
    const otherOffer = makePairingOffer(desktop, 'wss://relay.example.com/ws', "Ana's MacBook", NOW)
    const forOther = answerPairingOffer(phone, otherOffer, 'phone', 'ios')
    expect(verifyPairRequest(offer, forOther, NOW)).toEqual({ ok: false, reason: 'proof' })
    const request = answerPairingOffer(phone, offer, 'phone', 'ios')
    expect(verifyPairRequest(offer, { ...request, device: generateIdentity().public }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { ...request, proof: '!!' }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { v: 1 }, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyPairRequest(offer, null, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('signs the accept so the device knows it came from the desktop in the QR, with these capabilities', () => {
    const accept = acceptPairing(desktop, phone.public, "Ana's MacBook", ['sessions', 'health'])
    expect(verifyPairAccept(offer, phone, accept)).toEqual(accept)
    expect(verifyPairAccept(offer, phone, { ...accept, capabilities: ['sessions', 'health', 'pullRequests'] })).toBeNull()
    expect(verifyPairAccept(offer, generateIdentity(), accept)).toBeNull()
    const impostor = generateIdentity()
    expect(verifyPairAccept(offer, phone, acceptPairing(impostor, phone.public, 'x', ['sessions']))).toBeNull()
    expect(verifyPairAccept(offer, phone, { ...accept, sig: 'AAAA' })).toBeNull()
    expect(verifyPairAccept(offer, phone, 'junk')).toBeNull()
  })
})
