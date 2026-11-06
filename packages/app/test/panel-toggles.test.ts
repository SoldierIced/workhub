import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { Toolbar, type ToolbarProps } from '../src/renderer/components/organisms/Toolbar'
import { PanelToggleButton } from '../src/renderer/components/molecules/PanelToggleButton'
import { panelToggle } from '../src/renderer/lib/panelToggle'
import { MONITOR_SHORTCUT, SIDEBAR_SHORTCUT } from '../src/renderer/lib/nav'
import { DEFAULT_PREFS, parsePrefs } from '../src/renderer/lib/prefs'
import { matchesShortcut } from '../src/renderer/lib/shortcuts'

const noop = () => {}
afterEach(() => vi.unstubAllGlobals())
const bar = (over: Partial<ToolbarProps>, platform = 'mac') => {
  vi.stubGlobal('window', { hub: { platform } })
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Toolbar, { nav: null, agents: [], onNewSession: noop, onChooseSession: noop, onOpenSettings: noop, sidebarHidden: false, onToggleSidebar: noop, ...over })))
}

describe('sidebar and monitor folding', () => {
  it('keeps both panels shown by default and reads only true as folded', () => {
    expect(DEFAULT_PREFS.sidebarHidden).toBe(false)
    expect(DEFAULT_PREFS.monitorHidden).toBe(false)
    expect(parsePrefs(JSON.stringify({ sidebarHidden: true, monitorHidden: true }))).toMatchObject({ sidebarHidden: true, monitorHidden: true })
    expect(parsePrefs(JSON.stringify({ sidebarHidden: 'yes', monitorHidden: 1 }))).toMatchObject({ sidebarHidden: false, monitorHidden: false })
  })

  it('offers the sidebar toggle in the top bar, and the monitor toggle no longer there (it is in the session header)', () => {
    const shown = bar({})
    expect(shown).toContain('data-testid="toggle-sidebar"')
    expect(shown).toContain('aria-label="Hide the sidebar"')
    expect(bar({ sidebarHidden: true })).toContain('aria-label="Show the sidebar"')
    expect(shown).not.toContain('data-testid="toggle-monitor"')
    // macOS draws its traffic lights over the bar once the sidebar is folded.
    expect(bar({ sidebarHidden: true })).toContain('pl-20')
    expect(bar({ sidebarHidden: false })).not.toContain('pl-20')
    expect(bar({ sidebarHidden: true }, 'windows')).not.toContain('pl-20')
  })

  it('shows whether each panel is folded: its icon, its label and its pressed state change', () => {
    expect(panelToggle('left', false)).toEqual({ icon: 'PanelLeftClose', label: 'layout.hideSidebar', pressed: true })
    expect(panelToggle('left', true)).toEqual({ icon: 'PanelLeftOpen', label: 'layout.showSidebar', pressed: false })
    expect(panelToggle('right', false)).toEqual({ icon: 'PanelRightClose', label: 'layout.hideMonitor', pressed: true })
    expect(panelToggle('right', true)).toEqual({ icon: 'PanelRightOpen', label: 'layout.showMonitor', pressed: false })
    vi.stubGlobal('window', { hub: { platform: 'mac' } })
    const button = (hidden: boolean) =>
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PanelToggleButton, { side: 'right', hidden, shortcut: MONITOR_SHORTCUT, onToggle: noop, testId: 'toggle-monitor' })))
    expect(button(false)).toContain('data-panel="shown"')
    expect(button(false)).toContain('aria-label="Hide the monitor"')
    expect(button(true)).toContain('data-panel="hidden"')
    expect(button(true)).toContain('aria-label="Show the monitor"')
    // Different icons, so the state reads at a glance.
    expect(button(true)).not.toEqual(button(false).replace('shown', 'hidden').replace('Hide', 'Show'))
  })

  it('folds with Shift+Cmd+S and Shift+Cmd+M on macOS (Ctrl elsewhere)', () => {
    const key = (k: string, mod: 'meta' | 'ctrl') => ({ key: k, metaKey: mod === 'meta', ctrlKey: mod === 'ctrl', shiftKey: true, altKey: false })
    expect(matchesShortcut(key('S', 'meta'), SIDEBAR_SHORTCUT, 'mac')).toBe(true)
    expect(matchesShortcut(key('M', 'meta'), MONITOR_SHORTCUT, 'mac')).toBe(true)
    expect(matchesShortcut(key('S', 'ctrl'), SIDEBAR_SHORTCUT, 'windows')).toBe(true)
    expect(matchesShortcut({ ...key('s', 'meta'), shiftKey: false }, SIDEBAR_SHORTCUT, 'mac')).toBe(false)
  })
})
