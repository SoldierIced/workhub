import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENTS,
  INSTALLERS,
  agentItem,
  agentSetupKind,
  applyNeeds,
  claudeCodeItem,
  codexItem,
  gitItem,
  gitlabItem,
  installCommand,
  installFix,
  installMethod,
  installSource,
  isNeeded,
  linearItem,
  nodeItem,
  parseConfig,
  problemCount,
  setupGoal,
  setupNeeds,
  type Connection,
  type InstallMethod,
  type Probe,
  type Profile,
  type WorkhubConfig
} from '../src'

const ok = (output: string): Probe => ({ result: 'ok', output })
const NONE: Probe = { result: 'notFound', output: '' }
const FAILED: Probe = { result: 'failed', output: '' }
const TIMEOUT: Probe = { result: 'timeout', output: '' }

const NO_MODULES = { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false, boards: false }
const profile = (over: Partial<Profile> = {}): Profile => ({ id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: NO_MODULES, folders: ['/work/acme'], ...over })
const github: Connection = { id: 'gh', kind: 'codeHost', provider: 'github', settings: {} }
const gitlab: Connection = { id: 'gl', kind: 'codeHost', provider: 'gitlab', settings: {} }
const linear: Connection = { id: 'lin', kind: 'tracker', provider: 'linear', secretRef: 'connection/lin', settings: {} }
const config = (over: Partial<WorkhubConfig> = {}): WorkhubConfig => ({ version: 8, connections: [], agents: [], accounts: [], profiles: [], ...over })

describe('setup goal', () => {
  it('reads as both until chosen, and a bad stored value reads as unset', () => {
    expect(setupGoal(config())).toBe('both')
    expect(setupGoal(config({ options: { setupGoal: 'files' } as WorkhubConfig['options'] }))).toBe('files')
    expect(setupGoal(parseConfig({ version: 8, options: { setupGoal: 'everything' } }))).toBe('both')
    expect(parseConfig({ version: 8, options: { setupGoal: 'code' } }).options?.setupGoal).toBe('code')
  })
})

