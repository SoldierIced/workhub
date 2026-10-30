import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  emptyConfig,
  historyInProfile,
  isThrowawayFolder,
  NO_CAPABILITIES,
  sessionsOfFolder,
  type AgentEventListener,
  type AgentRuntime,
  type ConfigurationService,
  type HistoryEntry,
  type StartSessionRequest
} from '@workhub/core'
import { buildAppMenuTemplate, newSessionKeys, type AppMenuInput, type MenuAgent } from '../src/main/app-menu'
import { cleanSessionName, MAX_SESSION_NAME, SessionNames } from '../src/main/session-names'
import { SessionManager } from '../src/main/session-manager'
import { StateFile } from '../src/main/state-file'
import { openSessionsByHistory, visibleHistory } from '../src/renderer/screens/HistoryScreen'
import { parseSessionWindowHash, parseSubagentWindowHash, sessionTitle } from '../src/renderer/lib/windows'
import { sessionWindowHash, subagentWindowHash } from '../src/main/session-windows'
import type { HistoryItem, SessionView } from '../src/shared/api'
import type { MenuCommand } from '../src/shared/windows-api'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'

// --- Application menu ---------------------------------------------------------------------------

const AGENTS: MenuAgent[] = [
  { key: 'claude', label: 'Claude Code', agentId: 'claude' },
  { key: 'claude:work', label: 'Claude Code · Work', agentId: 'claude' },
  { key: 'codex', label: 'Codex', agentId: 'codex' },
  { key: 'shell', label: 'Shell', agentId: 'shell' }
]

function menu(over: Partial<AppMenuInput> = {}) {
  const ran: MenuCommand[] = []
  const template = buildAppMenuTemplate({
    platform: 'darwin',
    appName: 'Workhub 2',
    agents: AGENTS,
    t: (key, params) => (params ? `${key}(${Object.values(params).join(',')})` : key),
    run: (c) => ran.push(c),
    openHelp: vi.fn(),
    developer: false,
    ...over
  })
  return { template, ran }
}

const items = (m: MenuItemConstructorOptions | undefined) => (m?.submenu ?? []) as MenuItemConstructorOptions[]
const byLabel = (template: MenuItemConstructorOptions[], label: string) => template.find((m) => m.label === label)
const click = (item: MenuItemConstructorOptions | undefined) => (item?.click as (() => void) | undefined)?.()

describe('application menu', () => {
  it('gives Workhub 1 keys to new sessions: the first agent ⌘L, a shell ⌘Y (⌘T is the generic quick session)', () => {
    expect([...newSessionKeys(AGENTS)]).toEqual([
      ['claude', 'L'],
      ['shell', 'Y']
    ])
  })

  it('macOS: app menu with Settings, then File, Edit, View, Window and Help', () => {
    const { template } = menu()
    expect(template.map((m) => m.label ?? m.role)).toEqual(['Workhub 2', 'menu.file', 'menu.edit', 'menu.view', 'menu.window', 'menu.help'])
    expect(items(template[0]).some((i) => i.label === 'menu.settings' && i.accelerator === 'CmdOrCtrl+,')).toBe(true)
    // Copy and paste only work in text fields through the Edit menu on macOS.
    expect(template.find((m) => m.role === 'editMenu')).toBeDefined()
  })

  it('Help: the setup windows (check, welcome, how it works), then the project page', () => {
    const opened: string[] = []
    const { template } = menu({ openSetup: (page) => opened.push(page) })
    const help = items(template.find((m) => m.role === 'help')!)
    expect(help.map((i) => i.label ?? i.type)).toEqual(['menu.setupCheck', 'menu.welcome', 'menu.howItWorks(Workhub 2)', 'separator', 'menu.helpPage(Workhub 2)'])
    for (const i of help) (i.click as (() => void) | undefined)?.()
    expect(opened).toEqual(['check', 'welcome', 'help'])
  })

  it('File: one new session per agent, open in a new window ⇧⌘N and close session ⇧⌘W', () => {
    const { template, ran } = menu()
    const file = items(byLabel(template, 'menu.file'))
    const quick = file.filter((i) => i.accelerator === 'CmdOrCtrl+T')
    expect(quick.map((i) => i.label)).toEqual(['menu.newSession'])
    click(quick[0])
    const news = file.filter((i) => String(i.label).startsWith('menu.newAgentSession'))
    expect(news.map((i) => [i.label, i.accelerator])).toEqual([
      ['menu.newAgentSession(Claude Code)', 'CmdOrCtrl+L'],
      ['menu.newAgentSession(Claude Code · Work)', undefined],
      ['menu.newAgentSession(Codex)', undefined],
      ['menu.newAgentSession(Shell)', 'CmdOrCtrl+Y']
    ])
    click(news[1])
    click(file.find((i) => i.label === 'menu.openInNewWindow'))
    click(file.find((i) => i.accelerator === 'CmdOrCtrl+Shift+W'))
    expect(ran).toEqual([{ kind: 'newSession' }, { kind: 'newSession', agentKey: 'claude:work' }, { kind: 'openInWindow' }, { kind: 'closeSession' }])
    expect(file.find((i) => i.label === 'menu.openInNewWindow')?.accelerator).toBe('CmdOrCtrl+Shift+N')
  })

  it('View: ⌘1-⌘8 screens (⌘7 is Flow maps), ⌘0 Sessions, ⌥⌘1-3 show as App, Console, Shell', () => {
    const { template, ran } = menu()
    const view = items(byLabel(template, 'menu.view'))
    const keyed = view.filter((i) => i.accelerator).map((i) => i.accelerator)
    expect(keyed.slice(0, 9)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+4', 'CmdOrCtrl+5', 'CmdOrCtrl+6', 'CmdOrCtrl+7', 'CmdOrCtrl+8', 'CmdOrCtrl+0'])
    click(view.find((i) => i.accelerator === 'CmdOrCtrl+6'))
    click(view.find((i) => i.accelerator === 'CmdOrCtrl+Alt+2'))
    expect(ran).toEqual([{ kind: 'navigate', route: 'history' }, { kind: 'showMode', mode: 'console' }])
    expect(view.some((i) => i.role === 'toggleDevTools')).toBe(false)
    expect(items(byLabel(menu({ developer: true }).template, 'menu.view')).some((i) => i.role === 'toggleDevTools')).toBe(true)
  })

  it('Windows and Linux: no app or Window menu; Settings and Quit go in File', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { template } = menu({ platform })
      expect(template.map((m) => m.label)).toEqual(['menu.file', 'menu.edit', 'menu.view', 'menu.help'])
      const file = items(template[0])
      expect(file.at(-1)?.role).toBe('quit')
      expect(file.some((i) => i.label === 'menu.settings')).toBe(true)
    }
  })

  it('without agents still offers a plain new session on ⌘T', () => {
    const { template, ran } = menu({ agents: [] })
    const first = items(byLabel(template, 'menu.file'))[0]
    expect([first?.label, first?.accelerator]).toEqual(['menu.newSession', 'CmdOrCtrl+T'])
    click(first)
    expect(ran).toEqual([{ kind: 'newSession' }])
  })

  it('labels every menu key in English and Spanish', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('menu.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const k of keys) expect(es[k as keyof typeof es]).toBeTruthy()
  })
})

