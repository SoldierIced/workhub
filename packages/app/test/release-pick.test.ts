import { describe, expect, it } from 'vitest'
import { pickReleaseTag } from '../src/main/release-pick'

const r = (tag_name: string, draft: boolean, prerelease: boolean, assets: string[]) => ({ tag_name, draft, prerelease, assets: assets.map((name) => ({ name })) })
const full = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'Acme-1.0.0.dmg']

describe('pickReleaseTag', () => {
  it('skips drafts and releases whose installers are not uploaded yet', () => {
    const releases = [r('v1.2.0', true, true, full), r('v1.1.0', false, true, []), r('v1.0.0', false, true, full)]
    expect(pickReleaseTag(releases, { prerelease: true, platform: 'darwin' })).toBe('v1.0.0')
  })
  it('needs the manifest of the platform that asks', () => {
    const releases = [r('v1.1.0', false, false, ['latest-mac.yml']), r('v1.0.0', false, false, full)]
    expect(pickReleaseTag(releases, { prerelease: false, platform: 'win32' })).toBe('v1.0.0')
    expect(pickReleaseTag(releases, { prerelease: false, platform: 'darwin' })).toBe('v1.1.0')
  })
  it('offers pre-releases only to pre-release builds', () => {
    const releases = [r('v2.0.0-alpha.1', false, true, full), r('v1.0.0', false, false, full)]
    expect(pickReleaseTag(releases, { prerelease: false, platform: 'linux' })).toBe('v1.0.0')
    expect(pickReleaseTag(releases, { prerelease: true, platform: 'linux' })).toBe('v2.0.0-alpha.1')
  })
  it('returns nothing for an unknown platform or an empty list', () => {
    expect(pickReleaseTag([], { prerelease: true, platform: 'darwin' })).toBeUndefined()
    expect(pickReleaseTag([r('v1.0.0', false, false, full)], { prerelease: true, platform: 'freebsd' })).toBeUndefined()
  })
})
