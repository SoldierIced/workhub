import { describe, expect, it } from 'vitest'
import { accountEnvRef } from '@workhub/core'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'
import { translate, type MessageKey } from '../src/renderer/i18n/translate'
import { issueSection, LEGACY_TABS, SETTINGS_SECTIONS, settingsSection } from '../src/renderer/screens/settings/sections'
import { foldText, searchSettings, SETTINGS_INDEX } from '../src/renderer/screens/settings/settings-index'
import { accountSessionEnv, saveAccountEnv, storedAccountEnvNames } from '../src/main/profile-env'

describe('Settings sections', () => {
  it('opens the section that now holds what each old tab held', () => {
    expect(
      Object.fromEntries(['general', 'appearance', 'profiles', 'accounts', 'connections', 'trackers', 'health', 'flowMaps', 'plan', 'slack', 'usage'].map((tab) => [tab, settingsSection(tab)]))
    ).toEqual({
      general: 'general',
      appearance: 'appearance',
      profiles: 'profile',
      accounts: 'agents',
      connections: 'connections',
      trackers: 'tickets',
      health: 'health',
      flowMaps: 'flowMaps',
      plan: 'plan',
      slack: 'slack',
      usage: 'usage'
    })
  })

  it('takes the new section ids as they are and opens General for anything else', () => {
    for (const s of SETTINGS_SECTIONS) expect(settingsSection(s.id)).toBe(s.id)
    expect(settingsSection(undefined)).toBe('general')
    expect(settingsSection('nonsense')).toBe('general')
    expect(settingsSection('toString')).toBe('general')
    for (const section of Object.values(LEGACY_TABS)) expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain(section)
  })

  it('sends a "Fix" to the section with the form', () => {
    expect(issueSection({ tab: 'trackers', id: 'jira-acme' })).toBe('tickets')
    expect(issueSection({ tab: 'modules', id: 'acme' })).toBe('modules')
    expect(issueSection({ tab: 'accounts', id: 'work' })).toBe('agents')
  })
})

describe('Settings search index', () => {
  it('has at least one row for every section in the navigation', () => {
    for (const s of SETTINGS_SECTIONS) expect(SETTINGS_INDEX.some((e) => e.section === s.id), s.id).toBe(true)
  })

  it('names only keys both dictionaries have', () => {
    for (const e of SETTINGS_INDEX) {
      for (const key of [e.label, e.hint, e.help, e.subgroup].filter((k): k is MessageKey => Boolean(k))) {
        expect(key in en, key).toBe(true)
        expect(key in es, key).toBe(true)
      }
    }
  })
})

describe('searchSettings', () => {
  const options = (locale: 'en' | 'es') => ({
    t: (key: MessageKey) => translate(locale, key),
    groupLabel: (g: string) => (g === 'profile' ? 'Profile Acme' : g)
  })

  it('folds case and accents', () => {
    expect(foldText('Notificación ÁRBOL')).toBe('notificacion arbol')
  })

  it('matches in the active language without accents or case', () => {
    const hits = searchSettings(SETTINGS_INDEX, 'NOTIFICACION', options('es'))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.entry.section).toBe('notifications')
    expect(searchSettings(SETTINGS_INDEX, 'respondio', options('es')).map((h) => h.entry.label)).toContain('settings.notifyReplied')
  })

  it('needs every word, puts label matches first and builds the breadcrumb', () => {
    const hits = searchSettings(SETTINGS_INDEX, 'protected branches', options('en'))
    expect(hits[0]?.entry.label).toBe('settings.protectedBranches')
    expect(hits[0]?.breadcrumb).toEqual(['workhub', en['settings.nav.notifications'], en['settings.pullRequests']])
    expect(searchSettings(SETTINGS_INDEX, 'worktree', options('en'))[0]?.breadcrumb[0]).toBe('Profile Acme')
    expect(searchSettings(SETTINGS_INDEX, 'zzzz nothing', options('en'))).toEqual([])
    expect(searchSettings(SETTINGS_INDEX, '   ', options('en'))).toEqual([])
  })

  it('leaves out sections hidden on this computer', () => {
    const all = searchSettings(SETTINGS_INDEX, 'Workhub 1', options('en'))
    expect(all.some((h) => h.entry.section === 'import')).toBe(true)
    expect(searchSettings(SETTINGS_INDEX, 'Workhub 1', { ...options('en'), visible: (s) => s !== 'import' }).some((h) => h.entry.section === 'import')).toBe(false)
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
