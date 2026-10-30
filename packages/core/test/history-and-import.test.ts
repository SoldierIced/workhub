import { describe, expect, it } from 'vitest'
import {
  addImported,
  appOptions,
  BUILTIN_AGENTS,
  CONFIG_VERSION,
  consoleCommand,
  launchArgs,
  groupHistory,
  parseConfig,
  planWorkhub1Import,
  setOptions,
  slugId,
  visibleMonitorFields,
  type HistoryEntry,
  type Workhub1Settings
} from '../src'
import { config, github, profile } from './fixtures'

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  agentId: 'claude',
  accountId: null,
  agentSessionId: 's1',
  title: 'Untitled',
  lastModified: 1,
  ...over
})

describe('groupHistory', () => {
  const entries = [
    entry({ agentSessionId: 'a', title: 'Fix the login form', cwd: '/w/web', lastModified: 30 }),
    entry({ agentSessionId: 'b', title: 'Release notes', cwd: '/w/api', lastModified: 50, gitBranch: 'release/2' }),
    entry({ agentSessionId: 'c', title: 'Add tests', cwd: '/w/web', lastModified: 40 }),
    // The same session seen through a second account: only the newest copy counts.
    entry({ agentSessionId: 'c', accountId: 'work', title: 'Add tests', cwd: '/w/web', lastModified: 45 })
  ]

  it('groups by folder, newest group and newest session first, without duplicates', () => {
    const groups = groupHistory(entries)
    expect(groups.map((g) => g.folder)).toEqual(['/w/api', '/w/web'])
    expect(groups[1]?.entries.map((e) => `${e.agentSessionId}@${e.accountId}`)).toEqual(['c@work', 'a@null'])
  })

  it('filters by every word of the search across title, folder and branch', () => {
    expect(groupHistory(entries, 'release').map((g) => g.folder)).toEqual(['/w/api'])
    expect(groupHistory(entries, 'web login').flatMap((g) => g.entries.map((e) => e.agentSessionId))).toEqual(['a'])
    expect(groupHistory(entries, 'nothing-like-this')).toEqual([])
  })
})

describe('consoleCommand', () => {
  const launch = BUILTIN_AGENTS.find((a) => a.id === 'claude')!.console!
  it('starts a new session with its id and resumes one that has a transcript', () => {
    expect(consoleCommand(launch, 'abc', false)).toEqual({ command: 'claude', args: ['--session-id', 'abc'] })
    expect(consoleCommand(launch, 'abc', true)).toEqual({ command: 'claude', args: ['--resume', 'abc'] })
    expect(consoleCommand(launch, undefined, true)).toEqual({ command: 'claude', args: [] })
  })

  it('passes the session model after the session args, and skips none or `default`', () => {
    expect(consoleCommand(launch, 'abc', false, 'opus')).toEqual({ command: 'claude', args: ['--session-id', 'abc', '--model', 'opus'] })
    expect(consoleCommand(launch, 'abc', true, 'claude-opus-4-6')).toEqual({ command: 'claude', args: ['--resume', 'abc', '--model', 'claude-opus-4-6'] })
    expect(consoleCommand(launch, 'abc', true, 'default')).toEqual({ command: 'claude', args: ['--resume', 'abc'] })
    expect(consoleCommand(launch, 'abc', true, undefined)).toEqual({ command: 'claude', args: ['--resume', 'abc'] })
    expect(consoleCommand(launch, 'abc', true, '')).toEqual({ command: 'claude', args: ['--resume', 'abc'] })
  })

  it('adds no model args to a console launch without modelArgs', () => {
    expect(consoleCommand({ command: 'tool', args: ['x'] }, 'abc', false, 'opus')).toEqual({ command: 'tool', args: ['x'] })
  })
})

describe('launchArgs', () => {
  const kiro = BUILTIN_AGENTS.find((a) => a.id === 'kiro')!
  it('passes the model and effort to an agent that takes them on its command line', () => {
    expect(launchArgs(kiro, { model: 'claude-opus-5.5', effort: 'xhigh' })).toEqual(['acp', '--model', 'claude-opus-5.5', '--effort', 'xhigh'])
    expect(launchArgs(kiro, { effort: 'high' })).toEqual(['acp', '--effort', 'high'])
    expect(launchArgs(kiro, { model: 'default' })).toEqual(['acp'])
    expect(launchArgs(kiro, {})).toEqual(['acp'])
  })

  it('adds nothing to an agent without modelArgs or effortArgs', () => {
    expect(launchArgs({ args: ['serve'] }, { model: 'm', effort: 'high' })).toEqual(['serve'])
  })
})

describe('built-in Claude agents', () => {
  it('runs Claude natively by default and keeps ACP selectable', () => {
    const native = BUILTIN_AGENTS.find((a) => a.id === 'claude')!
    expect(native.adapter).toBe('native')
    expect(native.capabilities.mcpControl && native.capabilities.hooks && native.capabilities.imageInput).toBe(true)
    expect(BUILTIN_AGENTS.find((a) => a.id === 'claude-acp')?.adapter).toBe('acp')
  })

  it('shows pull requests and tickets only for agents with a transcript reader', () => {
    const snap = { pullRequests: ['https://github.com/acme/web/pull/1'], ticketKeys: ['ABC-1'] }
    const native = BUILTIN_AGENTS.find((a) => a.id === 'claude')!.capabilities
    const gemini = BUILTIN_AGENTS.find((a) => a.id === 'gemini')!.capabilities
    expect(visibleMonitorFields(native, snap)).toEqual(['pullRequests', 'tickets'])
    expect(visibleMonitorFields(gemini, snap)).toEqual([])
  })
})