// --- Renaming -------------------------------------------------------------------------------------

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'workhub-names-')), name)

describe('session names', () => {
  it('keeps one trimmed line, cut to the limit; empty forgets', () => {
    expect(cleanSessionName('  Fix   the\nlogin  ')).toBe('Fix the login')
    expect(cleanSessionName('x'.repeat(500))).toHaveLength(MAX_SESSION_NAME)
    expect(cleanSessionName('   ')).toBeUndefined()
    expect(cleanSessionName(null)).toBeUndefined()
  })

  it('persists names by identity across restarts, and moves one to a real identity', () => {
    const path = tempFile('session-names.json')
    const names = new SessionNames(new StateFile(path, 10))
    names.set('a', ' Login bug ')
    names.set('b', 'Temp')
    names.move('b', 'real-b')
    names.set('a', 'Login bug')
    names.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ names: { a: 'Login bug', 'real-b': 'Temp' } })
    const again = new SessionNames(new StateFile(path, 10))
    expect([again.get('a'), again.get('b'), again.get('real-b')]).toEqual(['Login bug', undefined, 'Temp'])
    again.set('a', '')
    again.flush()
    expect(new SessionNames(new StateFile(path, 10)).get('a')).toBeUndefined()
  })

  it('a renamed session keeps its name when it is opened again (resumed under the same id)', async () => {
    const path = tempFile('session-names.json')
    const runtime: AgentRuntime = {
      adapter: 'native',
      capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
      start: async (r: StartSessionRequest) => ({ agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      stop: async () => {},
      stopAll: async () => {},
      respondPermission: () => {},
      subscribe: (_l: AgentEventListener) => () => {}
    }
    const make = () => {
      const changed: SessionView[] = []
      const manager = new SessionManager({
        config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
        runtimes: { native: runtime },
        terminal: runtime,
        transcripts: [],
        history: {},
        names: new SessionNames(new StateFile(path, 10)),
        emitEvent: () => {},
        emitChanged: (s) => changed.push(s),
        emitReplay: () => {},
        pollMs: 60_000
      })
      return { manager, changed }
    }
    const first = make()
    const view = await first.manager.start({ profileId: null, agentKey: 'claude', cwd: '/work/app' })
    first.manager.rename(view.id, '  Payments refactor ')
    expect(first.changed.at(-1)).toMatchObject({ id: view.id, name: 'Payments refactor' })
    ;(first.manager as unknown as { deps: { names: SessionNames } }).deps.names.flush()

    // A restart: a new manager reads the stored names; resuming the agent session brings the name back.
    const second = make()
    const resumed = await second.manager.start({ profileId: null, agentKey: 'claude', cwd: '/work/app', resumeAgentSessionId: view.agentSessionId })
    expect(resumed.name).toBe('Payments refactor')
    second.manager.rename(resumed.id, null)
    expect(second.changed.at(-1)?.name).toBeUndefined()
  })

  it('shows the name, else the agent name', () => {
    expect(sessionTitle({ name: 'Mine', agentName: 'Claude Code' })).toBe('Mine')
    expect(sessionTitle({ agentName: 'Claude Code' })).toBe('Claude Code')
  })
})

