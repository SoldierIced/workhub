import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, NO_MODULES, type AppOptions, type Profile, type Result, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '../src/shared/api'

/**
 * The tests render on the server (no DOM), so the controls are swapped for stand-ins that record
 * their props: a test finds a control by its accessible name or test id and calls its handler.
 */
type Recorded = Record<string, unknown> & { 'aria-label'?: string; 'data-testid'?: string }
const controls: Recorded[] = []
vi.mock('../src/renderer/components/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/atoms')>()
  const record = (tag: string) =>
    function Recording(props: Recorded & { children?: ReactNode }) {
      controls.push(props)
      return createElement(tag, { 'aria-label': props['aria-label'], 'data-testid': props['data-testid'] }, props.children as ReactNode)
    }
  return { ...actual, Switch: record('button'), Button: record('button'), Input: record('input'), Select: record('select') }
})

import { TooltipProvider } from '../src/renderer/components/atoms'
import { NotificationsAlertsSection } from '../src/renderer/screens/settings/NotificationsAlertsSection'
import { NOTIFICATIONS_INDEX } from '../src/renderer/screens/settings/notifications-index'
import { en } from '../src/renderer/i18n/en'

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'acme',
  name: 'Acme web',
  connections: {},
  accountIds: [],
  modules: { ...NO_MODULES, health: true, flowMaps: true, planner: true },
  health: { refreshMinutes: 15, environments: [], alerts: { stoppedReporting: { notify: true, threshold: 10 }, errorsWorsening: { notify: true, threshold: 3 }, podDown: { notify: false } } },
  planner: { reminderLeadMinutes: 5 } as Profile['planner'],
  ...over
})

const snapshot = (config: Partial<WorkhubConfig> = {}): ConfigSnapshot => ({
  config: { ...emptyConfig(), profiles: [profile()], ...config },
  issues: [],
  agents: [],
  providers: [],
  connectionsWithSecret: [],
  dataDir: '/tmp/example'
})

const saveOptions = vi.fn(async (_patch: Partial<AppOptions>): Promise<Result<WorkhubConfig>> => ({ ok: true, value: emptyConfig() }) as never)
const saveProfile = vi.fn(async (p: Profile): Promise<Result<WorkhubConfig>> => ({ ok: true, value: { ...emptyConfig(), profiles: [p] } }) as never)
let stored: WorkhubConfig