describe('needed rows', () => {
  const goal = (g: 'files' | 'code' | 'both') => ({ options: { setupGoal: g } as WorkhubConfig['options'] })

  it('with nothing chosen: Claude, a profile and git; no code host, no Node', () => {
    const needs = setupNeeds(config())
    expect(needs).toMatchObject({ goal: 'both', agents: ['claude'], codeHosts: [], git: true, node: [], linear: false })
    for (const kind of ['claudeCode', 'claudeSignIn', 'profile', 'git'] as const) expect(isNeeded(kind, needs), kind).toBe(true)
    for (const kind of ['node', 'github', 'gitlab', 'codex', 'kiro', 'opencode', 'gemini', 'linear', 'jira', 'slack'] as const) expect(isNeeded(kind, needs), kind).toBe(false)
  })

  it('the files goal needs no git, code host or tracker, even when a profile has them', () => {
    const needs = setupNeeds(config({ ...goal('files'), connections: [github, linear], profiles: [profile({ connections: { codeHost: 'gh', tracker: 'lin' } })] }))
    expect(needs).toMatchObject({ codeHosts: [], git: false, linear: false })
    expect(isNeeded('github', needs)).toBe(false)
    expect(isNeeded('git', needs)).toBe(false)
    expect(isNeeded('profile', needs)).toBe(true)
  })

  it('the code goal needs git and only the host and tracker the profiles use', () => {
    const one = setupNeeds(config({ ...goal('code'), connections: [gitlab, linear], profiles: [profile({ connections: { codeHost: 'gl', tracker: 'lin' } })] }))
    expect(one).toMatchObject({ codeHosts: ['gitlab'], git: true, linear: true })
    expect(isNeeded('gitlab', one)).toBe(true)
    expect(isNeeded('github', one)).toBe(false)
    expect(isNeeded('linear', one)).toBe(true)
    const issues: Connection = { id: 'issues', kind: 'tracker', provider: 'github-issues', settings: {} }
    expect(setupNeeds(config({ ...goal('both'), connections: [issues], profiles: [profile({ connections: { tracker: 'issues' } })] })).codeHosts).toEqual(['github'])
  })

  it('an agent is needed only when chosen: offered by a profile, its first preference, or an account of it', () => {
    const codexFirst = setupNeeds(config({ profiles: [profile({ preferredAgents: ['codex'] })] }))
    expect(codexFirst.agents).toEqual(['codex'])
    expect(isNeeded('claudeCode', codexFirst)).toBe(false)
    expect(isNeeded('claudeSignIn', codexFirst)).toBe(false)
    expect(isNeeded('codex', codexFirst)).toBe(true)
    const offered = setupNeeds(config({ profiles: [profile({ agentIds: ['kiro', 'opencode', 'shell'] })] }))
    expect(offered.agents.sort()).toEqual(['kiro', 'opencode'])
    const account = setupNeeds(config({ accounts: [{ id: 'g', agentId: 'gemini', name: 'Gemini' }] }))
    expect(account.agents).toEqual(['gemini'])
    // Claude Code over ACP signs in with Claude's accounts.
    expect(isNeeded('claudeSignIn', setupNeeds(config({ profiles: [profile({ agentIds: ['claude-acp'] })] })))).toBe(true)
  })

  it('Node is needed only by what runs on it: Codex (npx), Gemini CLI, a custom npx agent; never Claude', () => {
    expect(setupNeeds(config({ profiles: [profile({ agentIds: ['claude'] })] })).node).toEqual([])
    expect(setupNeeds(config({ profiles: [profile({ agentIds: ['claude', 'codex', 'gemini'] })] })).node).toEqual(['Codex', 'Gemini CLI'])
    const custom = { ...BUILTIN_AGENTS.find((a) => a.id === 'kiro')!, id: 'acme-agent', name: 'Acme agent', command: 'npx', builtIn: false }
    expect(setupNeeds(config({ profiles: [profile({ agentIds: ['acme-agent'] })] }), [...BUILTIN_AGENTS, custom]).node).toEqual(['Acme agent'])
    expect(nodeItem(NONE, ['Codex'])).toMatchObject({ status: 'missing', code: 'nodeMissingFor', params: { names: 'Codex' } })
  })

  it('marks rows optional from the needs, so only needed ones count as problems', () => {
    const needs = setupNeeds(config({ profiles: [profile({ preferredAgents: ['codex'] })] }))
    const rows = applyNeeds([claudeCodeItem(NONE), codexItem(NONE, NONE), gitItem(NONE), gitlabItem(NONE, null)], needs)
    expect(rows.map((r) => r.optional)).toEqual([true, false, false, true])
    expect(problemCount(rows)).toBe(2)
  })

  it('maps New session agents to their setup row', () => {
    expect(agentSetupKind('claude')).toBe('claudeCode')
    expect(agentSetupKind('gemini')).toBe('gemini')
    expect(agentSetupKind('claude-acp')).toBeNull()
    expect(agentSetupKind('shell')).toBeNull()
  })
})

