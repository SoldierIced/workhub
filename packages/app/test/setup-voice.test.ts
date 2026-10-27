import { describe, expect, it } from 'vitest'
import type { Profile, SecretStore, SetupItem, WorkhubConfig } from '@workhub/core'
import { linkCommand } from '../src/main/link-opener'
import { expandEnvValue, profileSessionEnv, saveProfileEnv, storedProfileEnvNames } from '../src/main/profile-env'
import { probe, SetupService } from '../src/main/setup-service'
import { DICTIONARIES } from '../src/renderer/i18n/translate'
import { fixLabel, itemDetail, itemTitle } from '../src/renderer/lib/setup'
import { isStopSpeakingShortcut, lastFinishedReply, wpmToRate } from '../src/renderer/lib/readAloud'
import { envChanges, envNamesToSave, prunedFolderOptions } from '../src/renderer/screens/ProfileExtraSettings'
import { voiceOptions } from '../src/renderer/screens/VoiceSettings'
import { parseSetupHash } from '../src/renderer/screens/SetupWindows'
import type { ChatItem } from '../src/renderer/store'

const t = (key: string, params: Record<string, string | number> = {}) => (DICTIONARIES.en as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''))
const tn = (base: string, count: number, params: Record<string, string | number> = {}) => t(`${base}.${count === 1 ? 'one' : 'other'}`, { count, ...params })

describe('probe', () => {
  it('reports ok, missing, failed and timeout', async () => {
    expect(await probe(process.execPath, ['--version'])).toMatchObject({ result: 'ok' })
    expect(await probe('workhub-no-such-command', [])).toMatchObject({ result: 'notFound' })
    expect(await probe(process.execPath, ['-e', 'console.log("bad"); process.exit(3)'])).toEqual({ result: 'failed', output: 'bad' })
    expect(await probe(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeoutMs: 150 })).toMatchObject({ result: 'timeout' })
  })
})

describe('SetupService', () => {
  const config: WorkhubConfig = {
    version: 7,
    connections: [],
    agents: [],
    accounts: [{ id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/workhub-test-claude-work' }],
    profiles: []
  }
  it('runs every check, one sign-in row per Claude login, with the account folder in the environment', async () => {
    const calls: { cmd: string; args: string[]; dir?: string }[] = []
    const service = new SetupService({
      config: async () => config,
      hasSecret: async () => false,
      path: () => '/bin',
      home: '/tmp/workhub-test-home',
      slackFailure: async () => null,
      run: async (cmd, args, options) => {
        calls.push({ cmd, args, dir: options?.env?.['CLAUDE_CONFIG_DIR'] })
        if (cmd === 'claude' && args[0] === 'auth') return { result: 'ok', output: '{"loggedIn":true,"email":"a@b.c"}' }
        if (cmd === 'gh' && args[0] === 'api') return { result: 'ok', output: 'octo' }
        return { result: 'ok', output: cmd === 'node' ? 'v22.0.0' : '1.2.3' }
      }
    })
    const items = await service.run()
    expect(items.map((i) => i.id)).toEqual(['claudeCode', 'claudeSignIn:default', 'claudeSignIn:work', 'node', 'github', 'profile', 'codex', 'kiro', 'jira', 'slack', 'health', 'usage'])
    expect(calls.find((c) => c.args[0] === 'auth' && c.dir)?.dir).toBe('/tmp/workhub-test-claude-work')
    expect(items.find((i) => i.id === 'github')).toMatchObject({ status: 'ok', params: { login: 'octo' } })
    expect(items.find((i) => i.id === 'profile')).toMatchObject({ status: 'missing' })
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
    expect(fixLabel(t, { kind: 'settings', tab: 'trackers' })).toBe('Open Settings → Trackers')
    expect(fixLabel(t, { kind: 'command', command: 'gh auth login' })).toBe('Copy command')
    expect(fixLabel(t, { kind: 'link', url: 'https://x', title: 'downloadNode' })).toBe('Download Node.js')
  })
  it('every message code the checks can produce has copy', () => {
    for (const code of ['version', 'claudeMissing', 'timeout', 'commandFailed', 'installClaudeFirst', 'authUnreadable', 'notSignedIn', 'nodeMissing', 'ghMissing', 'ghNoAnswer', 'ghNotSignedIn', 'ghSignedIn', 'codexMissing', 'kiroMissing', 'noFolders', 'jiraConnected', 'jiraNoToken', 'jiraOff', 'slackOff', 'slackFailing', 'healthConfigured', 'healthIncomplete', 'healthOff', 'usageOn', 'usageOff']) {
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
  const profile: Profile = { id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false }, folders: ['~/work'], envNames: ['TOKEN', 'ROOT', '1BAD'] }

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
    expect(prunedFolderOptions({ '/a': { onlyGitRepos: true }, '/b': { subfoldersAreProjects: true }, '/c': { onlyGitRepos: false } }, ['/a', ' /c '])).toEqual({ '/a': { onlyGitRepos: true } })
    expect(prunedFolderOptions(undefined, ['/a'])).toBeUndefined()
  })
})

describe('link opener', () => {
  it('opens a web link in the chosen browser, as one argument', () => {
    expect(linkCommand('darwin', 'Google Chrome', 'https://x.y/?a=1&b=2')).toEqual({ command: 'open', args: ['-a', 'Google Chrome', 'https://x.y/?a=1&b=2'] })
    expect(linkCommand('linux', 'chromium', 'https://x.y')).toEqual({ command: 'chromium', args: ['https://x.y'] })
  })
  it('uses the default browser when none is set or the link is not a web link', () => {
    expect(linkCommand('darwin', undefined, 'https://x.y')).toBeNull()
    expect(linkCommand('darwin', '  ', 'https://x.y')).toBeNull()
    expect(linkCommand('darwin', 'Safari', 'file:///etc/passwd')).toBeNull()
  })
})