beforeEach(() => {
  controls.length = 0
  saveOptions.mockClear()
  saveProfile.mockClear()
  onOpenProfile.mockClear()
  stored = snapshot().config
  vi.stubGlobal('window', {
    hub: {
      platform: 'mac',
      config: { saveOptions, saveProfile, get: async () => ({ config: stored }) },
      systemNotifications: { status: async () => ({ supported: true }), test: async () => ({ outcome: 'shown' }), openSystemSettings: () => {} },
      setup: { openSettings: () => {} }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

const run = vi.fn(async (op: () => Promise<Result<WorkhubConfig>>) => (await op()).ok)
const onOpenProfile = vi.fn()

function render(snap = snapshot(), props: { initialId?: string; platform?: 'mac' | 'windows' | 'linux' } = {}) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(NotificationsAlertsSection, { snap, run, onOpenProfile, platform: props.platform ?? 'mac', initialId: props.initialId }))
  )
}
const control = (name: string) => {
  const found = controls.find((c) => c['aria-label'] === name || c['data-testid'] === name)
  if (!found) throw new Error(`no control "${name}"; have: ${controls.map((c) => c['aria-label'] ?? c['data-testid']).join(' | ')}`)
  return found
}
const call = async (name: string, handler: string, ...args: unknown[]) => {
  await (control(name)[handler] as (...a: unknown[]) => unknown)(...args)
  await new Promise((r) => setTimeout(r, 0))
}

describe('Settings → Notifications and alerts', () => {
  it('the master switch writes notificationsEnabled', async () => {
    render()
    await call('Notify me', 'onChange', false)
    expect(saveOptions).toHaveBeenCalledWith({ notificationsEnabled: false })
  })

  it('renders one table with the sentence titles, a switch per source and a stable row id', () => {
    const html = render()
    for (const title of ['A session finished replying', 'A session is waiting for your permission or answer', 'A session failed', "An account&#x27;s usage crosses a threshold", 'A meeting is coming up'])
      expect(html).toContain(title)
    for (const id of ['notifications.sessions.replied', 'notifications.usage', 'notifications.health.environments', 'notifications.health.services', 'notifications.metrics', 'notifications.flowMaps', 'notifications.meetings', 'notifications.quiet', 'notifications.panel'])
      expect(html).toContain(`data-setting-id="${id}"`)
    expect(html.match(/data-testid="notifications-matrix"/g)).toHaveLength(1)
    // No channel columns: the app-wide options do not route per channel.
    expect(html).not.toContain('>Channels<')
    expect(html).toContain('Profiles with Health: Acme web')
  })

  it('a session switch writes its own option', async () => {
    render()
    await call('Notify: A session failed', 'onChange', false)
    expect(saveOptions).toHaveBeenCalledWith({ notifyError: false })
  })

  it('editing the usage thresholds writes options.usageBudget.thresholds', async () => {
    render()
    await call('Usage thresholds in %, comma separated', 'onBlur', { currentTarget: { value: '70, 90' } })
    expect(saveOptions).toHaveBeenCalledTimes(1)
    const patch = saveOptions.mock.calls[0]![0] as { usageBudget: { thresholds: number[]; alerts: boolean } }
    expect(patch.usageBudget.thresholds).toEqual([70, 90])
    expect(patch.usageBudget.alerts).toBe(true)
  })

  it('an unchanged or unreadable threshold writes nothing', async () => {
    render()
    await call('Usage thresholds in %, comma separated', 'onBlur', { currentTarget: { value: '80, 95' } })
    await call('Usage thresholds in %, comma separated', 'onBlur', { currentTarget: { value: 'lots' } })
    expect(saveOptions).not.toHaveBeenCalled()
  })

  it('pull requests start collapsed with a summary, and open on a search result for one event', async () => {
    const collapsed = render()
    expect(collapsed).toContain('8 of 10 on')
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).not.toContain('data-setting-id="notifications.pullRequests.approved"')
    controls.length = 0
    const open = render(snapshot(), { initialId: 'notifications.pullRequests.approved' })
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('data-setting-id="notifications.pullRequests.approved"')
    await call('Notify: Approved', 'onChange', false)
    expect((saveOptions.mock.calls[0]![0] as { notifyPrEvents: Record<string, boolean> }).notifyPrEvents.approved).toBe(false)
  })

  it('per-profile thresholds are read-only values that open the profile', async () => {
    const html = render()
    expect(html).toContain('10 min · 3× a typical day · 2 of 3 on')
    expect(html).toContain('from High')
    await call('notifications.health.services.profile.acme', 'onClick')
    await call('notifications.meetings.profile.acme', 'onClick')
    expect(onOpenProfile).toHaveBeenCalledWith('acme', 'screens')
    expect(onOpenProfile).toHaveBeenCalledTimes(2)
    expect(saveProfile).not.toHaveBeenCalled()
  })

  it('with one profile, quiet hours are edited inline on that profile, not on the active one', async () => {
    stored = snapshot({ activeProfileId: 'other' }).config
    render(snapshot({ activeProfileId: 'other' }))
    await call('Quiet hours', 'onChange', true)
    expect(saveProfile).toHaveBeenCalledTimes(1)
    expect(saveProfile.mock.calls[0]![0]).toMatchObject({ id: 'acme', alerts: { quietHours: { startHour: 22, endHour: 7 } } })
  })

  it('with several profiles, quiet hours show each value and link to the profile', async () => {
    const two = snapshot({ profiles: [profile({ alerts: { quietHours: { startHour: 22, endHour: 8 } } }), profile({ id: 'side', name: 'Side project', modules: NO_MODULES })] })
    const html = render(two)
    expect(html).toContain('Quiet hours of Acme web')
    expect(html).toContain('From 22:00 to 08:00, local time.')
    expect(controls.some((c) => c['aria-label'] === 'Quiet hours')).toBe(false)
    await call('notifications.quiet.profile.side', 'onClick')
    expect(onOpenProfile).toHaveBeenLastCalledWith('side', 'screens')
  })

  it('the menu bar panel blocks are chips; none on Linux', async () => {
    const html = render()
    expect(html).toContain('Meetings (2)')
    await call('notifications-panel-usage', 'onClick')
    expect((saveOptions.mock.calls[0]![0] as { trayPopover: { usage: boolean; meetings: boolean } }).trayPopover).toMatchObject({ usage: false, meetings: true })
    controls.length = 0
    expect(render(snapshot(), { platform: 'linux' })).not.toContain('notifications.panel')
  })

  it('indexes every row with existing i18n keys and ids the section renders', () => {
    const html = render(snapshot(), { initialId: 'notifications.pullRequests.approved' })
    for (const entry of NOTIFICATIONS_INDEX) {
      for (const key of [entry.label, entry.hint, entry.help, entry.subgroup]) if (key) expect(en[key], key).toBeTruthy()
      expect(html, entry.id).toContain(`data-setting-id="${entry.id}"`)
    }
  })
})