describe('new rows', () => {
  it('codex checks npx and Node, not a codex command', () => {
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'))).toMatchObject({ status: 'ok', code: 'codexReady', params: { version: 'v22.3.0' } })
    expect(codexItem(NONE, ok('v22.3.0'), { platform: 'darwin', brew: true })).toMatchObject({ status: 'missing', code: 'codexNeedsNode', fix: { kind: 'install', installer: 'node', command: 'brew install node' } })
    expect(codexItem(ok('10.9.0'), NONE)).toMatchObject({ status: 'missing', code: 'codexNeedsNode' })
    expect(codexItem(TIMEOUT, ok('v22.3.0'))).toMatchObject({ status: 'warning', code: 'timeout', params: { command: 'npx --version' } })
  })

  it('codex: signed out signs in inside Workhub; without the codex command the sign-in is not read', () => {
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), undefined, FAILED)).toMatchObject({ status: 'missing', code: 'codexNotSignedIn', fix: { kind: 'signIn', tool: 'codex' } })
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), undefined, ok('Logged in using ChatGPT'))).toMatchObject({ status: 'ok', code: 'codexReady' })
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), undefined, NONE)).toMatchObject({ status: 'ok', code: 'codexReady' })
  })

  it('codex: without its command, a missing saved sign-in asks to install the command that signs in', () => {
    const win = { platform: 'win32', arch: 'x64', brew: false, npm: false }
    // No command and no saved sign-in: a session would end with "Authentication required".
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), win, NONE, false)).toMatchObject({ status: 'missing', code: 'codexNeedsCli', fix: { kind: 'install', installer: 'codex', managed: true } })
    // A saved sign-in found, or not looked at: ready.
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), win, NONE, true)).toMatchObject({ status: 'ok', code: 'codexReady' })
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), win, NONE, null)).toMatchObject({ status: 'ok', code: 'codexReady' })
    // The command answers: its word wins over the file.
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), win, ok('Logged in using ChatGPT'), false)).toMatchObject({ status: 'ok', code: 'codexReady' })
    expect(codexItem(ok('10.9.0'), ok('v22.3.0'), win, FAILED, true)).toMatchObject({ status: 'missing', code: 'codexNotSignedIn' })
    // Node.js missing too: still one install (the command comes with Node.js), not the adapter first and the command after.
    expect(codexItem(NONE, NONE, win, NONE, false)).toMatchObject({ status: 'missing', code: 'codexNeedsCli', fix: { kind: 'install', installer: 'codex', managed: true } })
    // Signed in some other way, or where Workhub cannot install the command itself: Node.js is what is missing.
    expect(codexItem(NONE, NONE, win, NONE, true)).toMatchObject({ code: 'codexNeedsNode', fix: { installer: 'codexAdapter' } })
    expect(codexItem(NONE, NONE, 'win32', NONE, false)).toMatchObject({ code: 'codexNeedsNode' })
  })

  it('opencode and gemini: version, missing with the right install, timeout', () => {
    expect(agentItem('opencode', ok('0.15.2'))).toMatchObject({ status: 'ok', params: { version: '0.15.2' } })
    expect(agentItem('opencode', NONE, 'linux')).toMatchObject({ status: 'missing', code: 'opencodeMissing', fix: { kind: 'install', installer: 'opencode' } })
    expect(agentItem('opencode', NONE, 'win32')).toMatchObject({ fix: { kind: 'link', url: 'https://opencode.ai/docs/' } })
    expect(agentItem('gemini', NONE, { platform: 'linux', npm: true })).toMatchObject({ code: 'geminiMissing', fix: { kind: 'install', command: 'npm install -g @google/gemini-cli' } })
    expect(agentItem('gemini', NONE, { platform: 'darwin', brew: true, npm: true })).toMatchObject({ fix: { command: 'brew install gemini-cli' } })
    expect(agentItem('gemini', NONE, { platform: 'win32' })).toMatchObject({ fix: { kind: 'link' } })
    expect(agentItem('gemini', TIMEOUT)).toMatchObject({ status: 'warning', params: { command: 'gemini --version' } })
  })

  it('git: version; missing or the macOS stub that fails; copy-only where it needs administrator rights', () => {
    expect(gitItem(ok('git version 2.47.1'))).toMatchObject({ status: 'ok', params: { version: '2.47.1' } })
    expect(gitItem(FAILED, { platform: 'darwin' })).toMatchObject({ status: 'missing', code: 'gitMissing', fix: { kind: 'install', command: 'xcode-select --install' } })
    expect(gitItem(NONE, { platform: 'win32' })).toMatchObject({ fix: { kind: 'adminCommand', command: 'winget install --id Git.Git -e --source winget', url: 'https://git-scm.com/install/windows' } })
    expect(gitItem(NONE, { platform: 'linux', brew: true })).toMatchObject({ fix: { kind: 'adminCommand', command: 'sudo apt-get install git' } })
    expect(gitItem(TIMEOUT)).toMatchObject({ status: 'warning', code: 'timeout' })
  })

  it('glab: missing, signed out, signed in (with the user when it says), timeout', () => {
    expect(gitlabItem(NONE, null, { platform: 'linux', brew: false })).toMatchObject({ status: 'missing', code: 'glabMissing', fix: { kind: 'link' } })
    expect(gitlabItem(NONE, null, { platform: 'linux', brew: true })).toMatchObject({ fix: { kind: 'install', command: 'brew install glab' } })
    expect(gitlabItem(ok('glab 1.50.0'), FAILED)).toMatchObject({ status: 'missing', code: 'glabNotSignedIn', fix: { kind: 'signIn', tool: 'gitlab' } })
    expect(gitlabItem(ok('glab 1.50.0'), ok('gitlab.com\n  ✓ Logged in to gitlab.com as octo (/home/x/.config/glab-cli/config.yml)'))).toMatchObject({ status: 'ok', code: 'ghSignedIn', params: { login: 'octo' } })
    expect(gitlabItem(ok('glab 1.50.0'), ok('ok'))).toMatchObject({ status: 'ok', code: 'signedIn' })
    // GitLab does not answer: the sign-in is unread, and still offered.
    expect(gitlabItem(ok('glab 1.50.0'), TIMEOUT)).toMatchObject({ status: 'warning', code: 'timeout', params: { command: 'glab auth status' }, fix: { kind: 'signIn', tool: 'gitlab' } })
    expect(gitlabItem(TIMEOUT, null).fix).toBeUndefined()
    expect(gitlabItem(ok('glab 1.50.0'), TIMEOUT)).toMatchObject({ status: 'warning', params: { command: 'glab auth status' } })
  })

  it('linear is a connection check: connected, no key, off', () => {
    const withLinear = config({ connections: [linear], profiles: [profile({ connections: { tracker: 'lin' } })] })
    expect(linearItem(withLinear, () => true)).toMatchObject({ status: 'ok', code: 'linearConnected', params: { names: 'Acme' } })
    expect(linearItem(withLinear, () => false)).toMatchObject({ status: 'warning', code: 'linearNoKey', params: { name: 'lin' }, fix: { kind: 'settings', tab: 'trackers' } })
    expect(linearItem(config(), () => false)).toMatchObject({ status: 'missing', code: 'linearOff' })
  })
})

