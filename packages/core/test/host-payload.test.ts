import { describe, expect, it } from 'vitest'
import { hostPayloadManifest, hostPayloadName, hostPayloadUrls, hostVersionsToPrune, payloadChecksum } from '../src'

const HASH = 'ab'.repeat(32)

describe('the Linux host payload', () => {
  it('names the archive by version and arch', () => {
    expect(hostPayloadName('2.0.0-alpha.3', 'x64')).toBe('workhub-host-2.0.0-alpha.3-linux-x64.tar.gz')
    expect(hostPayloadName('2.1.0', 'arm64')).toBe('workhub-host-2.1.0-linux-arm64.tar.gz')
    expect(() => hostPayloadName('../2.1.0', 'x64')).toThrow(/not a host version/)
    expect(() => hostPayloadName('2.1.0', 'ia32' as 'x64')).toThrow(/architecture/)
  })

  it('finds the archive and its checksum in the release of the version', () => {
    expect(hostPayloadUrls('acme/workhub', '2.1.0', 'x64')).toEqual({
      archive: 'https://github.com/acme/workhub/releases/download/v2.1.0/workhub-host-2.1.0-linux-x64.tar.gz',
      checksum: 'https://github.com/acme/workhub/releases/download/v2.1.0/workhub-host-2.1.0-linux-x64.tar.gz.sha256'
    })
    expect(() => hostPayloadUrls('acme/workhub/../x', '2.1.0', 'x64')).toThrow(/repository/)
  })

  it('reads a sha256sum line for the file, or a lone hash', () => {
    const name = 'workhub-host-2.1.0-linux-x64.tar.gz'
    expect(payloadChecksum(`${HASH.toUpperCase()}  ${name}\n`, name)).toBe(HASH)
    expect(payloadChecksum(`${HASH}\n`, name)).toBe(HASH)
    expect(payloadChecksum(`${HASH}  other.tar.gz\n`, name)).toBeNull()
    expect(payloadChecksum('not a hash', name)).toBeNull()
  })

  it('writes a manifest without machine paths', () => {
    expect(hostPayloadManifest({ version: '2.1.0', arch: 'x64', node: '26.13.1', commit: 'cb8de8c7f3' })).toEqual({ version: '2.1.0', arch: 'x64', node: '26.13.1', createdFrom: 'git cb8de8c7f3' })
    expect(hostPayloadManifest({ version: '2.1.0', arch: 'arm64', node: '26.13.1', commit: '/w/acme' }).createdFrom).toBe('unknown')
  })

  it('prunes all but the current and the newest other version, and leftover staging folders', () => {
    expect(hostVersionsToPrune(['2.3.0', '.tmp-2.3.0-a1', '2.2.0', 'notes', '2.1.0', '.DS_Store', '2.0.0'], '2.3.0')).toEqual(['.tmp-2.3.0-a1', '2.1.0', '2.0.0'])
    // Newest first is by date: a downgrade keeps the version it came from.
    expect(hostVersionsToPrune(['2.3.0', '2.1.0', '2.2.0'], '2.1.0')).toEqual(['2.2.0'])
    expect(hostVersionsToPrune(['2.1.0'], '2.1.0')).toEqual([])
  })
})
