import { describe, expect, it } from 'vitest'
import type { TrackedThread } from '@workhub/core'
import { allNavItems, visibleNavItems } from '../src/renderer/lib/nav'
import { slackUnreadCount, topNavLabel, worstHealthState } from '../src/renderer/lib/topNav'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'

const thread = (over: Partial<TrackedThread>): TrackedThread => ({ ts: '1.0', replies: [], ...over }) as unknown as TrackedThread

describe('top bar navigation', () => {
  it('counts open Slack threads with replies from someone else since they were last seen', () => {
    const fresh = thread({ ts: '1.0', replies: [{ ts: '2.0', user: 'U2' }] as never })
    const seen = thread({ ts: '1.0', lastViewedReplyTs: '2.0', replies: [{ ts: '2.0', user: 'U2' }] as never })
    const mine = thread({ ts: '1.0', replies: [{ ts: '2.0', user: 'ME' }] as never })
    const closed = thread({ ts: '1.0', closed: true, replies: [{ ts: '2.0', user: 'U2' }] as never } as never)
    expect(slackUnreadCount([fresh, seen, mine, closed], 'ME')).toBe(1)
    expect(slackUnreadCount(undefined, 'ME')).toBe(0)
  })

  it("shows Health's worst environment, or nothing before a read", () => {
    const env = (state: string) => ({ snapshot: { state } }) as never
    expect(worstHealthState(null)).toBeNull()
    expect(worstHealthState({ environments: [] })).toBeNull()
    expect(worstHealthState({ environments: [env('healthy'), env('blind'), env('healthy')] })).toBe('blind')
    expect(worstHealthState({ environments: [env('blind'), env('degraded')] })).toBe('degraded')
  })

  it('uses a short label for the session history, in both languages', () => {
    expect(topNavLabel('history')).toBe('topNav.history')
    expect(topNavLabel('slack')).toBe('nav.slack')
    expect(topNavLabel('flowMaps')).toBe('nav.flowMaps')
    expect(topNavLabel('flowMaps', true)).toBe('topNav.flowMaps')
    expect(topNavLabel('pullRequests', true)).toBe('topNav.pullRequests')
    expect(topNavLabel('slack', true)).toBe('nav.slack')
    expect(en['topNav.history']).toBe('History')
    expect(es['topNav.history']).toBe('Historial')
  })

  it('keeps every screen and its ⌘ key reachable while the sidebar only lists sessions', () => {
    const modules = { flows: false, health: true, chatWatcher: true, automations: true, flowMaps: false }
    expect(visibleNavItems(modules).map((i) => `${i.route}:${i.shortcut.key}`)).toEqual(['home:1', 'pullRequests:2', 'tickets:3', 'slack:4', 'automations:5', 'history:6', 'health:8'])
    expect(allNavItems(modules).map((i) => i.route)).toContain('sessions')
  })
})