describe('install table', () => {
  const all = Object.entries(INSTALLERS).flatMap(([tool, byPlatform]) => Object.entries(byPlatform).flatMap(([platform, methods]) => (methods as readonly InstallMethod[]).map((m) => ({ tool, platform, ...m }))))

  it('every command either runs without administrator rights or is marked copy-only', () => {
    expect(all.length).toBeGreaterThan(15)
    for (const m of all) {
      const elevates = /\bsudo\b|\b(apt|apt-get|dnf|yum|zypper|pacman|apk|choco|msiexec)\b|Git\.Git|-Verb RunAs/i.test(m.command)
      expect(m.mode === 'copy' || !elevates, `${m.tool}/${m.platform}: ${m.command}`).toBe(true)
    }
    expect(all.filter((m) => m.mode === 'copy').map((m) => `${m.tool}/${m.platform}`).sort()).toEqual(['git/linux', 'git/win32'])
  })

  it('never assumes Homebrew or npm (npm installs Workhub runs itself use its own Node.js), and never offers Homebrew for gh on Linux', () => {
    for (const m of all) {
      if (/^brew /.test(m.command)) expect(m.requires, m.command).toBe('brew')
      if (/^npm /.test(m.command) && !m.managed) expect(m.requires, m.command).toBe('npm')
    }
    expect(INSTALLERS.github.linux?.every((m) => m.managed)).toBe(true)
    expect(installMethod('github', { platform: 'linux', brew: true })).toBeNull()
    expect(installCommand('gitlab', { platform: 'darwin', brew: false })).toBeNull()
  })

  it('Workhub never runs a copy-only command', () => {
    expect(installCommand('git', 'linux')).toBeNull()
    expect(installCommand('git', 'win32')).toBeNull()
    expect(installFix('node', 'win32')).toMatchObject({ kind: 'link', title: 'downloadNode', admin: true })
  })
})

describe('installSource', () => {
  it('names where each command downloads from', () => {
    expect(installSource('curl -fsSL https://claude.ai/install.sh | bash')).toBe('claude.ai')
    expect(installSource('irm https://claude.ai/install.ps1 | iex')).toBe('claude.ai')
    expect(installSource('brew install gh')).toMatch(/^Homebrew/)
    expect(installSource('npm install -g @google/gemini-cli')).toMatch(/^npm/)
    expect(installSource('winget install --id GitHub.cli --source winget')).toMatch(/^winget/)
    expect(installSource('xcode-select --install')).toMatch(/^Apple/)
    expect(installSource('make install')).toBeNull()
  })

  it('every command Workhub may run says where it downloads from', () => {
    for (const platforms of Object.values(INSTALLERS)) {
      for (const methods of Object.values(platforms)) for (const m of methods ?? []) if (m.mode === 'run') expect(installSource(m.command), m.command).not.toBeNull()
    }
  })
})