describe('config version 2', () => {
  it('migrates a version 1 document and fills the new defaults', () => {
    const parsed = parseConfig({
      version: 1,
      agents: [{ id: 'acme', name: 'Acme', adapter: 'terminal', command: 'acme', capabilities: { appMode: false, transcript: false, usage: false, planUsage: false, history: false, hooks: false, models: false, mcpStatus: false, mcpControl: false, subagents: false, permissionRequests: false } }],
      profiles: [{ id: 'acme', name: 'Acme' }]
    })
    expect(parsed.version).toBe(CONFIG_VERSION)
    expect(parsed.agents[0]?.capabilities.imageInput).toBe(false)
    expect(parsed.profiles[0]?.folders).toBeUndefined()
  })

  it('keeps plan usage off unless turned on', () => {
    expect(appOptions(config()).claudePlanUsage).toBe(false)
    const r = setOptions(config(), { claudePlanUsage: true })
    expect(r.ok && appOptions(r.value).claudePlanUsage).toBe(true)
  })
})

describe('planWorkhub1Import', () => {
  const home = '/Users/acme'
  const v1: Workhub1Settings = {
    mainAccount: { name: '  Personal   account ', configDirectory: '~/.claude' },
    secondAccount: { name: 'Work', configDirectory: '~/.claude-work/', command: 'claude-work' },
    profiles: [
      {
        id: 'acme',
        name: 'Acme',
        folders: [{ path: '~/acme' }, { path: '/opt/shared/' }],
        githubScope: 'org:acme',
        ticketPrefixes: ['abc', 'DEF'],
        sessionEnvironment: [{ name: 'ACME_PROJECT', value: '${FOLDER}' }]
      },
      { id: 'Side Projects', name: 'Side' }
    ],
    jira: { acme: { site: 'acme.example.com/', keychainService: 'workhub-jira-acme', ignoredStatuses: ['Done'] } }
  }

  it('maps accounts, profiles with folders, and GitHub and Jira connections without secrets', () => {
    const plan = planWorkhub1Import(v1, config(), home)
    expect(plan.accounts).toEqual([
      { id: 'claude-personal-account', agentId: 'claude', name: 'Personal account' },
      { id: 'claude-work', agentId: 'claude', name: 'Work', configDir: '/Users/acme/.claude-work' }
    ])
    expect(plan.profiles.map((p) => p.id)).toEqual(['acme', 'side-projects'])
    expect(plan.profiles[0]).toMatchObject({
      folders: ['/Users/acme/acme', '/opt/shared'],
      accountIds: ['claude-personal-account', 'claude-work'],
      connections: { codeHost: 'github-acme', tracker: 'jira-acme' }
    })
    expect(plan.connections.find((c) => c.id === 'jira-acme')).toMatchObject({
      endpoint: 'https://acme.example.com',
      settings: { projectKeys: 'ABC,DEF', ignoredStatuses: 'Done' }
    })
    expect(plan.connections.every((c) => c.secretRef === undefined)).toBe(true)
    expect(plan.notes).toEqual(
      expect.arrayContaining([
        { code: 'reenterSecret', path: 'connections.jira-acme' },
        { code: 'notSupported', path: 'accounts.claude-work', detail: 'command' },
        { code: 'notSupported', path: 'profiles.acme', detail: 'sessionEnvironment' }
      ])
    )
    // GitHub reads through the `gh` login: no secret to enter again.
    expect(plan.notes.some((n) => n.path === 'connections.github-acme')).toBe(false)
    // The Keychain item name is never carried over.
    expect(JSON.stringify(plan)).not.toContain('workhub-jira-acme')
  })

  it('leaves out ids that already exist, with their connections', () => {
    const plan = planWorkhub1Import(v1, config({ profiles: [profile({ id: 'acme' })] }), home)
    expect(plan.profiles.map((p) => p.id)).toEqual(['side-projects'])
    expect(plan.connections).toEqual([])
    expect(plan.notes).toContainEqual({ code: 'exists', path: 'profiles.acme' })
  })

  it('adds the plan even though the imported connections have no secret yet', () => {
    const plan = planWorkhub1Import(v1, config(), home)
    const r = addImported(config(), plan)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.activeProfileId).toBe('acme')
      expect(r.value.connections).toHaveLength(2)
    }
  })

  it('still refuses problems other than a missing secret', () => {
    const r = addImported(config({ connections: [github] }), { profiles: [], accounts: [], connections: [{ ...github }] })
    expect(r.ok).toBe(false)
  })

  it('makes ids from any name', () => {
    expect(slugId('Ñandú Trabajo', 'x')).toBe('nandu-trabajo')
    expect(slugId('***', 'fallback')).toBe('fallback')
  })
})