// --- History --------------------------------------------------------------------------------------

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  agentId: 'claude',
  accountId: null,
  agentSessionId: 's',
  title: 't',
  lastModified: 1,
  agentName: 'Claude Code',
  resumable: true,
  ...over
})

describe('history filtering', () => {
  it('treats sessions under /tmp and /var/folders as throwaway', () => {
    expect(['/tmp/x', '/private/tmp/x', '/var/folders/ab/T/x', '/private/var/folders/ab', '/tmp'].map(isThrowawayFolder)).toEqual([true, true, true, true, true])
    expect(['/Users/me/tmp/x', '/work/var/folders', undefined, ''].map(isThrowawayFolder)).toEqual([false, false, false, false])
  })

  it('a profile owns the sessions in its folders and of its accounts; one with neither owns all', () => {
    const profile = { folders: ['/work/acme'], accountIds: ['acc-w'] }
    expect(historyInProfile({ cwd: '/work/acme/api' }, profile)).toBe(true)
    expect(historyInProfile({ cwd: '/work/acme' }, profile)).toBe(true)
    expect(historyInProfile({ cwd: '/work/acme-other' }, profile)).toBe(false)
    expect(historyInProfile({ cwd: '/home/x', accountId: 'acc-w' }, profile)).toBe(true)
    expect(historyInProfile({ cwd: '/home/x', accountId: null }, profile)).toBe(false)
    expect(historyInProfile({ cwd: '/anything', accountId: null }, { accountIds: [] })).toBe(true)
  })

  it('lists no throwaway sessions, then filters by agent, account and profile', () => {
    const entries = [
      item({ agentSessionId: 'a', cwd: '/work/acme/api' }),
      item({ agentSessionId: 'b', cwd: '/tmp/scratch' }),
      item({ agentSessionId: 'c', cwd: '/home/me/side', accountId: 'p' }),
      item({ agentSessionId: 'd', cwd: '/work/acme/web', agentId: 'kiro', agentName: 'Kiro' })
    ]
    const ids = (list: HistoryItem[]) => list.map((e) => e.agentSessionId)
    expect(ids(visibleHistory(entries, { agent: '*', account: '*' }))).toEqual(['a', 'c', 'd'])
    expect(ids(visibleHistory(entries, { agent: 'claude', account: '*' }))).toEqual(['a', 'c'])
    expect(ids(visibleHistory(entries, { agent: '*', account: 'p' }))).toEqual(['c'])
    expect(ids(visibleHistory(entries, { agent: '*', account: '*', profile: { folders: ['/work/acme'], accountIds: [] } }))).toEqual(['a', 'd'])
  })

  it('marks open sessions by their agent session id, never stopped ones', () => {
    const view = (over: Partial<SessionView>) => ({ id: 'w', agentId: 'claude', state: 'ready', agentSessionId: 'a', ...over }) as SessionView
    const open = openSessionsByHistory([view({}), view({ id: 'x', agentSessionId: 'b', state: 'stopped' }), view({ id: 'y', agentSessionId: undefined })])
    expect([...open]).toEqual([['claude\u0000a', 'w']])
  })

  it("a folder's Resume sheet: that folder only, open sessions left out, newest first, searchable by title and first prompt", () => {
    const e = (id: string, cwd: string, lastModified: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ agentId: 'claude', accountId: null, agentSessionId: id, title: id, cwd, lastModified, ...over })
    const entries = [e('old', '/work/api', 1), e('new', '/work/api/', 3, { firstPrompt: 'fix the login page' }), e('sub', '/work/api/src', 5), e('live', '/work/api', 4)]
    const open = new Set(['claude\u0000live'])
    expect(sessionsOfFolder(entries, '/work/api', open).map((x) => x.agentSessionId)).toEqual(['new', 'old'])
    expect(sessionsOfFolder(entries, '/work/api', open, 'login').map((x) => x.agentSessionId)).toEqual(['new'])
  })
})

// --- Session windows --------------------------------------------------------------------------------

describe('session window hashes', () => {
  it('round-trip between main and the renderer', () => {
    expect(parseSessionWindowHash(sessionWindowHash('a b/c'))).toEqual({ sessionId: 'a b/c' })
    expect(parseSubagentWindowHash(subagentWindowHash('s1', 'agent&2'))).toEqual({ sessionId: 's1', subagentId: 'agent&2' })
    expect(parseSessionWindowHash('#pr?url=x')).toBeNull()
    expect(parseSubagentWindowHash('#subagent?session=s1')).toBeNull()
  })
})
