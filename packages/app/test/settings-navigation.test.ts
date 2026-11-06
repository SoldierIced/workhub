import { describe, expect, it } from 'vitest'
import { accountEnvRef, emptyConfig, NO_MODULES, type Profile } from '@workhub/core'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'
import { translate, type MessageKey } from '../src/renderer/i18n/translate'
import { issueSection, issueTarget, LEGACY_TABS, PROFILE_SCREENS, PROFILE_TABS, SETTINGS_SECTIONS, settingsSection, settingsTarget } from '../src/renderer/screens/settings/sections'
import { entryBreadcrumb, foldText, hitKey, searchSettings, SETTINGS_INDEX } from '../src/renderer/screens/settings/settings-index'
import { NOTIFICATIONS_INDEX } from '../src/renderer/screens/settings/notifications-index'
import { profileSummary, SCREEN_ROWS } from '../src/renderer/screens/settings/profileSummary'
import { accountSessionEnv, saveAccountEnv, storedAccountEnvNames } from '../src/main/profile-env'

describe('Settings sections', () => {
  it('has six entries in three groups', () => {
    expect(SETTINGS_SECTIONS.map((s) => `${s.group}:${s.id}`)).toEqual(['app:general', 'app:notifications', 'app:agents', 'app:connections', 'profile:profiles', 'advanced:advanced'])
  })

  it('opens the place that now holds what each old tab or section held', () => {
    const old = ['general', 'appearance', 'notifications', 'alerts', 'agents', 'accounts', 'usage', 'connections', 'trackers', 'profiles', 'profile', 'modules', 'tickets', 'health', 'flowMaps', 'plan', 'slack', 'aiReview', 'storage', 'import']
    expect(Object.fromEntries(old.map((tab) => [tab, settingsTarget(tab)]))).toEqual({
      general: { section: 'general' },
      appearance: { section: 'general', group: 'appearance' },
      notifications: { section: 'notifications' },
      alerts: { section: 'notifications' },
      agents: { section: 'agents' },
      accounts: { section: 'agents' },
      usage: { section: 'agents' },
      connections: { section: 'connections' },
      trackers: { section: 'connections', group: 'tickets' },
      profiles: { section: 'profiles' },
      profile: { section: 'profiles', profile: { tab: 'folders' } },
      modules: { section: 'profiles', profile: { tab: 'screens' } },
      tickets: { section: 'profiles', profile: { tab: 'screens' }, group: 'tickets' },
      health: { section: 'profiles', profile: { tab: 'screens' }, group: 'health' },
      flowMaps: { section: 'profiles', profile: { tab: 'screens' }, group: 'flowMaps' },
      plan: { section: 'profiles', profile: { tab: 'screens' }, group: 'plan' },
      slack: { section: 'profiles', profile: { tab: 'screens' }, group: 'slack' },
      aiReview: { section: 'profiles', profile: { tab: 'screens' }, group: 'aiReview' },
      storage: { section: 'advanced', group: 'data' },
      import: { section: 'advanced', group: 'data' }
    })
  })

  it('points every old per-profile screen at a row of the Screens tab', () => {
    for (const target of Object.values(LEGACY_TABS)) {
      expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain(target.section)
      if (target.profile?.tab === 'screens' && target.group) expect(PROFILE_SCREENS).toContain(target.group)
    }
  })

  it('takes the new section ids as they are and opens General for anything else', () => {
    for (const s of SETTINGS_SECTIONS) expect(settingsSection(s.id)).toBe(s.id)
    expect(settingsSection(undefined)).toBe('general')
    expect(settingsSection('nonsense')).toBe('general')
    expect(settingsSection('toString')).toBe('general')
    // A returned target is a copy: changing it never changes the table.
    const health = settingsTarget('health')
    health.profile!.tab = 'agents'
    expect(LEGACY_TABS.health!.profile!.tab).toBe('screens')
  })

  it('opens a given profile on a given tab', () => {
    expect(settingsTarget('profiles/acme')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'folders' } })
    expect(settingsTarget('profiles/acme/agents')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'agents' } })
    expect(settingsTarget('profiles/acme#sessions')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'sessions' } })
    expect(settingsTarget('profiles/acme/screens#health')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'screens' }, group: 'health' })
    // An anchor naming a screen opens the Screens tab on it.
    expect(settingsTarget('profiles/acme#plan')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'screens' }, group: 'plan' })
    expect(settingsTarget('profiles/acme/nonsense')).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'folders' } })
    // A path on another section is ignored.
    expect(settingsTarget('general/acme#updates')).toEqual({ section: 'general', group: 'updates' })
  })

  it('sends a "Fix" to the place with the form, a profile problem to that profile', () => {
    expect(issueSection({ tab: 'trackers', id: 'jira-acme' })).toBe('connections')
    expect(issueSection({ tab: 'accounts', id: 'work' })).toBe('agents')
    expect(issueTarget({ tab: 'modules', id: 'acme' })).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'screens' } })
    expect(issueTarget({ tab: 'modules', id: 'acme', profileTab: 'agents' })).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'agents' } })
    expect(issueTarget({ tab: 'profiles', id: 'acme' })).toEqual({ section: 'profiles', profile: { id: 'acme', tab: 'folders' } })
    expect(issueTarget({ tab: 'health', id: 'es-acme' })).toEqual({ section: 'profiles', profile: { tab: 'screens' }, group: 'health' })
    expect(issueTarget({ tab: 'plan', id: 'cal' })).toEqual({ section: 'profiles', profile: { tab: 'screens' }, group: 'plan' })
  })
})

