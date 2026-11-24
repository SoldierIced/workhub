import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '../src/renderer/components/atoms'
import type { SessionView } from '../src/shared/api'
import { changeCounts, sessionBranch } from '../src/renderer/lib/sessionHeader'
import { SessionBar, type SessionBarProps } from '../src/renderer/screens/sessions/SessionHeader'
import type { SessionData } from '../src/renderer/store'

const NOW = 10 * 60_000

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({
    id: 's1',
    agentId: 'claude',
    agentName: 'Claude Code',
    adapter: 'acp',
    cwd: '/work/acme/orders',
    mode: 'app',
    modes: ['app', 'console', 'shell'],
    screens: ['monitor'],
    state: 'ready',
    startedAt: 0,
    stateSince: 6 * 60_000,
    readOnly: false,
    permissionMode: null,
    ...over
  }) as unknown as SessionView

const bar = (v: SessionView, over: Partial<SessionBarProps> = {}) => {
  const data = { view: v, items: [], monitor: {} } as unknown as SessionData
  const props: SessionBarProps = {
    data,
    title: 'Add retries to the orders client',
    now: NOW,
    slackCount: 0,
    branch: 'feat/orders-retries',
    counts: { additions: 132, deletions: 9 },
    canCreatePr: true,
    onCreatePr: () => undefined,
    monitorHidden: false,
    ...over
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SessionBar, props)))
}

describe('SessionBar', () => {
  it('shows the title, the idle state with its time, the branch and the line counts', () => {
    const out = bar(view())
    expect(out).toContain('Add retries to the orders client')
    expect(out).toContain('data-activity="idle"')
    expect(out).toContain('Ready · 4 min ago')
    expect(out).toContain('feat/orders-retries')
    expect(out).toContain('data-testid="local-review-counts"')
    expect(out).toContain('+132')
    expect(out).toContain('−9')
    // The folder is not repeated in the bar; it is in the title's tooltip.
    expect(out).toContain('Add retries to the orders client\n/work/acme/orders')
  })

  it('names the WSL distribution of a session that runs in one, in the title tooltip', () => {
    expect(bar(view({ hostId: 'wsl:Ubuntu' }))).toContain('title="Add retries to the orders client\nWSL: Ubuntu\n/work/acme/orders"')
    expect(bar(view())).toContain('title="Add retries to the orders client\n/work/acme/orders"')
  })

  it('offers Stop in the bar only while the agent works', () => {
    expect(bar(view())).not.toContain('data-testid="session-stop"')
    const working = bar(view({ state: 'busy', stateSince: 8 * 60_000 }))
    expect(working).toContain('data-testid="session-stop"')
    expect(working).toContain('data-activity="working"')
    expect(working).toContain('Working · 2 min')
  })

  it('switches between Chat, Terminal and Shell with text, and marks the view waiting for the turn to end', () => {
    const out = bar(view({ pendingMode: 'console', state: 'busy' }))
    expect(out).toContain('>Chat<')
    expect(out).toContain('>Terminal<')
    expect(out).toContain('>Shell<')
    expect(out).toMatch(/data-testid="mode-console"[^>]*data-pending="true"/)
    expect(out).toContain('Terminal (waiting for the turn)')
    // Only the views the session has.
    const chatOnly = bar(view({ modes: ['app'] }))
    expect(chatOnly).not.toContain('role="radiogroup"')
  })

  it('leaves the branch and the counts out when the session has none', () => {
    const out = bar(view(), { branch: undefined, counts: undefined, canCreatePr: false })
    expect(out).not.toContain('data-testid="session-branch"')
    expect(out).not.toContain('local-review-counts')
    expect(out).not.toContain('data-testid="create-pr-header"')
    expect(out).toContain('data-testid="local-review-button"')
  })

  it('has no filled button and keeps the menu and the monitor toggle last', () => {
    const out = bar(view({ state: 'busy' }))
    expect(out).not.toContain('bg-accent text-accent-fg')
    expect(out.indexOf('data-testid="session-more"')).toBeGreaterThan(out.indexOf('data-testid="session-stop"'))
    expect(out.indexOf('data-testid="toggle-monitor"')).toBeGreaterThan(out.indexOf('data-testid="session-more"'))
    expect(out).toContain('data-testid="create-pr-header"')
  })

  it('hides Changes for a read-only reviewer session', () => {
    expect(bar(view({ readOnly: true }))).not.toContain('data-testid="local-review-button"')
  })
})

describe('header data', () => {
  it('names the branch of the one repository, else of the only one touched, else the worktree', () => {
    expect(sessionBranch({ nested: false, repos: [{ branch: 'main' }] }, 'wt/x')).toBe('main')
    expect(sessionBranch({ nested: true, repos: [{ branch: 'a' }, { branch: 'b' }] }, undefined)).toBeUndefined()
    expect(sessionBranch({ nested: true, repos: [{ branch: 'a' }] }, undefined)).toBe('a')
    expect(sessionBranch({ nested: false, repos: [{ branch: null }] }, 'wt/x')).toBe('wt/x')
    expect(sessionBranch(null, undefined)).toBeUndefined()
  })

  it('counts lines only when something changed', () => {
    expect(changeCounts({ files: 2, additions: 5, deletions: 1 })).toEqual({ additions: 5, deletions: 1 })
    expect(changeCounts({ files: 0, additions: 0, deletions: 0 })).toBeUndefined()
    expect(changeCounts(null)).toBeUndefined()
  })
})
