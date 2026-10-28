import { describe, expect, it } from 'vitest'
import { changesTotal, contextView, pullRequestLabel, requestBars, sessionTime, subagentTokens, toolTimeMs } from '../src/renderer/lib/monitorView'
import { paneDragWidth, paneKeyWidth } from '../src/renderer/lib/paneResize'
import { DEFAULT_PREFS, parsePrefs } from '../src/renderer/lib/prefs'
import { abbreviateFolder, activityElapsed, activityOf, foldDensity, formatClock, formatSince, headerDensity, permissionModeLabel } from '../src/renderer/lib/sessionHeader'

describe('session header', () => {
  it('abbreviates the folder from the home folder and keeps the last two folders of a long path', () => {
    expect(abbreviateFolder('/Users/ana/src/web')).toBe('~/src/web')
    expect(abbreviateFolder('/Users/ana/Desktop/proyectos/wayni/payments')).toBe('~/…/wayni/payments')
    expect(abbreviateFolder('/home/bob')).toBe('~')
    expect(abbreviateFolder('/srv/a/b/c/d')).toBe('/…/c/d')
    expect(abbreviateFolder('C:\\Users\\Ana\\code\\acme\\web\\api')).toBe('~\\…\\web\\api')
  })

  it('names the activity, with "needs you" while a question waits', () => {
    expect(activityOf('busy', false)).toBe('working')
    expect(activityOf('busy', true)).toBe('needsYou')
    expect(activityOf('ready', false)).toBe('idle')
    expect(activityOf('starting', false)).toBe('starting')
    expect(activityOf('error', false)).toBe('error')
  })

  it('counts working time as a clock and idle time in minutes', () => {
    expect(formatClock(83_000)).toBe('1:23')
    expect(formatClock(3_723_000)).toBe('1:02:03')
    expect(formatClock(-5)).toBe('0:00')
    expect(formatSince(40_000)).toBe('<1 min')
    expect(formatSince(125_000)).toBe('2 min')
    expect(formatSince(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min')
    expect(formatSince(27 * 3_600_000)).toBe('1 d 3 h')
    expect(activityElapsed('working', 1_000, 84_000)).toBe('1:23')
    expect(activityElapsed('idle', 0, 120_000)).toBe('2 min')
  })

  it('starts from the header width: labels when wide, icons in between, the menu when narrow', () => {
    expect(headerDensity(1400)).toBe('full')
    expect(headerDensity(1024)).toBe('icons')
    expect(headerDensity(700)).toBe('icons')
    expect(headerDensity(640)).toBe('narrow')
  })

  it('folds one more level each time the row still overflows, never past narrow', () => {
    expect(foldDensity('full', 0)).toBe('full')
    expect(foldDensity('full', 1)).toBe('icons')
    expect(foldDensity('full', 2)).toBe('compact')
    expect(foldDensity('icons', 2)).toBe('tight')
    expect(foldDensity('full', 4)).toBe('narrow')
    expect(foldDensity('compact', 9)).toBe('narrow')
    expect(foldDensity('narrow', 1)).toBe('narrow')
    expect(foldDensity('icons', -1)).toBe('icons')
  })
})

describe('monitor view model', () => {
  it('splits the session time into thinking, tools and idle', () => {
    const calls = [
      { id: 'a', title: 'Read', startedAt: 10_000, endedAt: 14_000, status: 'completed' },
      { id: 'b', title: 'Run', startedAt: 50_000, status: 'in_progress' },
      { id: 'c', title: 'No start', endedAt: 5 }
    ]
    expect(toolTimeMs(calls, 60_000)).toBe(14_000)
    const time = sessionTime(0, 100_000, 40_000, calls)
    expect(time).toEqual({ aliveMs: 100_000, activeMs: 40_000, toolMs: 40_000, thinkingMs: 0, idleMs: 60_000, activePercent: 40 })
    expect(sessionTime(0, 100_000, 40_000, calls.slice(0, 1))).toMatchObject({ toolMs: 4_000, thinkingMs: 36_000 })
  })

  it('reads the context window from a percent or from used and size, orange over 80%', () => {
    expect(contextView(undefined)).toBeNull()
    expect(contextView({ used: 10 })).toBeNull()
    expect(contextView({ used: 170_000, size: 200_000 })).toEqual({ used: 170_000, size: 200_000, fraction: 0.85, high: true })
    expect(contextView({ percent: 42 })).toMatchObject({ fraction: 0.42, high: false })
    expect(contextView({ percent: 130 })?.fraction).toBe(1)
  })

  it('adds up the subagents tokens it knows', () => {
    expect(subagentTokens([])).toBeUndefined()
    expect(subagentTokens([{ id: 'a', tokens: { total: 100 } }, { id: 'b' }, { id: 'c', tokens: { total: 50 } }])).toBe(150)
  })

  it('labels pull requests of GitHub and GitLab', () => {
    expect(pullRequestLabel('https://github.com/acme/web/pull/12')).toBe('acme/web#12')
    expect(pullRequestLabel('https://gitlab.com/group/sub/app/-/merge_requests/7')).toBe('group/sub/app!7')
    expect(pullRequestLabel('https://www.example.com/x')).toBe('example.com/x')
  })

  it('sums local changes over the repositories', () => {
    const repo = (name: string, files: number, additions: number, deletions: number) => ({ name, root: `/r/${name}`, branch: 'feat/x', files, additions, deletions })
    expect(changesTotal({ nested: true, scanned: 3, repos: [repo('a', 2, 10, 1), repo('b', 1, 0, 4)] })).toEqual({ repos: 2, files: 3, additions: 10, deletions: 5 })
    expect(changesTotal({ nested: false, scanned: 1, repos: [repo('a', 0, 0, 0)] })).toEqual({ repos: 0, files: 0, additions: 0, deletions: 0 })
  })

  it('resizes the monitor from its left edge within bounds', () => {
    expect(paneDragWidth('left', 320, 1000, 950, 240, 560)).toBe(370)
    expect(paneDragWidth('left', 320, 1000, 1200, 240, 560)).toBe(240)
    expect(paneDragWidth('left', 320, 1000, 500, 240, 560)).toBe(560)
  })

  it('resizes the sidebar from its right edge within bounds', () => {
    expect(paneDragWidth('right', 256, 256, 300, 200, 420)).toBe(300)
    expect(paneDragWidth('right', 256, 256, 100, 200, 420)).toBe(200)
    expect(paneDragWidth('right', 256, 256, 900, 200, 420)).toBe(420)
  })

  it('widens a pane with the arrow pointing away from it, and jumps to the bounds with Home and End', () => {
    expect(paneKeyWidth('right', 256, 'ArrowRight', 200, 420)).toBe(272)
    expect(paneKeyWidth('right', 256, 'ArrowLeft', 200, 420)).toBe(240)
    expect(paneKeyWidth('left', 320, 'ArrowLeft', 240, 560)).toBe(336)
    expect(paneKeyWidth('left', 248, 'ArrowRight', 240, 560)).toBe(240)
    expect(paneKeyWidth('left', 320, 'Home', 240, 560)).toBe(240)
    expect(paneKeyWidth('right', 256, 'End', 200, 420)).toBe(420)
    expect(paneKeyWidth('right', 256, 'Enter', 200, 420)).toBeNull()
  })

  it('keeps the side pane widths and folded sections in the preferences', () => {
    expect(DEFAULT_PREFS.monitorWidth).toBe(320)
    expect(DEFAULT_PREFS.sidebarWidth).toBe(256)
    expect(parsePrefs('{"monitorWidth":2000,"monitorCollapsed":["tokens",3]}')).toMatchObject({ monitorWidth: 560, monitorCollapsed: ['tokens'] })
    expect(parsePrefs('{"monitorWidth":"x"}').monitorWidth).toBe(320)
    expect(parsePrefs('{"sidebarWidth":50}').sidebarWidth).toBe(200)
    expect(parsePrefs('{"sidebarWidth":333.4}').sidebarWidth).toBe(333)
    expect(parsePrefs('{}').sidebarWidth).toBe(256)
  })
})

describe('new tokens per request', () => {
  it('draws bars only for a turn with more than one request', () => {
    expect(requestBars(undefined)).toBeNull()
    expect(requestBars([500])).toBeNull()
    const bars = requestBars([100, 400, 0])
    expect(bars?.max).toBe(400)
    expect(bars?.bars.map((b) => b.fraction)).toEqual([0.25, 1, 0.07])
  })
})

describe('permission mode label', () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ''}`
  it('translates the labels Workhub words itself and keeps the agent\'s own', () => {
    expect(permissionModeLabel({ id: 'unknown', label: 'Not reported by the agent' }, undefined, t)).toBe('session.mode.notReported')
    expect(permissionModeLabel({ id: 'agent-managed', label: 'x' }, 'kiro_default', t)).toBe('session.mode.setByAgentNamed{"name":"kiro_default"}')
    expect(permissionModeLabel({ id: 'plan', label: 'Plan mode' }, undefined, t)).toBe('session.mode.plan')
    expect(permissionModeLabel({ id: 'plan', label: 'Plan (read-only)' }, undefined, t)).toBe('session.mode.planReadOnly')
    expect(permissionModeLabel({ id: 'default', label: 'Always Ask' }, undefined, t)).toBe('Always Ask')
  })
})
