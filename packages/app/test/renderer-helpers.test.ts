import { describe, expect, it, vi } from 'vitest'
import type { ImportPlan } from '@workhub/core'
import { safeHref } from '../src/renderer/components/molecules/Markdown'
import { isEmptyPlan, mergedPrefs, notesFor, optionRows, otherNotes } from '../src/renderer/components/organisms/Workhub1Import'
import { recentFolders, usageGroups, type SessionSummary } from '../src/renderer/lib/home'
import { imageInputFromDataUrl } from '../src/renderer/lib/images'
import { historyAccounts, historyAgents } from '../src/renderer/screens/HistoryScreen'
import { formatDuration } from '../src/renderer/screens/sessions/MonitorPanel'
import { applyEvent, replayItems, withReplay, type SessionData } from '../src/renderer/store'

const summary = (cwd: string, startedAt: number, extra: Partial<SessionSummary['view']> = {}, planUsage?: SessionSummary['monitor']['planUsage']): SessionSummary => ({
  view: { id: cwd + startedAt, state: 'ready', cwd, startedAt, ...extra },
  items: [],
  monitor: planUsage ? { planUsage } : {}
})

describe('usage per account', () => {
  it('groups what sessions report by account and keeps the highest percent per window', () => {
    const groups = usageGroups(
      [
        summary('/a', 1, { accountId: 'work', accountName: 'Work' }, [{ window: '5h', percent: 10 }]),
        summary('/b', 2, { accountId: 'work', accountName: 'Work' }, [{ window: '5h', percent: 30 }, { window: 'weekly', percent: 4 }]),
        summary('/c', 3, { accountId: null }, [{ window: '5h', percent: 50 }]),
        summary('/d', 4, { accountId: 'home' })
      ],
      []
    )
    expect(groups).toEqual([
      { key: 'claude:work', agentId: 'claude', name: 'Work', windows: [{ window: '5h', percent: 30 }, { window: 'weekly', percent: 4 }] },
      { key: 'claude', agentId: 'claude', name: '', windows: [{ window: '5h', percent: 50 }] }
    ])
  })

  it('prefers the account read when the option is on, shows a failed read only without other data, and lists every agent', () => {
    const groups = usageGroups([summary('/a', 1, { accountId: 'work', accountName: 'Work' }, [{ window: '5h', percent: 10 }])], [
      { agentId: 'claude', key: 'claude:work', accountId: 'work', name: 'Work', windows: [{ window: '5h', percent: 12 }], at: 0, budget: { action: 'allow' } },
      { agentId: 'claude', key: 'claude:home', accountId: 'home', name: 'Home', windows: [], error: 'HTTP 401', at: 0, budget: { action: 'allow' } },
      { agentId: 'codex', key: 'codex:work', accountId: 'work', name: 'Work', windows: [{ window: '5h', percent: 99 }], at: 0, budget: { action: 'allow' } }
    ])
    expect(groups).toEqual([
      { key: 'claude:work', agentId: 'claude', name: 'Work', windows: [{ window: '5h', percent: 12 }] },
      { key: 'claude:home', agentId: 'claude', name: 'Home', windows: [], error: 'HTTP 401' },
      { key: 'codex:work', agentId: 'codex', name: 'Work', windows: [{ window: '5h', percent: 99 }] }
    ])
  })

  it('keeps a Claude ACP session with its Claude account, and Codex and Kiro apart', () => {
    const groups = usageGroups(
      [
        summary('/a', 1, { agentId: 'claude-acp', accountId: 'work', accountName: 'Work' }, [{ window: '5h', percent: 20 }]),
        summary('/b', 2, { agentId: 'codex', accountId: null }, [{ window: '5h', percent: 40 }])
      ],
      [{ agentId: 'kiro', key: 'kiro', accountId: null, name: '', windows: [{ window: 'monthly', percent: 30 }], at: 0, budget: { action: 'allow' } }]
    )
    expect(groups.map((g) => g.key)).toEqual(['claude:work', 'codex', 'kiro'])
  })
})

describe('folders', () => {
  it('lists the profile folders first, then session folders newest first, once each', () => {
    expect(recentFolders([summary('/a', 1), summary('/b', 3), summary('/p', 2)], ['/p', '/q'])).toEqual(['/p', '/q', '/b', '/a'])
  })
})

