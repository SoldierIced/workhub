import { describe, expect, it } from 'vitest'
import { AUTOMATION_EFFORTS, CLAUDE_MODEL_SUGGESTIONS, EFFORT_LEVELS, emptyConfig, NO_MODULES, type AgentAccount, type Profile, type WorkhubConfig } from '@workhub/core'
import { accountIdFromName, isProfileDefault, makeAccountDefault, makeSignInDefault, profileDefaultAgent, signInOffered, withAccountInProfile } from '../src/renderer/lib/accountDefaults'
import { CUSTOM_OPTION, effortOptions, idOptions, mergeOptions, modelOptions, optionOrCustomState, valueForPick } from '../src/renderer/lib/optionOrCustom'
import { addProfileFolder, removeProfileFolder } from '../src/renderer/lib/profileFolders'
import { en } from '../src/renderer/i18n/en'

describe('option-or-custom picker', () => {
  const models = idOptions(['opus', 'sonnet', 'haiku'])

  it('shows a known value as itself and the empty value as the empty choice', () => {
    expect(optionOrCustomState('sonnet', models, { allowEmpty: true })).toEqual({ selected: 'sonnet', custom: false })
    expect(optionOrCustomState('', models, { allowEmpty: true })).toEqual({ selected: '', custom: false })
  })

  it('never drops a stored value the list does not know: it shows as Other… with the input filled', () => {
    expect(optionOrCustomState('claude-acme-9', models, { allowEmpty: true })).toEqual({ selected: CUSTOM_OPTION, custom: true })
    // Without an empty choice, an empty value is a custom one waiting to be typed.
    expect(optionOrCustomState('', models, { allowEmpty: false })).toEqual({ selected: CUSTOM_OPTION, custom: true })
    // No list yet (the agent has not listed its models): every value is custom.
    expect(optionOrCustomState('opus', [], { allowEmpty: true })).toEqual({ selected: CUSTOM_OPTION, custom: true })
  })

  it('keeps the input open once Other… is picked, even on a known or empty value', () => {
    expect(optionOrCustomState('opus', models, { allowEmpty: true, forceCustom: true })).toEqual({ selected: CUSTOM_OPTION, custom: true })
    expect(optionOrCustomState('', models, { allowEmpty: true, forceCustom: true })).toEqual({ selected: CUSTOM_OPTION, custom: true })
  })

  it('stores the picked option, and Other… keeps the current value for the input to edit', () => {
    expect(valueForPick('haiku', 'opus')).toBe('haiku')
    expect(valueForPick('', 'opus')).toBe('')
    expect(valueForPick(CUSTOM_OPTION, 'opus')).toBe('opus')
  })

  it('merges lists without blanks or duplicates, the first label winning', () => {
    expect(mergeOptions([{ value: 'a', label: 'A' }, { value: '', label: 'none' }], [{ value: 'a', label: 'other A' }, { value: 'b', label: 'B' }])).toEqual([
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ])
  })

  it('suggests the Claude aliases only for a Claude agent that listed no models', () => {
    const listed = [{ value: 'claude-x', label: 'X' }]
    expect(modelOptions(listed, true, CLAUDE_MODEL_SUGGESTIONS)).toEqual(listed)
    expect(modelOptions([], true, CLAUDE_MODEL_SUGGESTIONS).map((o) => o.value)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(modelOptions([], false, CLAUDE_MODEL_SUGGESTIONS)).toEqual([])
  })

  it('offers the effort levels lowest first, labelled through i18n', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(AUTOMATION_EFFORTS).toBe(EFFORT_LEVELS)
    const t = (key: string) => en[key as keyof typeof en]
    expect(effortOptions(t)).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' }
    ])
  })
})

describe('profile folders', () => {
  it('appends a picked folder, several in a row, ignoring blanks and ones already listed', () => {
    let folders: string[] | undefined
    folders = addProfileFolder(folders, '/work/acme')
    folders = addProfileFolder(folders, '/work/example/')
    folders = addProfileFolder(folders, '/work/acme/')
    folders = addProfileFolder(folders, '  ')
    expect(folders).toEqual(['/work/acme', '/work/example'])
  })

  it('keeps the root folder as it is', () => {
    expect(addProfileFolder([], '/')).toEqual(['/'])
  })

  it('removes one folder, and the list goes away with the last one', () => {
    expect(removeProfileFolder(['/a', '/b'], '/a')).toEqual(['/b'])
    expect(removeProfileFolder(['/a'], '/a')).toBeUndefined()
    expect(removeProfileFolder(undefined, '/a')).toBeUndefined()
  })
})

describe('default account of a profile', () => {
  const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Personal', configDir: '/tmp/claude-personal' }
  const work: AgentAccount = { id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/claude-work' }
  const profile: Profile = { id: 'p', name: 'P', connections: {}, accountIds: ['personal'], modules: { ...NO_MODULES } }
  const config = (p: Profile): WorkhubConfig => ({ ...emptyConfig(), accounts: [personal, work], profiles: [p] })

  it('is the first entry of the agent order', () => {
    const first = profileDefaultAgent(config(profile), 'p')
    expect(first?.key).toBe('claude:personal')
    expect(isProfileDefault(first, 'claude', 'personal')).toBe(true)
    expect(isProfileDefault(first, 'claude', 'work')).toBe(false)
    expect(profileDefaultAgent(config(profile), null)).toBeUndefined()
  })

  it('"Make default" offers the account in the profile and puts it first, keeping the rest of the order', () => {
    const before: Profile = { ...profile, preferredAgents: ['kiro', 'claude:personal'] }
    const after = makeAccountDefault(before, work)
    expect(after.accountIds).toEqual(['personal', 'work'])
    expect(after.preferredAgents).toEqual(['claude:work', 'kiro', 'claude:personal'])
    expect(profileDefaultAgent(config(after), 'p')?.account?.id).toBe('work')
    // Again on the default changes nothing.
    expect(makeAccountDefault(after, work)).toEqual(after)
  })

  it("an agent's own sign-in can be the default only while the profile offers it", () => {
    const cfg = config(profile)
    expect(signInOffered(cfg, 'p', 'kiro')).toBe(true)
    // A Claude account is bound, so the profile offers Claude only through its accounts.
    expect(signInOffered(cfg, 'p', 'claude')).toBe(false)
    const after = makeSignInDefault(profile, 'kiro')
    expect(after.preferredAgents).toEqual(['kiro'])
    const first = profileDefaultAgent(config(after), 'p')
    expect(isProfileDefault(first, 'kiro', null)).toBe(true)
  })

  it('offering an account and taking it out again leaves no stale order entry', () => {
    const on = withAccountInProfile(profile, 'work', true)
    expect(on.accountIds).toEqual(['personal', 'work'])
    expect(withAccountInProfile(on, 'work', true)).toBe(on)
    const off = withAccountInProfile({ ...on, preferredAgents: ['claude:work', 'claude-acp:work', 'kiro'] }, 'work', false)
    expect(off.accountIds).toEqual(['personal'])
    expect(off.preferredAgents).toEqual(['kiro'])
  })

  it('makes a new account id from its name, unique among the taken ones', () => {
    expect(accountIdFromName('Claude work', [])).toBe('claude-work')
    expect(accountIdFromName('Claude work', ['claude-work', 'claude-work-2'])).toBe('claude-work-3')
    expect(accountIdFromName('  ', [])).toBe('')
  })
})
