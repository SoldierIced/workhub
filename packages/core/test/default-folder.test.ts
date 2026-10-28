import { describe, expect, it } from 'vitest'
import { fillDefaultFolders, parseConfig, planWorkhub1Import, profileDefaultFolder, type Profile, type Workhub1Settings } from '../src'
import { config } from './fixtures'

const HOME = '/Users/ana'
const profile = (patch: Partial<Profile> = {}): Profile => ({ id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false }, ...patch })

describe('profileDefaultFolder', () => {
  it('is the default folder, home expanded, even outside the profile folders', () => {
    expect(profileDefaultFolder(profile({ folders: ['~/acme', '~/side'], defaultFolder: '~/side' }), HOME)).toBe('/Users/ana/side')
    expect(profileDefaultFolder(profile({ folders: ['~/acme'], defaultFolder: '/opt/scratch/' }), HOME)).toBe('/opt/scratch')
  })

  it('falls back to the first folder that is not blank', () => {
    expect(profileDefaultFolder(profile({ folders: ['  ', '~/acme', '~/side'] }), HOME)).toBe('/Users/ana/acme')
    expect(profileDefaultFolder(profile({ folders: ['~/acme'], defaultFolder: '  ' }), HOME)).toBe('/Users/ana/acme')
  })

  it('is undefined without a profile or folders (the caller uses home)', () => {
    expect(profileDefaultFolder(undefined, HOME)).toBeUndefined()
    expect(profileDefaultFolder(profile(), HOME)).toBeUndefined()
  })
})

describe('fillDefaultFolders', () => {
  it('gives profiles with folders and no default their first folder, and leaves the rest alone', () => {
    const changed = fillDefaultFolders([
      profile({ id: 'acme', folders: ['/Users/ana/acme', '/Users/ana/libs'] }),
      profile({ id: 'set', folders: ['/a', '/b'], defaultFolder: '/b' }),
      profile({ id: 'none' })
    ])
    expect(changed.map((p) => [p.id, p.defaultFolder])).toEqual([['acme', '/Users/ana/acme']])
  })
})

describe('defaultFolder in the config', () => {
  it('round-trips and rejects a blank one', () => {
    const base = config()
    const withDefault = { ...base, profiles: [profile({ folders: ['/a'], defaultFolder: '/a' })] }
    expect(parseConfig(JSON.parse(JSON.stringify(withDefault))).profiles[0]?.defaultFolder).toBe('/a')
    expect(() => parseConfig(JSON.parse(JSON.stringify({ ...base, profiles: [profile({ defaultFolder: ' ' })] })))).toThrow()
  })
})

describe('Workhub 1 import', () => {
  it('sets each imported profile default folder to its first folder', () => {
    const v1: Workhub1Settings = {
      profiles: [
        { id: 'acme', name: 'Acme', folders: [{ path: '~/acme' }, { path: '~/libs' }] },
        { id: 'proyectos', name: 'Proyectos', folders: [{ path: '~/Desktop/proyectos' }] },
        { id: 'empty', name: 'Empty' }
      ]
    }
    const plan = planWorkhub1Import(v1, config(), HOME)
    const byId = Object.fromEntries(plan.profiles.map((p) => [p.id, p.defaultFolder]))
    expect(byId).toEqual({ acme: '/Users/ana/acme', proyectos: '/Users/ana/Desktop/proyectos', empty: undefined })
  })
})