describe('pasted images', () => {
  it('accepts the image types Claude takes and strips the data URL prefix', () => {
    expect(imageInputFromDataUrl('data:image/png;base64,iVBORw0KGgo=')).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' })
    expect(imageInputFromDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(imageInputFromDataUrl('data:image/png,raw')).toBeNull()
    expect(imageInputFromDataUrl('https://example.com/a.png')).toBeNull()
  })
})

describe('links in agent replies', () => {
  it('open only web and mail links', () => {
    expect(safeHref('https://example.com/pr/1')).toBe('https://example.com/pr/1')
    expect(safeHref('mailto:dev@example.com')).toBe('mailto:dev@example.com')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('relative/path')).toBeNull()
    expect(safeHref(undefined)).toBeNull()
  })
})

describe('chat store', () => {
  const empty = (): SessionData => ({ view: { id: 's' } as SessionData['view'], items: [], monitor: {} })
  let n = 0
  const next = () => ++n

  it('adds hook notices as their own items and closes withdrawn permission requests', () => {
    let s = applyEvent(empty(), { sessionId: 's', type: 'message', role: 'agent', text: 'Hi' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'notice', noticeId: 'h1', kind: 'hook', title: 'SessionStart hook', text: 'ok' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'message', role: 'agent', text: ' there' }, next)
    expect(s.items.map((i) => i.kind)).toEqual(['agent', 'notice', 'agent'])
    s = applyEvent(s, { sessionId: 's', type: 'permission', requestId: 'r1', title: 'Run ls', options: [] }, next)
    s = applyEvent(s, { sessionId: 's', type: 'permissionCancelled', requestId: 'r1' }, next)
    expect(s.items.at(-1)).toMatchObject({ kind: 'permission', answer: '—' })
  })

  it('updates a tool call in place with its detail', () => {
    let s = applyEvent(empty(), { sessionId: 's', type: 'tool', toolCallId: 't1', title: 'Read a file', status: 'pending' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'tool', toolCallId: 't1', status: 'completed', detail: 'src/a.ts' }, next)
    expect(s.items).toEqual([expect.objectContaining({ kind: 'tool', title: 'Read a file', status: 'completed', detail: 'src/a.ts' })])
  })

  it('stamps live items and keeps the first chunk\'s time when a reply grows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let s = applyEvent(empty(), { sessionId: 's', type: 'message', role: 'agent', text: 'Hi' }, next)
    vi.setSystemTime(5_000)
    s = applyEvent(s, { sessionId: 's', type: 'message', role: 'agent', text: ' there' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'exit', code: 0 }, next)
    vi.useRealTimers()
    expect(s.items).toEqual([expect.objectContaining({ kind: 'agent', text: 'Hi there', at: 1_000 }), expect.objectContaining({ kind: 'exit', at: 5_000 })])
  })

  it('carries the time of a replayed message and leaves unknown ones without it', () => {
    const items = replayItems([{ kind: 'user', text: 'q', at: 42 }, { kind: 'agent', text: 'a' }], next)
    expect(items[0]).toMatchObject({ kind: 'user', at: 42 })
    expect(items[1]).not.toHaveProperty('at')
  })

  it('turns a past conversation into chat items', () => {
    const items = replayItems(
      [
        { kind: 'user', text: 'q', images: 2 },
        { kind: 'agent', text: 'a' },
        { kind: 'tool', id: 't', title: 'Ran the tests', failed: true }
      ],
      next
    )
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'q', images: 2 }),
      expect.objectContaining({ kind: 'agent', text: 'a' }),
      expect.objectContaining({ kind: 'tool', title: 'Ran the tests', status: 'failed' })
    ])
  })

  it('replaces what a chat showed with the whole stored conversation when it resumes', () => {
    // The chat before the console took over: its turns are in the stored conversation too.
    let s = applyEvent(empty(), { sessionId: 's', type: 'message', role: 'agent', text: 'from the first chat' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'exit', code: 0 }, next)
    s = withReplay(
      s,
      [
        { kind: 'agent', text: 'from the first chat' },
        { kind: 'user', text: 'typed in the terminal' }
      ],
      next
    )
    expect(s.items.map((i) => i.kind)).toEqual(['agent', 'user', 'replayStart'])
    expect(s.items.at(-1)).toMatchObject({ kind: 'replayStart', count: 2 })
  })
})

