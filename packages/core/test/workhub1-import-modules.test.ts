import { describe, expect, it } from 'vitest'
import {
  appearanceFrom,
  applyWorkhub1Import,
  DEFAULT_CHAT_WATCHER,
  isEmptyImportPlan,
  jsWeekdays,
  mergeSessionGroups,
  parseConfig,
  planWorkhub1Import,
  sessionGroupsFrom,
  type Workhub1Settings
} from '../src'
import { config } from './fixtures'

const home = '/Users/acme'

// Synthetic: mirrors the shape of Workhub 1's defaults only.
const v1: Workhub1Settings = {
  mainAccount: { name: 'Personal', configDirectory: '~/.claude', command: '' },
  secondAccount: { name: 'Work', configDirectory: '~/.claude-work' },
  profiles: [
    { id: 'acme', name: 'Acme', folders: [{ path: '~/acme' }], githubScope: 'org:acme' },
    { id: 'side', name: 'Side', folders: [{ path: '~/side' }] }
  ],
  automations: [
    {
      id: 'AAAAAAAA-0000-4000-8000-000000000001',
      name: 'PR reviews',
      enabled: true,
      prompt: '/review-prs',
      useSecondAccount: true,
      folder: '~/acme/api',
      permissionMode: 'plan',
      effort: 'high',
      viewMode: 'console',
      sessionPolicy: 'newEachRun',
      runTimeoutMinutes: 30,
      usageThreshold: 85,
      limits: { maxRuns: 2, perMinutes: 10, maxPerDay: 60 },
      window: { days: [2, 3, 4, 5, 6], startHour: 9, endHour: 18 },
      triggers: { slackChannelIds: ['C000REVIEW'], prOwner: 'acme', intervalMinutes: 5, pendingGate: { kind: 'slackPRReview', stateFile: '~/state.json' } }
    },
    { id: 'auto-2', name: 'Elsewhere', folder: '/opt/other', limits: { maxPerDay: null }, receivesSlackReplies: false }
  ],
  slack: {
    enabled: true,
    useSecondAccount: true,
    model: 'haiku',
    intervalMinutes: 1,
    startHour: 9,
    endHour: 18,
    weekdays: [1, 2, 7],
    usageThreshold: 95,
    channels: [{ id: ' C000REVIEW ', name: 'acme-review', purpose: 'PR reviews' }],
    profileID: 'acme'
  },
  slackThreads: [{ closed: false }, { closed: true }],
  observability: {
    acme: {
      elasticURL: 'https://elastic.example.com:9200/',
      keychainItem: 'acme-es-keychain',
      auth: { basic: { username: 'reader' } },
      tls: { insecure: {} },
      environments: [
        {
          id: 'prod',
          name: 'Prod',
          apmEnvironments: ['production', 'prod'],
          k8sIndexSuffix: 'prod',
          hasKubeState: true,
          apm: { errors: 'e-*', traces: 't-*', metrics: 'm-*' },
          kibanaURL: '',
          thresholds: { errorWindowHours: 500, minErrorsToFlag: 7, silentServicesDegrade: true, spanDetailCount: 3 }
        }
      ]
    }
  },
  notifications: { pullRequests: false, slack: false },
  healthAlerts: false,
  usageChecker: '~/usageChecker',
  usageRefreshMinutes: 10,
  prBabysitter: false,
  promptLanguage: 'spanish',
  appLanguage: 'es',
  sessionModels: { '.claude': 'opus', '.unknown': 'sonnet' },
  sessionEfforts: { '.claude-work': 'medium' },
  appearance: { 'terminal.fontSize': 17, 'terminal.theme': 'Dimmed Monokai', 'terminal.fontFamily': '' },
  openSessions: {
    sessions: [
      { sessionID: 'CCCCCCCC-0000-4000-8000-000000000003', kind: 'claude', folder: '/Users/acme/acme/api', group: 'DDDDDDDD-0000-4000-8000-000000000004' },
      { sessionID: 'FFFFFFFF-0000-4000-8000-000000000006', kind: 'claudeSecond', folder: '/Users/acme/side/', name: 'Side work' },
      { sessionID: 'EEEEEEEE-0000-4000-8000-000000000005', kind: 'shell', folder: '/tmp' }
    ],
    groups: [{ id: 'DDDDDDDD-0000-4000-8000-000000000004', name: 'Backend', collapsed: true }],
    top: ['FFFFFFFF-0000-4000-8000-000000000006', 'DDDDDDDD-0000-4000-8000-000000000004', 'EEEEEEEE-0000-4000-8000-000000000005']
  },
  sidebarProfile: 'side'
}

