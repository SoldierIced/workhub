import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Profile, SecretStore, SetupItem, WorkhubConfig } from '@workhub/core'
import { expandEnvValue, profileSessionEnv, saveProfileEnv, storedProfileEnvNames } from '../src/main/profile-env'
import { probe, SETUP_NETWORK_TIMEOUT_MS, SetupService } from '../src/main/setup-service'
import { DICTIONARIES } from '../src/renderer/i18n/translate'
import { fixLabel, itemDetail, itemTitle, recheckOnFocus, SETUP_PROBLEMS_RECHECK_MS } from '../src/renderer/lib/setup'
import { installOutcome, keepLinesForCheck } from '../src/renderer/components/organisms/InstallMissing'
import { isStopSpeakingShortcut, lastFinishedReply, readsAloudByDefault, wpmToRate } from '../src/renderer/lib/readAloud'
import { envChanges, envNamesToSave, prunedFolderOptions } from '../src/renderer/screens/ProfileExtraSettings'
import { voiceOptions } from '../src/renderer/screens/VoiceSettings'
import { parseSetupHash } from '../src/renderer/screens/SetupWindows'
import type { ChatItem, SessionData } from '../src/renderer/store'

const t = (key: string, params: Record<string, string | number> = {}) => (DICTIONARIES.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
const tn = (base: string, count: number, params: Record<string, string | number> = {}) => t(`${base}.${count === 1 ? 'one' : 'other'}`, { count, ...params })

describe('probe', () => {
  it('reports ok, missing, failed and timeout', async () => {
    expect(await probe(process.execPath, ['--version'])).toMatchObject({ result: 'ok' })
    expect(await probe('workhub-no-such-command', [])).toMatchObject({ result: 'notFound' })
    expect(await probe(process.execPath, ['-e', 'console.log("bad"); process.exit(3)'])).toEqual({ result: 'failed', output: 'bad' })
    expect(await probe(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 150 })).toMatchObject({ result: 'timeout' })
  })

  // npm's shims (`npx.cmd`, `opencode.cmd`) usually sit under "Program Files" or Workhub's own data
  // folder, both with a space in the name. The shim is shaped like npm's: it forwards `%*`, which
  // is why the arguments are escaped for two rounds of parsing.
  it.runIf(process.platform === 'win32')('runs a command shim found in a folder with a space in its name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workhub probe '))
    try {
      writeFileSync(join(dir, 'tool.cmd'), `@"${process.execPath}" -e "console.log(process.argv[1] + ' 1.2.3')" %*\r\n`)
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'))
      expect(await probe('tool', ['a b'], { env: { ...env, PATH: `${dir};${process.env['PATH'] ?? ''}` } })).toEqual({ result: 'ok', output: 'a b 1.2.3' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installOutcome', () => {
  it('says how a finished queue ended, and nothing while it runs or before any install', () => {
    expect(installOutcome(null)).toBeNull()
    expect(installOutcome({ running: false, items: [] })).toBeNull()
    expect(installOutcome({ running: true, items: [{ installer: 'node', state: 'done' }] })).toBeNull()
    expect(installOutcome({ running: false, items: [{ installer: 'node', state: 'done' }, { installer: 'codexAdapter', state: 'done' }] })).toBe('done')
    expect(installOutcome({ running: false, items: [{ installer: 'node', state: 'done' }, { installer: 'opencode', state: 'failed', reason: 'npm' }] })).toBe('incomplete')
    expect(installOutcome({ running: false, items: [{ installer: 'node', state: 'canceled' }] })).toBe('incomplete')
  })
})

describe('keepLinesForCheck', () => {
  it('keeps the lines through the check the queue starts and drops them at the next one', () => {
    expect(keepLinesForCheck(1)).toBe(true)
    expect(keepLinesForCheck(2)).toBe(false)
  })
})

describe('recheckOnFocus', () => {
  it('reads the check again only while a problem shows, and not right after the last read', () => {
    const now = 1_000_000
    expect(recheckOnFocus(null, now)).toBe(false)
    expect(recheckOnFocus({ at: now - SETUP_PROBLEMS_RECHECK_MS * 10, count: 0 }, now)).toBe(false)
    expect(recheckOnFocus({ at: now - SETUP_PROBLEMS_RECHECK_MS + 1, count: 2 }, now)).toBe(false)
    expect(recheckOnFocus({ at: now - SETUP_PROBLEMS_RECHECK_MS, count: 2 }, now)).toBe(true)
  })
})

describe('SetupService', () => {
  const config: WorkhubConfig = {
    version: 8,
    connections: [],
    agents: [],
    accounts: [{ id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/workhub-test-claude-work' }],
    profiles: []
  }
  it('runs every check, one sign-in row per Claude login, with the account folder in the environment', async () => {
    const calls: { cmd: string; args: string[]; dir?: string; timeoutMs?: number }[] = []
    const service = new SetupService({
      config: async () => config,
      hasSecret: async () => false,
      path: () => '/bin',
      home: '/tmp/workhub-test-home',
      slackFailure: async () => null,
      run: async (cmd, args, options) => {
        calls.push({ cmd, args, dir: options?.env?.['CLAUDE_CONFIG_DIR'], timeoutMs: options?.timeoutMs })
        if (cmd === 'claude' && args[0] === 'auth') return { result: 'ok', output: '{"loggedIn":true,"email":"a@b.c"}' }
        if (cmd === 'gh' && args[0] === 'api') return { result: 'ok', output: 'octo' }
        if (cmd === 'glab' || cmd === 'opencode') return { result: 'notFound', output: '' }
        return { result: 'ok', output: cmd === 'node' ? 'v22.0.0' : '1.2.3' }
      }
    })
    const items = await service.run()
    expect(items.map((i) => i.id)).toEqual(['claudeCode', 'claudeSignIn:default', 'claudeSignIn:work', 'node', 'git', 'github', 'gitlab', 'profile', 'codex', 'kiro', 'opencode', 'gemini', 'linear', 'jira', 'slack', 'health', 'usage'])
    // Nothing chosen and no goal yet: Claude, git and a profile are needed; a host nobody uses is not.
    expect(items.filter((i) => !i.optional).map((i) => i.id)).toEqual(['claudeCode', 'claudeSignIn:default', 'claudeSignIn:work', 'git', 'profile'])
    expect(items.find((i) => i.id === 'gitlab')).toMatchObject({ status: 'missing', optional: true })
    expect(items.find((i) => i.id === 'codex')).toMatchObject({ status: 'ok', code: 'codexReady' })
    // Codex's own command only reads its sign-in; Kiro's sign-in is read once it is installed.
    expect(calls.filter((c) => c.cmd === 'codex').map((c) => c.args)).toEqual([['login', 'status']])
    expect(calls.filter((c) => c.cmd === 'kiro-cli').map((c) => c.args)).toEqual([['--version'], ['whoami']])
    expect(calls.find((c) => c.args[0] === 'auth' && c.dir)?.dir).toBe(resolve('/tmp/workhub-test-claude-work'))
    expect(items.find((i) => i.id === 'github')).toMatchObject({ status: 'ok', params: { login: 'octo' } })
    // A check that asks a server waits less than the others: one host not answering must not hold every row.
    expect(calls.find((c) => c.cmd === 'gh' && c.args[0] === 'api')?.timeoutMs).toBe(SETUP_NETWORK_TIMEOUT_MS)
    expect(calls.find((c) => c.cmd === 'gh' && c.args[0] === '--version')?.timeoutMs).toBeUndefined()
    expect(items.find((i) => i.id === 'profile')).toMatchObject({ status: 'missing' })
  })
  it('checks Claude Code, its sign-in and git inside the WSL host of the active profile, waiting while it connects', async () => {
    const local: string[] = []
    const make = (probe: ((tool: 'claude' | 'auth' | 'git') => Promise<{ result: 'ok'; output: string }>) | null) =>
      new SetupService({
        config: async () => config,
        hasSecret: async () => false,
        path: () => '/bin',
        home: '/tmp/workhub-test-home',
        slackFailure: async () => null,
        profileHost: () => ({ distro: 'Ubuntu', probe }),
        run: async (cmd, args) => {
          local.push(`${cmd} ${args[0]}`)
          return { result: 'notFound', output: '' }
        }
      })
    const pending = await make(null).run()
    expect(pending.filter((i) => ['claudeCode', 'claudeSignIn', 'git'].includes(i.kind)).map((i) => [i.id, i.status])).toEqual([
      ['claudeCode', 'pending'],
      ['claudeSignIn:wsl:Ubuntu', 'pending'],
      ['git', 'pending']
    ])
    const found = await make(async (tool) => ({ result: 'ok', output: tool === 'auth' ? '{"loggedIn":true,"email":"a@b.c"}' : '2.1.0' })).run()
    expect(found.filter((i) => ['claudeCode', 'claudeSignIn', 'git'].includes(i.kind)).map((i) => [i.id, i.status, i.params['host']])).toEqual([
      ['claudeCode', 'ok', 'Ubuntu'],
      ['claudeSignIn:wsl:Ubuntu', 'ok', 'Ubuntu'],
      ['git', 'ok', 'Ubuntu']
    ])
    // Windows' own Claude Code and git are not what these sessions use: they are not asked.
    expect(local.filter((c) => c.startsWith('claude ') || c.startsWith('git '))).toEqual([])
  })
  it('names the default folder for an account configured with it, as its sessions do', async () => {
    const dirs: (string | undefined)[] = []
    const service = new SetupService({
      config: async () => ({ ...config, accounts: [{ id: 'main', agentId: 'claude', name: 'Main', configDir: '/tmp/workhub-test-home/.claude' }] }),
      hasSecret: async () => false,
      path: () => '/bin',
      home: '/tmp/workhub-test-home',
      slackFailure: async () => null,
      run: async (cmd, args, options) => {
        if (cmd === 'claude' && args[0] === 'auth') dirs.push(options?.env?.['CLAUDE_CONFIG_DIR'])
        return { result: 'ok', output: '{"loggedIn":true}' }
      }
    })
    await service.run()
    expect(dirs).toEqual([resolve('/tmp/workhub-test-home/.claude')])
  })
})

describe('setup wording', () => {
  const item = (over: Partial<SetupItem>): SetupItem => ({ id: 'x', kind: 'node', status: 'ok', code: 'version', params: {}, optional: false, ...over })
  it('words titles, details and fixes', () => {
    expect(itemTitle(t, item({ kind: 'claudeSignIn', params: { name: 'Work' } }))).toBe('Claude sign-in · Work')
    expect(itemDetail(t, tn, item({ code: 'version', params: { version: 'v22.0.0' } }))).toBe('Version v22.0.0')
    expect(itemDetail(t, tn, item({ code: 'signedInAs', params: { who: 'a@b.c', plan: 'Max' } }))).toBe('Signed in as a@b.c · Max plan')
    expect(itemDetail(t, tn, item({ code: 'signedInAs', params: { who: '', plan: '' } }))).toBe('Signed in')
    expect(itemDetail(t, tn, item({ code: 'profileFolders', params: { names: 'Acme', count: '1' } }))).toBe('Acme · 1 folder')
    expect(fixLabel(t, { kind: 'settings', tab: 'trackers' })).toBe('Open Settings → Connections')
    expect(fixLabel(t, { kind: 'command', command: 'gh auth login' })).toBe('Copy command')
    expect(fixLabel(t, { kind: 'signIn', tool: 'claude' })).toBe('Sign in')
    expect(fixLabel(t, { kind: 'link', url: 'https://x', title: 'downloadNode' })).toBe('Download Node.js')
    expect(fixLabel(t, { kind: 'adminCommand', installer: 'git', command: 'sudo apt-get install git', url: 'https://x' })).toBe('Copy command')
    expect(itemTitle(t, item({ kind: 'gitlab' }))).toBe('GitLab (glab)')
    // A row checked inside a WSL host names it.
    expect(itemTitle(t, item({ kind: 'git', params: { host: 'Ubuntu' } }))).toBe('git (WSL: Ubuntu)')
    expect(itemDetail(t, tn, item({ status: 'pending', code: 'hostPending', params: { host: 'Ubuntu' } }))).toBe('Checked in Ubuntu once Workhub is running there.')
    expect(t('setup.statusPending')).toBe('Waiting')
    expect(itemDetail(t, tn, item({ code: 'nodeMissingFor', params: { names: 'Codex, Gemini CLI' } }))).toBe('Not found. Codex, Gemini CLI runs on Node.js: install it, then check again.')
  })
  it('every message code the checks can produce has copy', () => {
    for (const code of ['version', 'claudeMissing', 'timeout', 'commandFailed', 'installClaudeFirst', 'authUnreadable', 'notSignedIn', 'signedIn', 'nodeMissingFor', 'nodeNotNeeded', 'gitMissing', 'ghMissing', 'ghNoAnswer', 'ghNotSignedIn', 'ghSignedIn', 'glabMissing', 'glabNotSignedIn', 'codexReady', 'codexNeedsNode', 'codexNeedsCli', 'codexNotSignedIn', 'kiroMissing', 'kiroNotSignedIn', 'opencodeMissing', 'geminiMissing', 'linearConnected', 'linearNoKey', 'linearOff', 'noFolders', 'jiraConnected', 'jiraNoToken', 'jiraOff', 'slackOff', 'slackFailing', 'healthConfigured', 'healthIncomplete', 'healthOff', 'usageOn', 'usageOff', 'hostPending', 'hostNotSignedIn']) {
      expect(DICTIONARIES.en[`setup.msg.${code}` as keyof typeof DICTIONARIES.en], code).toBeTruthy()
    }
  })
  it('routes the setup window hashes', () => {
    expect(parseSetupHash('#welcome')).toBe('welcome')
    expect(parseSetupHash('#/setup')).toBe('check')
    expect(parseSetupHash('#howitworks')).toBe('help')
    expect(parseSetupHash('#pr?profile=a')).toBeNull()
  })
})

describe('read aloud', () => {
  const agent = (id: number, text: string): ChatItem => ({ id, kind: 'agent', text })
  it('takes the agent messages of the last finished turn only', () => {
    const items: ChatItem[] = [
      { id: 1, kind: 'user', text: 'hi' },
      agent(2, 'First part.'),
      agent(3, 'Second part.'),
      { id: 4, kind: 'turnEnd', stopReason: 'end_turn' },
      { id: 5, kind: 'user', text: 'again' },
      agent(6, 'Streaming…')
    ]
    expect(lastFinishedReply(items)).toEqual({ turnId: 4, markdown: 'First part.\n\nSecond part.' })
    expect(lastFinishedReply(items.slice(4))).toBeNull()
    expect(lastFinishedReply([{ id: 1, kind: 'user', text: 'x' }, agent(2, 'cut'), { id: 3, kind: 'turnEnd', stopReason: 'cancelled' }])).toBeNull()
  })
  it('converts words per minute to a speech rate', () => {
    expect(wpmToRate(175)).toBe(1)
    expect(wpmToRate(10)).toBeCloseTo(120 / 175, 2)
    expect(wpmToRate(1000)).toBeCloseTo(300 / 175, 2)
  })
  it('recognizes the stop shortcut by the physical key (Option changes the character on macOS)', () => {
    const e = { code: 'Period', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }
    expect(isStopSpeakingShortcut(e, 'mac')).toBe(true)
    expect(isStopSpeakingShortcut({ ...e, altKey: false }, 'mac')).toBe(false)
    expect(isStopSpeakingShortcut(e, 'windows')).toBe(false)
    expect(isStopSpeakingShortcut({ ...e, metaKey: false, ctrlKey: true }, 'windows')).toBe(true)
  })
  it('lists voices by language then name', () => {
    expect(voiceOptions([{ name: 'Zoe', lang: 'en_US' }, { name: 'Ana', lang: 'es-AR' }, { name: 'Amy', lang: 'en_US' }]).map((v) => v.label)).toEqual(['Amy (en-US)', 'Zoe (en-US)', 'Ana (es-AR)'])
  })
})

describe('profile environment', () => {
  const store = (): SecretStore & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return { data, get: async (r) => data.get(r) ?? null, set: async (r, v) => void data.set(r, v), delete: async (r) => void data.delete(r), has: async (r) => data.has(r) }
  }
  const profile: Profile = { id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false }, folders: ['~/work'], envNames: ['TOKEN', 'ROOT', '1BAD'] }

  it('keeps values in the secret store and expands the folder variables for a session', async () => {
    const secrets = store()
    await saveProfileEnv('acme', { TOKEN: 's3cret', ROOT: '${PROFILE_ROOT}/x:${FOLDER}', '1BAD': 'no' }, [], secrets)
    expect([...secrets.data.keys()].sort()).toEqual(['profile-env:acme:ROOT', 'profile-env:acme:TOKEN'])
    expect(await profileSessionEnv(profile, '/repo', secrets, '/home/u')).toEqual({ TOKEN: 's3cret', ROOT: '/home/u/work/x:/repo' })
    expect(await storedProfileEnvNames(profile, secrets)).toEqual(['TOKEN', 'ROOT'])
    await saveProfileEnv('acme', {}, ['TOKEN'], secrets)
    expect(await storedProfileEnvNames(profile, secrets)).toEqual(['ROOT'])
    expect(await profileSessionEnv(undefined, '/repo', secrets, '/h')).toEqual({})
  })
  it('expands both variables', () => {
    expect(expandEnvValue('${FOLDER}|${PROFILE_ROOT}', { folder: '/a', profileRoot: '/b' })).toBe('/a|/b')
  })
  it('the form saves valid names that have a value and forgets the removed ones', () => {
    const rows = [
      { name: 'TOKEN', value: '', stored: true },
      { name: 'NEW', value: 'v', stored: false },
      { name: 'EMPTY', value: '', stored: false },
      { name: '9bad', value: 'x', stored: false },
      { name: 'TOKEN', value: 'dup', stored: false }
    ]
    expect(envNamesToSave(rows)).toEqual(['TOKEN', 'NEW'])
    expect(envChanges(rows, ['TOKEN', 'GONE'])).toEqual({ values: { NEW: 'v' }, removed: ['GONE'] })
  })
  it('drops folder options of folders that left the profile and the empty ones', () => {
    expect(prunedFolderOptions({ '/a': { onlyGitRepos: true }, '/b': { subfoldersAreProjects: true }, '/c': { onlyGitRepos: false }, '/d': {} }, ['/a', ' /c ', '/d'])).toEqual({
      '/a': { onlyGitRepos: true },
      '/c': { onlyGitRepos: false }
    })
    expect(prunedFolderOptions(undefined, ['/a'])).toBeUndefined()
  })
  it('keeps a folder\'s worktree choice, and drops it once it follows the profile again', () => {
    expect(prunedFolderOptions({ '/a': { worktrees: false }, '/b': { worktrees: undefined } }, ['/a', '/b'])).toEqual({ '/a': { worktrees: false } })
  })
  it('saves "Automatic" as an unset subfolder switch', () => {
    expect(prunedFolderOptions({ '/a': { onlyGitRepos: true, subfoldersAreProjects: undefined }, '/b': { subfoldersAreProjects: undefined } }, ['/a', '/b'])).toEqual({
      '/a': { onlyGitRepos: true }
    })
  })
})
