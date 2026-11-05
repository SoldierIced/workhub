import { describe, expect, it } from 'vitest'
import { appOptions, CONFIG_VERSION, ConfigParseError, ConfigVersionError, DEFAULT_TRAY_POPOVER_OPTIONS, migrateConfig, parseConfig } from '../src'

describe('parseConfig', () => {
  it('clamps hand-edited out-of-range scalars instead of refusing the file', () => {
    const parsed = parseConfig({
      version: CONFIG_VERSION,
      options: { speechRate: 5000 },
      chatWatcher: { intervalMinutes: 0, startHour: -3, endHour: 30, usageThreshold: 140 },
      automations: [
        {
          id: 'a1',
          name: 'Nightly',
          agentKey: 'claude',
          runTimeoutMinutes: 0,
          usageThreshold: -5,
          triggers: { intervalMinutes: 0 },
          window: { days: [1], startHour: 8.4, endHour: 99 },
          limits: { maxRuns: 0, perMinutes: -2, maxPerDay: 0 }
        }
      ]
    })
    expect(parsed.options?.speechRate).toBe(300)
    expect(parsed.chatWatcher).toMatchObject({ intervalMinutes: 1, startHour: 0, endHour: 24, usageThreshold: 100 })
    expect(parsed.automations?.[0]).toMatchObject({
      runTimeoutMinutes: 1,
      usageThreshold: 0,
      triggers: { intervalMinutes: 1 },
      window: { startHour: 8, endHour: 24 },
      limits: { maxRuns: 1, perMinutes: 1, maxPerDay: 1 }
    })
  })

  it('reads the menu bar panel blocks: every block on and two meetings by default, bad values fall back', () => {
    expect(appOptions(parseConfig({ version: CONFIG_VERSION })).trayPopover).toEqual(DEFAULT_TRAY_POPOVER_OPTIONS)
    expect(DEFAULT_TRAY_POPOVER_OPTIONS).toEqual({ meetings: true, meetingCount: 2, plan: true, pullRequests: true, health: true, usage: true, recent: true })
    const parsed = appOptions(parseConfig({ version: CONFIG_VERSION, options: { trayPopover: { usage: false, meetingCount: 3, plan: 'no', recent: false } } }))
    expect(parsed.trayPopover).toEqual({ ...DEFAULT_TRAY_POPOVER_OPTIONS, usage: false, meetingCount: 3, recent: false })
    expect(appOptions(parseConfig({ version: CONFIG_VERSION, options: { trayPopover: { meetingCount: 9 } } })).trayPopover.meetingCount).toBe(2)
    expect(appOptions(parseConfig({ version: CONFIG_VERSION, options: { trayPopover: 'all' } })).trayPopover).toEqual(DEFAULT_TRAY_POPOVER_OPTIONS)
  })

  it('returns an empty config for a missing document', () => {
    expect(parseConfig(null)).toEqual({ version: CONFIG_VERSION, connections: [], agents: [], accounts: [], profiles: [] })
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
      modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false }
    })
  })

  it('fills and clamps the metric alert rules of a profile, and leaves them out when absent', () => {
    const parsed = parseConfig({
      version: CONFIG_VERSION,
      profiles: [
        { id: 'acme', name: 'Acme', health: { environments: [], alertRules: { thresholds: { jumpPct: 75, jumpStdDevs: 99 }, overrides: { 'health.errors': { minVolume: 5, critical: true } } } } },
        { id: 'beta', name: 'Beta', health: { environments: [] } }
      ]
    })
    expect(parsed.profiles[0]?.health?.alertRules).toEqual({
      thresholds: { trendDays: 3, trendPct: 20, jumpPct: 75, jumpStdDevs: 10, minVolume: 20, newSubjectDays: 30, rateDropPoints: 5 },
      businessDays: [1, 2, 3, 4, 5],
      notifyMinSeverity: 'high',
      overrides: { 'health.errors': { minVolume: 5, critical: true } }
    })
    expect(parsed.profiles[1]?.health?.alertRules).toBeUndefined()
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
