import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { Toolbar, type ToolbarProps } from '../src/renderer/components/organisms/Toolbar'
import { MONITOR_SHORTCUT, SIDEBAR_SHORTCUT } from '../src/renderer/lib/nav'
import { DEFAULT_PREFS, parsePrefs } from '../src/renderer/lib/prefs'
import { matchesShortcut } from '../src/renderer/lib/shortcuts'

const noop = () => {}
afterEach(() => vi.unstubAllGlobals())
const bar = (over: Partial<ToolbarProps>, platform = 'mac') => {
  vi.stubGlobal('window', { hub: { platform } })
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Toolbar, { nav: null, agents: [], onNewSession: noop, onChooseSession: noop, onOpenSettings: noop, sidebarHidden: false, onToggleSidebar: noop, onToggleMonitor: noop, ...over })))
}

describe('sidebar and monitor folding', () => {
  it('keeps both panels shown by default and reads only true as folded', () => {
    expect(DEFAULT_PREFS.sidebarHidden).toBe(false)
    expect(DEFAULT_PREFS.monitorHidden).toBe(false)
    expect(parsePrefs(JSON.stringify({ sidebarHidden: true, monitorHidden: true }))).toMatchObject({ sidebarHidden: true, monitorHidden: true })
    expect(parsePrefs(JSON.stringify({ sidebarHidden: 'yes', monitorHidden: 1 }))).toMatchObject({ sidebarHidden: false, monitorHidden: false })
  })

  it('offers the sidebar toggle always and the monitor toggle only with a session on screen', () => {
    const shown = bar({ monitorHidden: false })
    expect(shown).toContain('data-testid="toggle-sidebar"')
    expect(shown).toContain('aria-label="Hide the sidebar"')
    expect(shown).toContain('aria-label="Hide the monitor"')
    expect(bar({ sidebarHidden: true, monitorHidden: true })).toContain('aria-label="Show the monitor"')
    expect(bar({ sidebarHidden: true })).toContain('aria-label="Show the sidebar"')
    expect(bar({})).not.toContain('data-testid="toggle-monitor"')
    // macOS draws its traffic lights over the bar once the sidebar is folded.
    expect(bar({ sidebarHidden: true })).toContain('pl-20')
    expect(bar({ sidebarHidden: false })).not.toContain('pl-20')
    expect(bar({ sidebarHidden: true }, 'windows')).not.toContain('pl-20')
  })

  it('folds with Shift+Cmd+S and Shift+Cmd+M on macOS (Ctrl elsewhere)', () => {
    const key = (k: string, mod: 'meta' | 'ctrl') => ({ key: k, metaKey: mod === 'meta', ctrlKey: mod === 'ctrl', shiftKey: true, altKey: false })
    expect(matchesShortcut(key('S', 'meta'), SIDEBAR_SHORTCUT, 'mac')).toBe(true)
    expect(matchesShortcut(key('M', 'meta'), MONITOR_SHORTCUT, 'mac')).toBe(true)
    expect(matchesShortcut(key('S', 'ctrl'), SIDEBAR_SHORTCUT, 'windows')).toBe(true)
    expect(matchesShortcut({ ...key('s', 'meta'), shiftKey: false }, SIDEBAR_SHORTCUT, 'mac')).toBe(false)
  })
})