describe('Settings search index', () => {
  it('has rows for every section, every profile tab and every screen with settings', () => {
    for (const s of SETTINGS_SECTIONS) expect(SETTINGS_INDEX.some((e) => e.section === s.id), s.id).toBe(true)
    for (const tab of PROFILE_TABS) expect(SETTINGS_INDEX.some((e) => e.section === 'profiles' && e.tab === tab.id), tab.id).toBe(true)
    for (const row of SCREEN_ROWS.filter((r) => r.settings)) expect(SETTINGS_INDEX.some((e) => e.screen === row.key), row.key).toBe(true)
  })

  it('puts profile rows only in Profiles, and screens only on the Screens tab', () => {
    for (const e of SETTINGS_INDEX) {
      if (e.tab) expect(e.section, e.label).toBe('profiles')
      if (e.screen) expect(e.tab, e.label).toBe('screens')
    }
  })

  it('takes every Notifications row with its id', () => {
    const rows = SETTINGS_INDEX.filter((e) => e.section === 'notifications')
    expect(rows).toHaveLength(NOTIFICATIONS_INDEX.length)
    expect(rows.every((e) => typeof e.id === 'string' && e.id.length > 0)).toBe(true)
  })

  it('names only keys both dictionaries have', () => {
    for (const e of SETTINGS_INDEX) {
      for (const key of [e.label, e.hint, e.help, e.subgroup, e.focus].filter((k): k is MessageKey => Boolean(k))) {
        expect(key in en, key).toBe(true)
        expect(key in es, key).toBe(true)
      }
    }
  })

  it('has no row twice in one place', () => {
    const keys = SETTINGS_INDEX.map(hitKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('searchSettings', () => {
  const options = (locale: 'en' | 'es') => ({
    t: (key: MessageKey) => translate(locale, key),
    groupLabel: (g: string) => g
  })

  it('folds case and accents', () => {
    expect(foldText('Notificación ÁRBOL')).toBe('notificacion arbol')
  })

  it('matches in the active language without accents or case', () => {
    const hits = searchSettings(SETTINGS_INDEX, 'NOTIFICACION', options('es'))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.entry.section).toBe('notifications')
    expect(searchSettings(SETTINGS_INDEX, 'termino de responder', options('es')).map((h) => h.entry.label)).toContain('notifAlerts.row.replied')
  })

  it('needs every word, puts label matches first and builds the breadcrumb', () => {
    const hits = searchSettings(SETTINGS_INDEX, 'protected branches', options('en'))
    expect(hits[0]?.entry.label).toBe('settings.protectedBranches')
    expect(hits[0]?.breadcrumb).toEqual(['app', en['settings.nav.connections'], en['settingsConnections.group.code']])
    expect(searchSettings(SETTINGS_INDEX, 'zzzz nothing', options('en'))).toEqual([])
    expect(searchSettings(SETTINGS_INDEX, '   ', options('en'))).toEqual([])
  })

  it('finds rows inside a profile tab, naming the tab and the screen', () => {
    const worktree = searchSettings(SETTINGS_INDEX, 'worktree', options('en'))[0]
    expect(worktree?.entry).toMatchObject({ section: 'profiles', tab: 'folders' })
    expect(worktree?.breadcrumb.slice(0, 3)).toEqual(['profile', en['settingsV2.nav.profiles'], en['settingsV2.tab.folders']])
    const reminder = searchSettings(SETTINGS_INDEX, 'reminder', options('en')).find((h) => h.entry.screen === 'plan')
    expect(reminder?.entry.tab).toBe('screens')
    expect(reminder?.breadcrumb).toContain(en['module.planner'])
    expect(searchSettings(SETTINGS_INDEX, 'limit', options('en')).some((h) => h.entry.tab === 'agents')).toBe(true)
  })

  it('finds the renamed General rows and points a row behind "Adjust…" at that row', () => {
    expect(searchSettings(SETTINGS_INDEX, 'menu bar', options('en')).map((h) => h.entry.label)).toContain('settingsV2.general.keepInTray')
    expect(searchSettings(SETTINGS_INDEX, 'reabrir', options('es'))[0]?.entry.label).toBe('settingsV2.general.reopenSessions')
    const chat = SETTINGS_INDEX.find((e) => e.label === 'appearance.chatSize')
    expect(chat?.focus).toBe('settingsV2.general.textSizes')
    expect(entryBreadcrumb({ section: 'general', label: 'settings.language' }, options('en'))).toEqual(['app', 'General'])
  })

  it('leaves out rows hidden on this computer', () => {
    const all = searchSettings(SETTINGS_INDEX, 'Workhub 1', options('en'))
    expect(all.some((h) => h.entry.label === 'import.migrate')).toBe(true)
    expect(searchSettings(SETTINGS_INDEX, 'Workhub 1', { ...options('en'), visible: (e) => e.only !== 'workhub1' }).some((h) => h.entry.label === 'import.migrate')).toBe(false)
  })
})

describe('profile summary', () => {
  it('counts the folders, names the screens that are on and the agents offered', () => {
    const profile: Profile = { id: 'acme', name: 'Acme', folders: ['/work/acme', '/work/api'], connections: { codeHost: 'gh-acme' }, accountIds: [], modules: { ...NO_MODULES, health: true }, agentIds: [] }
    const config = { ...emptyConfig(), profiles: [profile] }
    const t = (key: MessageKey, params?: Record<string, string | number>) => translate('en', key, params)
    expect(profileSummary(config, profile, t)).toBe(`2 folders · ${en['nav.pullRequests']}, ${en['module.health']}, ${en['settingsV2.screens.aiReview']} · ${en['settingsV2.profiles.noAgents']}`)
  })
})

describe('account environment in the secret store', () => {
  const store = () => {
    const values = new Map<string, string>()
    return {
      values,
      get: async (ref: string) => values.get(ref) ?? null,
      has: async (ref: string) => values.has(ref),
      set: async (ref: string, value: string) => void values.set(ref, value),
      delete: async (ref: string) => void values.delete(ref)
    }
  }

  it('stores values under the account ref and builds the session environment from them', async () => {
    const secrets = store()
    await saveAccountEnv('work', { ACME_TOKEN: 'secret-1', 'BAD NAME': 'x' }, [], secrets)
    expect([...secrets.values.keys()]).toEqual([accountEnvRef('work', 'ACME_TOKEN')])
    const account = { id: 'work', envNames: ['ACME_TOKEN', 'MISSING'] }
    expect(await accountSessionEnv(account, secrets)).toEqual({ ACME_TOKEN: 'secret-1' })
    expect(await storedAccountEnvNames(account, secrets)).toEqual(['ACME_TOKEN'])
    await saveAccountEnv('work', {}, ['ACME_TOKEN'], secrets)
    expect(await accountSessionEnv(account, secrets)).toEqual({})
    expect(await accountSessionEnv(null, secrets)).toEqual({})
  })
})