describe('Workhub 1 import: modules and options', () => {
  const plan = planWorkhub1Import(v1, config(), home)

  it('maps automations to their profile, account and Workhub 2 fields', () => {
    expect(plan.automations?.[0]).toEqual({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      name: 'PR reviews',
      enabled: true,
      prompt: '/review-prs',
      profileId: 'acme',
      agentKey: 'claude:claude-work',
      folder: '~/acme/api',
      view: 'console',
      effort: 'high',
      permissionMode: 'plan',
      triggers: { chatChannelIds: ['C000REVIEW'], prOwner: 'acme', intervalMinutes: 5, pendingGate: { kind: 'prReviewQueue', stateFile: '~/state.json' } },
      // Calendar weekdays (1 = Sunday) become JavaScript ones (0 = Sunday).
      window: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
      limits: { maxRuns: 2, perMinutes: 10, maxPerDay: 60 },
      usageThreshold: 85,
      sessionPolicy: 'newEachRun',
      runTimeoutMinutes: 30,
      receivesChatReplies: true
    })
    // Outside every profile folder: Slack's profile owns it; the main account runs it.
    expect(plan.automations?.[1]).toMatchObject({ profileId: 'acme', agentKey: 'claude:claude-personal', sessionPolicy: 'reuse', receivesChatReplies: false, limits: { maxPerDay: null } })
  })

  it('maps the Slack watcher and turns on the modules each profile used', () => {
    expect(plan.chatWatcher).toEqual({
      ...DEFAULT_CHAT_WATCHER,
      enabled: true,
      accountId: 'claude-work',
      intervalMinutes: 3,
      endHour: 18,
      weekdays: [0, 1, 6],
      usageThreshold: 95,
      channels: [{ id: 'C000REVIEW', name: 'acme-review', purpose: 'PR reviews' }]
    })
    const acme = plan.profiles.find((p) => p.id === 'acme')
    const side = plan.profiles.find((p) => p.id === 'side')
    expect(acme?.modules).toEqual({ flows: false, health: true, chatWatcher: true, automations: true })
    expect(side?.modules).toEqual({ flows: false, health: false, chatWatcher: false, automations: false })
    expect(plan.notes).toContainEqual({ code: 'notSupported', path: 'chatWatcher', detail: 'slack.threads' })
  })

  it('maps observability to a health connection and the profile Health setup, without the secret', () => {
    const elastic = plan.connections.find((c) => c.id === 'elastic-acme')
    expect(elastic).toEqual({
      id: 'elastic-acme',
      kind: 'health',
      provider: 'elastic-apm',
      name: 'Elastic (Acme)',
      endpoint: 'https://elastic.example.com:9200',
      settings: { auth: 'basic', username: 'reader', tls: 'insecure' }
    })
    const acme = plan.profiles.find((p) => p.id === 'acme')
    expect(acme?.connections.health).toBe('elastic-acme')
    expect(acme?.health?.refreshMinutes).toBe(5)
    expect(acme?.health?.environments[0]).toMatchObject({ id: 'prod', apmEnvironments: ['production', 'prod'], hasKubeState: true, apm: { errors: 'e-*' }, kibanaUrl: '' })
    // Clamped into Workhub 2's range; unknown thresholds dropped.
    expect(acme?.health?.environments[0]?.thresholds).toMatchObject({ errorWindowHours: 168, minErrorsToFlag: 7, silentServicesDegrade: true })
    expect(acme?.health?.environments[0]?.thresholds).not.toHaveProperty('spanDetailCount')
    expect(plan.notes).toContainEqual({ code: 'reenterSecret', path: 'connections.elastic-acme' })
    expect(JSON.stringify(plan)).not.toContain('acme-es-keychain')
  })

  it('maps options, prefs and the prompt language, and reports what has no equivalent', () => {
    expect(plan.options).toEqual({ claudePlanUsage: true, notifyPrEvents: expect.any(Object), notifySlack: false, notifyHealth: false })
    expect(Object.values(plan.options?.notifyPrEvents ?? {}).every((v) => v === false)).toBe(true)
    expect(plan.prefs).toEqual({ models: { 'claude:claude-personal': 'opus' }, language: 'es', appearance: { terminalFontSize: 17, terminalTheme: 'Dimmed Monokai' } })
    expect(plan.profiles.every((p) => p.aiReview?.language === 'es')).toBe(true)
    const settingsNotes = plan.notes.filter((n) => n.path === 'settings').map((n) => n.detail)
    expect(settingsNotes.sort()).toEqual(['usageChecker', 'usageRefreshMinutes'])
    expect(plan.notes).toContainEqual({ code: 'notSupported', path: 'accounts.claude-work', detail: 'effort' })
  })

  it('maps the sidebar groups and order for Claude sessions only', () => {
    expect(plan.sessionGroups).toEqual({
      groups: [
        {
          id: 'dddddddd-0000-4000-8000-000000000004',
          name: 'Backend',
          collapsed: true,
          members: [{ key: 'cccccccc-0000-4000-8000-000000000003', title: 'api', agentKey: 'claude:claude-personal', cwd: '/Users/acme/acme/api' }]
        }
      ],
      top: [
        { kind: 'session', key: 'ffffffff-0000-4000-8000-000000000006' },
        { kind: 'group', id: 'dddddddd-0000-4000-8000-000000000004' }
      ]
    })
    expect(plan.activeProfileId).toBe('side')
  })

  it('applies to a brand-new config: valid, reloadable, and a second import adds nothing', () => {
    const { result, notes } = applyWorkhub1Import(config(), plan)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const next = result.value
    expect(next.automations).toHaveLength(2)
    expect(next.chatWatcher?.accountId).toBe('claude-work')
    expect(next.options).toMatchObject({ claudePlanUsage: true, notifyReplied: true })
    expect(next.sessionGroups?.groups).toHaveLength(1)
    expect(next.activeProfileId).toBe('side')
    expect(next.connections.every((c) => c.secretRef === undefined)).toBe(true)
    expect(notes).toEqual(plan.notes)
    // The stored file loads again through the schema.
    expect(parseConfig(JSON.parse(JSON.stringify(next))).automations).toHaveLength(2)

    const again = planWorkhub1Import(v1, next, home)
    expect(isEmptyImportPlan(again)).toBe(true)
    const twice = applyWorkhub1Import(next, again)
    expect(twice.result.ok && twice.result.value).toEqual(next)
    expect(twice.notes).toEqual(expect.arrayContaining([{ code: 'exists', path: 'chatWatcher' }, { code: 'exists', path: 'options' }]))
  })

  it('applying the same plan twice leaves out what is already there', () => {
    const first = applyWorkhub1Import(config(), plan)
    expect(first.result.ok).toBe(true)
    if (!first.result.ok) return
    const second = applyWorkhub1Import(first.result.value, plan)
    expect(second.result.ok && second.result.value).toEqual(first.result.value)
    expect(second.notes).toContainEqual({ code: 'exists', path: 'profiles.acme' })
    expect(second.notes).toContainEqual({ code: 'exists', path: 'automations.auto-2' })
  })

  it('keeps sections the Workhub 2 config already has', () => {
    const existing = config({ chatWatcher: { ...DEFAULT_CHAT_WATCHER, channels: [{ id: 'C1', name: 'mine', purpose: '' }] }, options: { ...plan.options, claudePlanUsage: false } as never })
    const p = planWorkhub1Import(v1, existing, home)
    expect(p.chatWatcher).toBeUndefined()
    expect(p.options).toBeUndefined()
    const { result } = applyWorkhub1Import(existing, p)
    expect(result.ok && result.value.chatWatcher?.channels[0]?.id).toBe('C1')
    expect(result.ok && result.value.options?.claudePlanUsage).toBe(false)
  })

  it('imports the protected branch list only when the user changed it from the default', () => {
    const def = 'develop, development, dev, master, main, staging, stage, production, prod, qa, test'
    expect(planWorkhub1Import({ protectedBranches: def }, config(), home).options).toBeUndefined()
    expect(planWorkhub1Import({ protectedBranches: 'TEST, qa,test,prod,production,stage,staging,main,master,dev,development,develop' }, config(), home).options).toBeUndefined()
    expect(planWorkhub1Import({ protectedBranches: '' }, config(), home).options).toBeUndefined()
    expect(planWorkhub1Import({ protectedBranches: 'Main, trunk\nhotfix' }, config(), home).options).toEqual({ protectedBranches: ['main', 'trunk', 'hotfix'] })
  })

  it('turns the main notification switch off everywhere it maps', () => {
    const p = planWorkhub1Import({ notifications: { all: false } }, config(), home)
    expect(p.options).toMatchObject({ notifyReplied: false, notifyNeedsAnswer: false, notifyError: false, notifySlack: false, notifyTickets: false, notifyAutomations: false, notifyHealth: false })
    expect(p.options?.claudePlanUsage).toBeUndefined()
  })

  it('keeps a profile colour, with or without its #, and drops one that is not a colour', () => {
    const p = planWorkhub1Import({ profiles: [{ id: 'a', name: 'A', color: '#7A6FF0' }, { id: 'b', name: 'B', color: '12ab34' }, { id: 'c', name: 'C', color: 'blue' }] }, config(), home)
    expect(p.profiles.map((x) => x.color)).toEqual(['#7a6ff0', '#12ab34', undefined])
  })

  it('reads API-key auth and pinned TLS', () => {
    const p = planWorkhub1Import(
      { profiles: [{ id: 'acme', name: 'Acme' }], observability: { acme: { elasticURL: 'https://es.example.com', auth: { apiKey: {} }, tls: { pinned: { sha256: 'ab:cd' } } } } },
      config(),
      home
    )
    expect(p.connections[0]?.settings).toEqual({ auth: 'apiKey', tls: 'pinned', tlsFingerprint: 'ab:cd' })
  })
})