describe('history and monitor helpers', () => {
  it('lists each account of the history once', () => {
    const base = { agentId: 'claude', agentName: 'Claude Code', resumable: true, title: '', lastModified: 0 }
    expect(
      historyAccounts([
        { ...base, agentSessionId: '1', accountId: null },
        { ...base, agentSessionId: '2', accountId: 'work', accountName: 'Work' },
        { ...base, agentSessionId: '3', accountId: 'work', accountName: 'Work' }
      ])
    ).toEqual([
      { id: '', name: '' },
      { id: 'work', name: 'Work' }
    ])
  })

  it('lists each agent of the history once, in the order it first appears', () => {
    const base = { title: '', lastModified: 0, accountId: null, resumable: false }
    expect(
      historyAgents([
        { ...base, agentId: 'codex', agentName: 'Codex', agentSessionId: '1' },
        { ...base, agentId: 'kiro', agentName: 'Kiro', agentSessionId: '2' },
        { ...base, agentId: 'codex', agentName: 'Codex', agentSessionId: '3' }
      ])
    ).toEqual([
      { id: 'codex', name: 'Codex' },
      { id: 'kiro', name: 'Kiro' }
    ])
  })

  it('formats active time', () => {
    expect(formatDuration(4200)).toBe('4.2 s')
    expect(formatDuration(75_000)).toBe('1 min 15 s')
    expect(formatDuration(3_900_000)).toBe('1 h 5 min')
  })
})

describe('Workhub 1 import preview', () => {
  const plan: ImportPlan = {
    profiles: [],
    accounts: [],
    connections: [{ id: 'jira-acme', kind: 'tracker', provider: 'jira', settings: {} }],
    notes: [
      { code: 'reenterSecret', path: 'connections.jira-acme' },
      { code: 'exists', path: 'profiles.work' }
    ]
  }
  it('finds the notes of an item and tells an empty plan', () => {
    expect(notesFor(plan, 'connections.jira-acme')).toEqual([{ code: 'reenterSecret', path: 'connections.jira-acme' }])
    expect(isEmptyPlan(plan)).toBe(false)
    expect(isEmptyPlan({ ...plan, connections: [] })).toBe(true)
    expect(isEmptyPlan({ ...plan, connections: [], options: { claudePlanUsage: true } })).toBe(false)
  })

  const t = (key: string, params?: Record<string, string>) => `${key}${params ? JSON.stringify(params) : ''}`
  const full: ImportPlan = {
    ...plan,
    automations: [],
    options: { claudePlanUsage: true },
    sessionGroups: { groups: [{ id: 'g', name: 'G', collapsed: false, members: [{ key: 'k1', title: 't', agentKey: 'claude', cwd: '/x' }] }], top: [{ kind: 'group', id: 'g' }, { kind: 'session', key: 'k2' }] },
    prefs: { models: { 'claude:main': 'opus' }, language: 'es' },
    notes: [...plan.notes, { code: 'notSupported', path: 'settings', detail: 'terminal.theme' }]
  }

  it('lists the app-wide parts of the plan as option rows', () => {
    expect(optionRows(full, t).map((r) => [r.id, r.meta])).toEqual([
      ['options', 'import.optPlanUsage'],
      ['sessionGroups', 'import.sessionGroupsMeta{"groups":"1","sessions":"2"}'],
      ['models', 'opus'],
      ['language', 'es']
    ])
  })

  it('lists notes with no row of their own, leaving out "already here"', () => {
    expect(otherNotes(full)).toEqual([{ code: 'notSupported', path: 'settings', detail: 'terminal.theme' }])
  })

  it('keeps the model and language already chosen in Workhub 2', () => {
    expect(mergedPrefs({ language: 'system', models: { 'claude:main': 'sonnet' } }, full.prefs)).toEqual({ language: 'es', models: { 'claude:main': 'sonnet' } })
    expect(mergedPrefs({ language: 'en', models: {} }, full.prefs)).toEqual({ models: { 'claude:main': 'opus' } })
    expect(mergedPrefs({ language: 'en', models: {} }, undefined)).toEqual({})
  })

  it('carries Workhub 1 appearance only over defaults, known themes only, clamped', () => {
    const appearance = { terminalTheme: 'Dracula', terminalFontFamily: 'Menlo', terminalFontSize: 30, chatFontSize: 15, textSize: 16 }
    expect(mergedPrefs({ language: 'en', models: {}, terminalTheme: '', terminalFontFamily: '', terminalFontSize: 13, chatFontSize: 13, textSize: 13 }, { appearance })).toEqual({
      terminalTheme: 'Dracula',
      terminalFontFamily: 'Menlo',
      terminalFontSize: 24,
      chatFontSize: 15,
      textSize: 16
    })
    expect(mergedPrefs({ language: 'en', models: {}, terminalTheme: 'Nord', terminalFontFamily: 'SF Mono', terminalFontSize: 15, chatFontSize: 13, textSize: 14 }, { appearance })).toEqual({ chatFontSize: 15 })
    expect(mergedPrefs({ language: 'en', models: {} }, { appearance: { terminalTheme: 'No Such Theme' } })).toEqual({})
  })
})
