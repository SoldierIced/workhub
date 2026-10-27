import { describe, expect, it } from 'vitest'
import { NO_MODULES } from '@workhub/core'
import type { Profile } from '@workhub/core'
import { attentionOf, folderName, formatTokens, groupByAttention, hasConnection, planUsage, recentFolders, tokensByFolder, type SessionSummary } from '../src/renderer/lib/home'
import { allNavItems, visibleNavItems } from '../src/renderer/lib/nav'
import { parsePrefs, resolveTheme } from '../src/renderer/lib/prefs'
import type { ChatItem } from '../src/renderer/store'

describe('navigation', () => {
  it('hides module screens while their module is off', () => {
    expect(visibleNavItems(undefined).map((i) => i.route)).toEqual(['home', 'pullRequests', 'tickets', 'history'])
    expect(visibleNavItems({ ...NO_MODULES, flows: true, chatWatcher: true }).map((i) => i.route)).toEqual([
      'home',
      'pullRequests',
      'tickets',
      'slack',
      'history',
      'flows'
    ])
  })

  it('keeps Workhub 1 keys and adds Sessions and Settings', () => {
    const all = allNavItems({ flows: true, health: true, chatWatcher: true, automations: true })
    expect(all.map((i) => i.shortcut.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '0', ','])
  })
})

let id = 0
const session = (state: SessionSummary['view']['state'], items: ChatItem[] = [], extra: Partial<SessionSummary> = {}): SessionSummary => ({
  view: { id: `s${++id}`, state, cwd: '/work/acme', startedAt: id },
  items,
  monitor: {},
  ...extra
})
const agent = (text = 'hi'): ChatItem => ({ id: ++id, kind: 'agent', text })
const user = (text = 'q'): ChatItem => ({ id: ++id, kind: 'user', text })

describe('attentionOf', () => {
  it('puts an unanswered permission request first, whatever the state', () => {
    const permission: ChatItem = { id: ++id, kind: 'permission', requestId: 'r', title: 'Run tests', options: [] }
    expect(attentionOf(session('busy', [permission]))).toBe('needsReply')
    expect(attentionOf(session('busy', [{ ...permission, answer: 'Allow' }]))).toBe('working')
  })

  it('maps states', () => {
    expect(attentionOf(session('error'))).toBe('error')
    expect(attentionOf(session('starting'))).toBe('working')
    expect(attentionOf(session('stopped', [user(), agent()]))).toBeNull()
  })

  it('calls an idle session ready only once the agent answered', () => {
    expect(attentionOf(session('ready'))).toBeNull()
    expect(attentionOf(session('ready', [user()]))).toBeNull()
    expect(attentionOf(session('ready', [user(), agent(), { id: ++id, kind: 'turnEnd', stopReason: 'end_turn' }]))).toBe('ready')
  })

  it('groups sessions newest first', () => {
    const a = session('busy')
    const b = session('busy')
    const g = groupByAttention([a, b, session('error')])
    expect(g.working.map((s) => s.view.id)).toEqual([b.view.id, a.view.id])
    expect(g.error).toHaveLength(1)
    expect(g.needsReply).toHaveLength(0)
  })
})

describe('home figures', () => {
  it('reads folder names from POSIX and Windows paths', () => {
    expect(folderName('/Users/acme/work/api')).toBe('api')
    expect(folderName('C:\\work\\acme\\web\\')).toBe('web')
  })

  it('sums tokens per folder, largest first, skipping sessions without data', () => {
    const list = [
      session('ready', [], { monitor: { tokens: { total: 100 } } }),
      { ...session('ready', [], { monitor: { tokens: { input: 300, output: 50 } } }), view: { id: 'x', state: 'ready' as const, cwd: '/work/web', startedAt: 1 } },
      session('ready', [], { monitor: { tokens: { total: 20 } } }),
      session('ready')
    ]
    expect(tokensByFolder(list)).toEqual([
      { path: '/work/web', folder: 'web', tokens: 350 },
      { path: '/work/acme', folder: 'acme', tokens: 120 }
    ])
  })

  it('keeps the highest percent per plan window', () => {
    const list = [
      session('ready', [], { monitor: { planUsage: [{ window: '5h', percent: 10 }] } }),
      session('ready', [], { monitor: { planUsage: [{ window: '5h', percent: 40 }, { window: 'weekly', percent: 5 }] } })
    ]
    expect(planUsage(list)).toEqual([
      { window: '5h', percent: 40 },
      { window: 'weekly', percent: 5 }
    ])
  })

  it('lists distinct folders, most recent first', () => {
    const older = { ...session('ready'), view: { id: 'o', state: 'ready' as const, cwd: '/a', startedAt: 1 } }
    const newer = { ...session('ready'), view: { id: 'n', state: 'ready' as const, cwd: '/b', startedAt: 9 } }
    const again = { ...session('ready'), view: { id: 'g', state: 'ready' as const, cwd: '/a', startedAt: 5 } }
    expect(recentFolders([older, newer, again])).toEqual(['/b', '/a'])
  })

  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(646_100)).toBe('646k')
    expect(formatTokens(5_500_000)).toBe('5.5M')
  })

  it('knows whether a profile has a connection of a kind', () => {
    const profile: Profile = { id: 'acme', name: 'Acme', connections: { codeHost: 'acme-github' }, accountIds: [], modules: NO_MODULES }
    expect(hasConnection(profile, 'codeHost')).toBe(true)
    expect(hasConnection(profile, 'tracker')).toBe(false)
    expect(hasConnection(undefined, 'codeHost')).toBe(false)
  })
})

describe('preferences', () => {
  it('parse stored values and fall back on anything unexpected', () => {
    expect(parsePrefs(null)).toEqual({ theme: 'system', language: 'system', models: {}, modes: {} })
    expect(parsePrefs('{"theme":"light","language":"es"}')).toEqual({ theme: 'light', language: 'es', models: {}, modes: {} })
    expect(parsePrefs('{"theme":"neon","language":"fr","models":[1]}')).toEqual({ theme: 'system', language: 'system', models: {}, modes: {} })
    expect(parsePrefs('not json')).toEqual({ theme: 'system', language: 'system', models: {}, modes: {} })
  })

  it('keep the remembered model per agent key and drop anything that is not a model id', () => {
    expect(parsePrefs('{"models":{"claude":"haiku","claude:work":"","kiro":3}}').models).toEqual({ claude: 'haiku' })
  })

  it('resolve the theme against the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
  })
})
