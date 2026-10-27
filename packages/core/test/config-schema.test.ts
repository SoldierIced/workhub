import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, ConfigParseError, ConfigVersionError, migrateConfig, parseConfig } from '../src'

describe('parseConfig', () => {
  it('returns an empty config for a missing document', () => {
    expect(parseConfig(null)).toEqual({ version: 1, connections: [], agents: [], accounts: [], profiles: [] })
  })

  it('migrates an unversioned document to the current version and fills defaults', () => {
    const parsed = parseConfig({
      connections: [{ id: 'acme-github', kind: 'codeHost', provider: 'github', secretRef: 'connection/acme-github' }],
      profiles: [{ id: 'acme', name: 'Acme' }]
    })
    expect(parsed.version).toBe(CONFIG_VERSION)
    expect(parsed.connections[0]?.settings).toEqual({})
    expect(parsed.profiles[0]).toEqual({
      id: 'acme',
      name: 'Acme',
      connections: {},
      accountIds: [],
      modules: { flows: false, health: false, chatWatcher: false, automations: false }
    })
  })

  it('rejects a document from a newer Workhub', () => {
    expect(() => parseConfig({ version: CONFIG_VERSION + 1 })).toThrow(ConfigVersionError)
  })

  it('reports shape errors with their path', () => {
    try {
      parseConfig({ version: 1, connections: [{ id: 'Bad Id', kind: 'codeHost', provider: 'github' }] })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError)
      expect((e as ConfigParseError).issues[0]).toMatch(/^connections\.0\.id:/)
    }
  })

  it('rejects a connection kind that does not exist', () => {
    expect(() => parseConfig({ version: 1, connections: [{ id: 'x', kind: 'email', provider: 'github' }] })).toThrow(
      ConfigParseError
    )
  })

  it('rejects non-object documents', () => {
    expect(() => parseConfig([])).toThrow(ConfigParseError)
    expect(() => parseConfig('text')).toThrow(ConfigParseError)
  })
})

describe('migrateConfig', () => {
  it('runs every step in order up to the target version', () => {
    const steps = {
      0: (raw: Record<string, unknown>) => ({ ...raw, a: 1 }),
      1: (raw: Record<string, unknown>) => ({ ...raw, b: (raw['a'] as number) + 1 })
    }
    expect(migrateConfig({}, steps, 2)).toEqual({ a: 1, b: 2, version: 2 })
  })

  it('fails when a step is missing', () => {
    expect(() => migrateConfig({ version: 0 }, {}, 1)).toThrow(/no migration from version 0/)
  })
})
