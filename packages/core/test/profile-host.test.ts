import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, ConfigParseError, hostIdOf, hostOfProfile, isWslDistroName, parseConfig } from '../src'

const withProfile = (extra: Record<string, unknown>) => ({ version: CONFIG_VERSION, profiles: [{ id: 'p1', name: 'Acme', ...extra }] })

describe('profile host', () => {
  it('loads a profile without a host unchanged, and it runs on this computer', () => {
    const parsed = parseConfig(withProfile({}))
    expect(parsed.profiles[0]!.host).toBeUndefined()
    expect(hostOfProfile(parsed.profiles[0]!)).toEqual({ kind: 'local' })
    expect(hostIdOf(hostOfProfile(parsed.profiles[0]!))).toBe('local')
  })

  it('reads and round-trips a local or a WSL host', () => {
    for (const host of [{ kind: 'local' }, { kind: 'wsl', distro: 'Ubuntu-24.04' }]) {
      const parsed = parseConfig(withProfile({ host }))
      expect(parsed.profiles[0]!.host).toEqual(host)
      expect(parseConfig(JSON.parse(JSON.stringify(parsed))).profiles[0]!.host).toEqual(host)
    }
    expect(hostIdOf({ kind: 'wsl', distro: 'Ubuntu-24.04' })).toBe('wsl:Ubuntu-24.04')
    expect(hostIdOf({ kind: 'local' })).toBe('local')
  })

  it('refuses a WSL host whose distribution is no valid name, or an unknown kind', () => {
    for (const host of [{ kind: 'wsl', distro: '' }, { kind: 'wsl', distro: '..' }, { kind: 'wsl', distro: 'a/b' }, { kind: 'wsl', distro: 'Ubuntu 24' }, { kind: 'wsl' }, { kind: 'ssh', distro: 'x' }]) {
      expect(() => parseConfig(withProfile({ host })), JSON.stringify(host)).toThrow(ConfigParseError)
    }
  })

  it('names distributions like the UNC path helpers do', () => {
    expect(['Ubuntu', 'Debian', 'Ubuntu-24.04', 'my_distro.1'].every(isWslDistroName)).toBe(true)
    expect(['', '.', '..', 'a b', 'a\\b', 'a/b'].some(isWslDistroName)).toBe(false)
  })
})