describe('session groups helpers', () => {
  it('converts weekdays', () => {
    expect(jsWeekdays([2, 3, 4, 5, 6], [])).toEqual([1, 2, 3, 4, 5])
    expect(jsWeekdays(undefined, [9])).toEqual([9])
    expect(jsWeekdays([0, 8, 1], [])).toEqual([0])
  })

  it('leaves out sessions with no Workhub 2 agent', () => {
    const g = sessionGroupsFrom({ sessions: [{ sessionID: 'A', kind: 'claudeSecond', folder: '/x' }], top: ['A'] }, () => null)
    expect(g).toEqual({ groups: [], top: [] })
  })

  it('merges without moving what is already placed', () => {
    const member = { key: 'k1', title: 't', agentKey: 'claude', cwd: '/x' }
    const current = { groups: [{ id: 'g1', name: 'Mine', collapsed: false, members: [member] }], top: [{ kind: 'group' as const, id: 'g1' }] }
    const imported = {
      groups: [
        { id: 'g1', name: 'Theirs', collapsed: true, members: [] },
        { id: 'g2', name: 'New', collapsed: false, members: [member, { ...member, key: 'k2' }] }
      ],
      top: [{ kind: 'group' as const, id: 'g2' }, { kind: 'session' as const, key: 'k1' }, { kind: 'session' as const, key: 'k3' }]
    }
    const merged = mergeSessionGroups(current, imported)
    expect(merged.groups.map((g) => [g.name, g.members.map((m) => m.key)])).toEqual([
      ['Mine', ['k1']],
      ['New', ['k2']]
    ])
    expect(merged.top).toEqual([{ kind: 'group', id: 'g1' }, { kind: 'group', id: 'g2' }, { kind: 'session', key: 'k3' }])
  })
})

describe('Workhub 1 appearance', () => {
  it('maps the terminal theme and font and both text sizes, rounding sizes', () => {
    expect(
      appearanceFrom({ 'terminal.theme': 'Catppuccin Mocha', 'terminal.fontFamily': 'Menlo', 'terminal.fontSize': 14.5, 'chat.fontSize': '15', 'app.textSize': 16 })
    ).toEqual({ terminalTheme: 'Catppuccin Mocha', terminalFontFamily: 'Menlo', terminalFontSize: 15, chatFontSize: 15, textSize: 16 })
  })

  it('leaves out empty, default and unreadable values', () => {
    expect(appearanceFrom({ 'terminal.fontFamily': '', 'terminal.theme': '  ', 'terminal.fontSize': 'big', 'app.textSize': 0 })).toBeUndefined()
    expect(appearanceFrom(undefined)).toBeUndefined()
  })
})
