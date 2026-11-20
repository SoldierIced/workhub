import { describe, expect, it } from 'vitest'
import { isAboutOpenSession, navTabsFor, parseRoute, routeFromNotification, routeHash, splitDesktop, tabOf } from '../src/web/routes'

describe('web routes', () => {
  it('parses every screen and round-trips its hash', () => {
    expect(parseRoute('')).toEqual({ screen: 'home' })
    expect(parseRoute('#')).toEqual({ screen: 'home' })
    expect(parseRoute('#new')).toEqual({ screen: 'new' })
    expect(parseRoute('#prs')).toEqual({ screen: 'pullRequests' })
    expect(parseRoute('#alerts')).toEqual({ screen: 'alerts' })
    expect(parseRoute('#automations')).toEqual({ screen: 'automations' })
    expect(parseRoute('#settings')).toEqual({ screen: 'settings' })
    expect(parseRoute('#session/abc%2F1')).toEqual({ screen: 'session', id: 'abc/1' })
    expect(parseRoute('#pair=eyJ2IjoxfQ')).toEqual({ screen: 'pair' })
    expect(parseRoute('#plan')).toEqual({ screen: 'plan', tab: 'today' })
    expect(parseRoute('#plan/today')).toEqual({ screen: 'plan', tab: 'today' })
    expect(parseRoute('#plan/nope')).toEqual({ screen: 'plan', tab: 'today' })
    expect(parseRoute('#item/new')).toEqual({ screen: 'newItem' })
    expect(parseRoute('#item/i%2F1')).toEqual({ screen: 'planItem', id: 'i/1' })
    expect(parseRoute('#milestone/m1')).toEqual({ screen: 'milestone', id: 'm1' })
    expect(parseRoute('#session/s%2F1/agent/a1')).toEqual({ screen: 'subagent', sessionId: 's/1', id: 'a1' })
    for (const hash of ['#session/s%2F1/agent/a1', '#new', '#prs', '#alerts', '#automations', '#settings', '#session/abc%2F1', '#plan/inbox', '#item/new', '#item/i%2F1', '#milestone/m1']) expect(routeHash(parseRoute(hash))).toBe(hash)
  })

  it('opens a session’s changes, and round-trips the hash', () => {
    expect(parseRoute('#session/s%2F1/changes')).toEqual({ screen: 'changes', sessionId: 's/1' })
    expect(routeHash({ screen: 'changes', sessionId: 's/1' })).toBe('#session/s%2F1/changes')
    expect(parseRoute('#session/%E0/changes')).toEqual({ screen: 'home' })
  })

  it('splits the desktop a notification names off the hash', () => {
    const fp = 'a'.repeat(32)
    expect(splitDesktop(`#d/${fp}/session/s1`)).toEqual({ desktop: fp, hash: '#session/s1' })
    expect(splitDesktop(`#d/${fp}/`)).toEqual({ desktop: fp, hash: '#' })
    expect(splitDesktop('#session/s1')).toEqual({ hash: '#session/s1' })
    expect(parseRoute(`#d/${fp}/plan/inbox`)).toEqual({ screen: 'plan', tab: 'inbox' })
  })

  it('opens a notification on its session, and home when the route is unknown', () => {
    expect(routeFromNotification('#session/s1')).toEqual({ screen: 'session', id: 's1' })
    expect(routeFromNotification(undefined)).toEqual({ screen: 'home' })
    expect(routeFromNotification('#nowhere')).toEqual({ screen: 'home' })
  })

  it('goes home on a malformed percent-encoding instead of throwing', () => {
    expect(parseRoute('#session/%E0')).toEqual({ screen: 'home' })
    expect(parseRoute('#item/%')).toEqual({ screen: 'home' })
    expect(parseRoute('#milestone/%E0%A4%A')).toEqual({ screen: 'home' })
    expect(parseRoute('#session/a%20b')).toEqual({ screen: 'session', id: 'a b' })
  })

  it('keeps five tabs at most, with Automations reached from Settings', () => {
    const all = ['sessions', 'pullRequests', 'automations', 'health', 'plan']
    expect(navTabsFor(all)).toEqual(['home', 'pullRequests', 'plan', 'alerts', 'settings'])
    expect(navTabsFor(all)).toHaveLength(5)
    expect(navTabsFor([])).toEqual(['settings'])
    expect(navTabsFor(['plan', 'automations'])).toEqual(['plan', 'settings'])
    // The Automations route still works, and lights the Settings tab it is reached from.
    expect(parseRoute('#automations')).toEqual({ screen: 'automations' })
    expect(tabOf({ screen: 'automations' })).toBe('settings')
    expect(tabOf({ screen: 'session', id: 's' })).toBe('home')
    expect(tabOf({ screen: 'milestone', id: 'm' })).toBe('plan')
    expect(tabOf({ screen: 'pair' })).toBeNull()
  })

  it('knows when a notification is about the session already open', () => {
    const open = { screen: 'session', id: 's/1' } as const
    expect(isAboutOpenSession('#session/s%2F1', undefined, open, undefined)).toBe(true)
    expect(isAboutOpenSession('#session/s%2F2', undefined, open, undefined)).toBe(false)
    // Its changes and its sub-agents are the same session, on either side.
    expect(isAboutOpenSession('#session/s%2F1/changes', undefined, open, undefined)).toBe(true)
    expect(isAboutOpenSession('#session/s%2F1', undefined, { screen: 'changes', sessionId: 's/1' }, undefined)).toBe(true)
    expect(isAboutOpenSession('#session/s%2F1', undefined, { screen: 'subagent', sessionId: 's/1', id: 'a' }, undefined)).toBe(true)
    // A request for an answer is shown only by the session's own screen: Changes and sub-agents keep the toast.
    expect(isAboutOpenSession('#session/s%2F1', undefined, { screen: 'changes', sessionId: 's/1' }, undefined, 'needsAnswer')).toBe(false)
    expect(isAboutOpenSession('#session/s%2F1', undefined, { screen: 'subagent', sessionId: 's/1', id: 'a' }, undefined, 'needsAnswer')).toBe(false)
    expect(isAboutOpenSession('#session/s%2F1', undefined, open, undefined, 'needsAnswer')).toBe(true)
    // No session open, no route, or another computer's session with the same id.
    expect(isAboutOpenSession('#session/s%2F1', undefined, { screen: 'home' }, undefined)).toBe(false)
    expect(isAboutOpenSession(undefined, undefined, open, undefined)).toBe(false)
    expect(isAboutOpenSession('#session/s%2F1', 'b'.repeat(32), open, 'a'.repeat(32))).toBe(false)
    expect(isAboutOpenSession('#session/s%2F1', 'a'.repeat(32), open, 'a'.repeat(32))).toBe(true)
  })
})
