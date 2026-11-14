import { describe, expect, it } from 'vitest'
import {
  agentSkillsItem,
  agentItem,
  appOptions,
  claudeCodeItem,
  claudeSignInItem,
  DEFAULT_OPTIONS,
  githubItem,
  healthItem,
  INSTALLERS,
  installCommand,
  isInstallerId,
  jiraItem,
  migrateConfig,
  nodeItem,
  parseConfig,
  problemCount,
  profileEnvRef,
  profileItem,
  shouldNotify,
  slackItem,
  speechText,
  usageItem,
  type Probe,
  type WorkhubConfig
} from '../src'

const ok = (output: string): Probe => ({ result: 'ok', output })
const NONE: Probe = { result: 'notFound', output: '' }

describe('installers', () => {
  it('lists official commands per platform and only for those that have one', () => {
    expect(installCommand('claudeCode', 'darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(installCommand('claudeCode', 'win32')).toContain('install.ps1')
    expect(installCommand('github', 'linux')).toBeNull()
    expect(installCommand('kiro', 'win32')).toBeNull()
    expect(installCommand('codex', 'freebsd')).toBeNull()
    expect(isInstallerId('claudeCode')).toBe(true)
    expect(isInstallerId('rm -rf /')).toBe(false)
    expect(isInstallerId('toString')).toBe(false)
  })
  it('puts the install fix on missing rows when the platform has an installer, else keeps the old fix', () => {
    expect(claudeCodeItem(NONE, 'darwin').fix).toEqual({ kind: 'install', installer: 'claudeCode', command: INSTALLERS.claudeCode.darwin })
    expect(claudeCodeItem(NONE, 'freebsd').fix).toMatchObject({ kind: 'link' })
    expect(claudeCodeItem(NONE).fix).toMatchObject({ kind: 'link' })
    expect(agentItem('codex', NONE, 'linux').fix).toMatchObject({ kind: 'install', installer: 'codex' })
    expect(agentItem('kiro', NONE, 'linux').fix).toEqual({ kind: 'settings', tab: 'accounts' })
    expect(githubItem(NONE, null, null, 'win32').fix).toMatchObject({ kind: 'install', installer: 'github' })
    expect(githubItem(NONE, null, null, 'linux').fix).toEqual({ kind: 'command', command: 'brew install gh' })
  })
})

describe('speechText', () => {
  it('drops code blocks, link addresses, bare URLs and formatting marks', () => {
    const md = ['# Result', 'Run **the tests** at https://example.com/x, then see [the docs](https://a.b/c).', '```ts', 'const secret = 1', '```', '- first item', '- `npm test` works'].join('\n')
    expect(speechText(md)).toBe('Result.\nRun the tests at, then see the docs.\nfirst item.\nnpm test works.')
  })

  it('keeps inline code and escapes as written', () => {
    expect(speechText('Use `a*b*c` and \\*stars\\*')).toBe('Use a*b*c and *stars*')
  })

  it('a longer fence is not closed by a shorter one, and an unclosed fence drops the rest', () => {
    expect(speechText('before\n````\n```\ninside\n```\n````\nafter')).toBe('before\nafter')
    expect(speechText('before\n```\nnever closed')).toBe('before')
  })

  it('reads table rows and skips rules, separators and link definitions', () => {
    expect(speechText('| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n[x]: https://x.y')).toBe('a, b.\n1, 2.')
  })

  it('is empty when there is nothing to read', () => {
    expect(speechText('```\ncode only\n```')).toBe('')
    expect(speechText('---\n***')).toBe('')
  })

  it('cuts a long text where a sentence ends', () => {
    const text = 'One sentence here. Two sentence here. Three sentence here.'
    expect(speechText(text, 25)).toBe('One sentence here.')
    expect(speechText('word '.repeat(20), 12)).toBe('word word')
  })
})

describe('setup checks', () => {
  it('claude code: version, missing, timeout, failed', () => {
    expect(claudeCodeItem(ok('2.1.4 (Claude Code)'))).toMatchObject({ status: 'ok', params: { version: '2.1.4' } })
    expect(claudeCodeItem(NONE)).toMatchObject({ status: 'missing', fix: { kind: 'link' } })
    expect(claudeCodeItem({ result: 'timeout', output: '' })).toMatchObject({ status: 'warning', code: 'timeout' })
    expect(claudeCodeItem({ result: 'failed', output: 'boom\nmore' })).toMatchObject({ status: 'warning', params: { output: 'boom' } })
  })

  it('claude login: signed in, signed out and unreadable keep the account name and offer the login command', () => {
    const cmd = 'CLAUDE_CONFIG_DIR=/x claude auth login'
    expect(claudeSignInItem('claudeSignIn:a', 'Work', ok('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}'), cmd)).toMatchObject({
      id: 'claudeSignIn:a',
      status: 'ok',
      params: { name: 'Work', who: 'a@b.c', plan: 'Max' }
    })
    // Signed out may exit non-zero and still print the status.
    expect(claudeSignInItem('claudeSignIn:a', 'Work', { result: 'failed', output: '{"loggedIn":false}' }, cmd)).toMatchObject({ status: 'missing', fix: { kind: 'command', command: cmd } })
    expect(claudeSignInItem('claudeSignIn:a', 'Work', ok('not json'), cmd)).toMatchObject({ status: 'warning', code: 'authUnreadable' })
    expect(claudeSignInItem('claudeSignIn:a', 'Work', NONE, cmd)).toMatchObject({ status: 'missing', code: 'installClaudeFirst' })
  })

  it('node and gh', () => {
    expect(nodeItem(ok('v22.1.0'))).toMatchObject({ status: 'ok', params: { version: 'v22.1.0' } })
    expect(nodeItem(NONE)).toMatchObject({ status: 'missing', fix: { kind: 'link', title: 'downloadNode' } })
    expect(githubItem(ok('gh version 2.5'), ok('octo\n'), null)).toMatchObject({ status: 'ok', params: { login: 'octo' } })
    expect(githubItem(ok('gh'), { result: 'failed', output: '' }, ok('tok'))).toMatchObject({ status: 'warning', code: 'ghNoAnswer' })
    expect(githubItem(ok('gh'), { result: 'failed', output: '' }, { result: 'failed', output: '' })).toMatchObject({ status: 'missing', fix: { kind: 'command', command: 'gh auth login' } })
    expect(githubItem(NONE, null, null)).toMatchObject({ status: 'missing', fix: { command: 'brew install gh' } })
  })

  it('codex and kiro are optional', () => {
    expect(agentItem('codex', ok('codex-cli 0.5.1'))).toMatchObject({ status: 'ok', optional: true, params: { version: '0.5.1' } })
    expect(agentItem('kiro', NONE)).toMatchObject({ status: 'missing', optional: true })
  })

  const base: WorkhubConfig = { version: 8, connections: [], agents: [], accounts: [], profiles: [] }
  it('profile, jira, slack, health and usage read the config', () => {
    expect(profileItem(base)).toMatchObject({ status: 'missing', fix: { kind: 'settings', tab: 'profiles' } })
    const withFolders: WorkhubConfig = { ...base, profiles: [{ id: 'a', name: 'Acme', connections: { tracker: 'j' }, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false }, folders: ['~/a', '~/b'] }] }
    expect(profileItem(withFolders)).toMatchObject({ status: 'ok', params: { names: 'Acme', count: '2' } })

    const jira = { id: 'j', kind: 'tracker' as const, provider: 'jira', endpoint: 'https://x.atlassian.net', secretRef: 's', settings: {} }
    expect(jiraItem({ ...withFolders, connections: [jira] }, () => true)).toMatchObject({ status: 'ok', params: { names: 'Acme' } })
    expect(jiraItem({ ...withFolders, connections: [jira] }, () => false)).toMatchObject({ status: 'warning', code: 'jiraNoToken' })
    expect(jiraItem(base, () => false)).toMatchObject({ status: 'missing', optional: true })

    expect(slackItem(base, null)).toMatchObject({ status: 'missing', code: 'slackOff' })
    const watcher = { enabled: true, accountId: null, model: 'haiku', intervalMinutes: 10, startHour: 9, endHour: 19, weekdays: [1], usageThreshold: 85, channels: [{ id: 'C', name: 'c', purpose: '' }] }
    expect(slackItem({ chatWatcher: watcher }, null)).toMatchObject({ status: 'ok', params: { count: '1' } })
    expect(slackItem({ chatWatcher: watcher }, 'denied')).toMatchObject({ status: 'warning', params: { error: 'denied' } })

    expect(healthItem(base)).toMatchObject({ status: 'missing' })
    expect(usageItem({ claudePlanUsage: true, codexUsage: false })).toMatchObject({ status: 'ok', params: { sources: 'Claude' } })
    expect(usageItem({ claudePlanUsage: false, codexUsage: false })).toMatchObject({ status: 'missing' })
  })

  it('only required rows count as problems', () => {
    const items = [claudeCodeItem(NONE), nodeItem(ok('v22.0.0')), agentItem('kiro', NONE), jiraItem({ profiles: [], connections: [] }, () => false)]
    expect(problemCount(items)).toBe(1)
  })
})

describe('config 7', () => {
  it('migrates a version 6 document unchanged and fills the new options', () => {
    expect(migrateConfig({ version: 6, profiles: [] })).toEqual({ version: 8, profiles: [] })
    const parsed = parseConfig({ version: 6, options: { notifyReplied: false }, profiles: [{ id: 'p', name: 'P' }] })
    expect(parsed.version).toBe(8)
    expect(appOptions(parsed)).toMatchObject({ notificationsEnabled: true, readAloud: false, speechVoice: '', speechRate: 190, welcomeDone: false, notifyReplied: false })
    expect(parsed.profiles[0]).toEqual({ id: 'p', name: 'P', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false } })
  })

  it('keeps the new profile fields, refuses a bad variable name and clamps the speech rate', () => {
    const profile = { id: 'p', name: 'P', symbol: 'rocket', ownsOutside: true, linkBrowser: 'Google Chrome', envNames: ['API_KEY'], folders: ['~/a'], folderOptions: { '~/a': { onlyGitRepos: true, subfoldersAreProjects: true } } }
    expect(parseConfig({ version: 8, profiles: [profile] }).profiles[0]).toMatchObject(profile)
    expect(() => parseConfig({ version: 8, profiles: [{ ...profile, envNames: ['1BAD'] }] })).toThrow()
    expect(parseConfig({ version: 8, options: { speechRate: 9999 } }).options?.speechRate).toBe(300)
    expect(parseConfig({ version: 8, options: { speechRate: 10 } }).options?.speechRate).toBe(120)
  })

  it('the master switch silences every kind', () => {
    expect(shouldNotify('replied', DEFAULT_OPTIONS, 0)).toBe(true)
    expect(shouldNotify('replied', { ...DEFAULT_OPTIONS, notificationsEnabled: false }, 0)).toBe(false)
    expect(shouldNotify('usage', { ...DEFAULT_OPTIONS, notificationsEnabled: false }, 0)).toBe(false)
  })

  it('names the secret of a profile variable', () => {
    expect(profileEnvRef('acme', 'TOKEN')).toBe('profile-env:acme:TOKEN')
  })
})

describe('Workhub skills row', () => {
  it('is optional, points at Settings → Agents, and counts the Claude folders', () => {
    expect(agentSkillsItem({ installed: 2, outdated: 0, total: 2 })).toMatchObject({ status: 'ok', code: 'skillsInstalled', params: { count: '2' }, optional: true })
    expect(agentSkillsItem({ installed: 0, outdated: 1, total: 2 })).toMatchObject({ status: 'warning', code: 'skillsOutdated', fix: { kind: 'settings', tab: 'accounts' } })
    expect(agentSkillsItem({ installed: 1, outdated: 0, total: 2 })).toMatchObject({ status: 'missing', code: 'skillsMissing', optional: true })
    expect(agentSkillsItem({ installed: 0, outdated: 0, total: 0 })).toMatchObject({ code: 'skillsNoClaude' })
  })
})
