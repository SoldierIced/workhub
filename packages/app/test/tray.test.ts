import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { appOptions, buildTrayMenu, DEFAULT_HEALTH_THRESHOLDS, type AppOptions, type TrayItem, type TrayState } from '@workhub/core'

vi.mock('electron', () => ({ Menu: {}, nativeImage: {}, Tray: class {} }))

import { menuTemplate, trayIconFiles } from '../src/main/tray'
import { Notifier, RECENT_NOTIFICATIONS, type NotificationLike } from '../src/main/notifier'
import { healthAlertWords, trayText } from '../src/main/tray-text'
import { HealthWatcher, TicketWatcher, TICKET_INTERVAL_MS } from '../src/main/watchers'
import { traySessions } from '../src/renderer/lib/useTraySync'
import { trayEn } from '../src/renderer/i18n/tray.en'
import { trayEs } from '../src/renderer/i18n/tray.es'
import { placeholders } from '../src/renderer/i18n/translate'
import type { HealthView } from '../src/shared/health-api'
import type { SessionData } from '../src/renderer/store'

const iconDir = join(__dirname, '..', 'build', 'tray')

describe('tray icons', () => {
  it('uses a template image on macOS, .ico on Windows and PNG on Linux', () => {
    expect(trayIconFiles('darwin', '/r')).toEqual({ normal: join('/r', 'trayTemplate.png'), attention: join('/r', 'trayTemplate.png') })
    expect(trayIconFiles('win32', '/r').attention).toBe(join('/r', 'tray-attention.ico'))
    expect(trayIconFiles('linux', '/r').normal).toBe(join('/r', 'tray.png'))
  })

  it('are generated for every platform (npm run icons)', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const files = trayIconFiles(platform, iconDir)
      expect(existsSync(files.normal), files.normal).toBe(true)
      expect(existsSync(files.attention), files.attention).toBe(true)
    }
    expect(existsSync(join(iconDir, 'trayTemplate@2x.png'))).toBe(true)
  })
})

describe('tray menu template', () => {
  it('turns the model into native items whose clicks perform the action', () => {
    const perform = vi.fn()
    const items: TrayItem[] = [
      { type: 'label', label: 'Workhub 2' },
      { type: 'separator' },
      { type: 'submenu', label: 'More', items: [{ type: 'action', label: 'Quit', action: { kind: 'quit' } }] }
    ]
    const template = menuTemplate(items, perform)
    expect(template[0]).toEqual({ label: 'Workhub 2', enabled: false })
    expect(template[1]).toEqual({ type: 'separator' })
    const sub = template[2]!.submenu as { click: () => void }[]
    sub[0]!.click()
    expect(perform).toHaveBeenCalledWith({ kind: 'quit' })
  })

  it('words a real menu in both languages without leaving a key behind', () => {
    const state: TrayState = {
      appName: 'Workhub 2 Dev',
      sessions: [{ id: 's', title: 'Claude · api', state: 'ready', awaitingAnswer: true }],
      usage: [{ name: 'Claude', windows: [{ window: '5h', percent: 12 }] }],
      pullRequests: { toReview: 1, mine: 2 },
      prEvents: [],
      health: { state: 'healthy', degraded: [] },
      slack: { health: 'watching', open: 2, unread: 1 },
      notifications: [{ id: 'n1', title: 'x' }],
      pausedUntil: Date.now() + 60_000,
      canCheckForUpdates: true
    }
    const flat = (items: TrayItem[]): string[] => items.flatMap((i) => (i.type === 'separator' ? [] : i.type === 'submenu' ? [i.label, ...flat(i.items)] : [i.label]))
    for (const locale of ['en', 'es'] as const) {
      const labels = flat(buildTrayMenu(state, trayText(locale)))
      for (const l of labels) expect(l, `${locale}: ${l}`).not.toMatch(/\btray\.|\{\w+\}/)
    }
    expect(flat(buildTrayMenu(state, trayText('es')))).toContain('Claude — 5h 12%')
  })
})

describe('tray dictionaries', () => {
  it('have the same keys and placeholders in English and Spanish', () => {
    expect(Object.keys(trayEs).sort()).toEqual(Object.keys(trayEn).sort())
    for (const key of Object.keys(trayEn) as (keyof typeof trayEn)[]) expect(placeholders(trayEs[key]), key).toEqual(placeholders(trayEn[key]))
  })
})

class FakeNotification implements NotificationLike {
  static made: FakeNotification[] = []
  handlers: Record<string, () => void> = {}
  shown = false
  constructor(readonly content: { title: string; body: string }) {
    FakeNotification.made.push(this)
  }
  on(event: 'click' | 'close', listener: () => void) {
    this.handlers[event] = listener
    return this
  }
  show() {
    this.shown = true
  }
}

describe('notifier', () => {
  const make = (options: Partial<AppOptions> = {}, now = 1_000) =>
    new Notifier({
      options: async () => appOptions({ options: { ...appOptions({ options: undefined }), ...options } }),
      supported: () => true,
      create: (c) => new FakeNotification(c),
      now: () => now
    })

  it('shows, keeps it in the recent list, and a click opens and forgets it', async () => {
    FakeNotification.made = []
    const n = make()
    const open = vi.fn()
    expect(await n.show('health', { title: 'PROD is degraded', body: 'x' }, open)).toBe(true)
    expect(FakeNotification.made[0]?.shown).toBe(true)
    expect(n.recent().map((r) => r.title)).toEqual(['PROD is degraded'])
    FakeNotification.made[0]!.handlers['click']!()
    expect(open).toHaveBeenCalledOnce()
    expect(n.recent()).toEqual([])
  })

  it('honours the kind switch and the pause', async () => {
    FakeNotification.made = []
    expect(await make({ notifyHealth: false }).show('health', { title: 't' }, () => {})).toBe(false)
    expect(await make({ notificationsPausedUntil: 2_000 }, 1_000).show('replied', { title: 't' }, () => {})).toBe(false)
    expect(await make({ notificationsPausedUntil: 2_000 }, 2_000).show('replied', { title: 't' }, () => {})).toBe(true)
    expect(FakeNotification.made).toHaveLength(1)
  })

  it('opens a recent one from the menu and caps the list', async () => {
    const n = make()
    const open = vi.fn()
    for (let i = 0; i < RECENT_NOTIFICATIONS + 3; i++) await n.show('slack', { title: `n${i}` }, i === RECENT_NOTIFICATIONS + 2 ? open : () => {})
    expect(n.recent()).toHaveLength(RECENT_NOTIFICATIONS)
    expect(n.openRecent(n.recent()[0]!.id)).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(n.openRecent('missing')).toBe(false)
  })

  it('shows nothing where the OS has no notifications', async () => {
    const n = new Notifier({ options: async () => appOptions({ options: undefined }), supported: () => false, create: (c) => new FakeNotification(c) })
    expect(await n.show('replied', { title: 't' }, () => {})).toBe(false)
  })
})

const view = (state: HealthView['state'], envs: { id: string; state: 'healthy' | 'degraded' | 'blind' | 'unreachable'; unread?: boolean }[]): HealthView => ({
  state,
  refreshMinutes: 5,
  environments: envs.map((e) => ({
    id: e.id,
    name: e.id.toUpperCase(),
    snapshot: { environmentId: e.id, state: e.state, blindSpots: e.unread ? [{ code: 'notReadYet' }] : [] } as never,
    kibanaUrl: null,
    serviceUrls: {},
    errorUrls: {},
    podUrls: {},
    slowFlowHours: 1,
    errorWindowHours: 1,
    thresholds: DEFAULT_HEALTH_THRESHOLDS,
    hasKubeState: true,
    k8sIndexSuffix: ''
  }))
})

describe('health watcher', () => {
  it('records the first read, then alerts changes and keeps a summary for the menu', async () => {
    let current = view('ready', [{ id: 'prod', state: 'healthy' }, { id: 'dev', state: 'healthy', unread: true }])
    const alerts: string[] = []
    const changed = vi.fn()
    const w = new HealthWatcher({ activeProfileId: async () => 'p', read: async () => current, alert: (a) => alerts.push(`${a.environmentId}:${a.kind}`), changed })
    await w.tick()
    expect(alerts).toEqual([])
    expect(w.summary()).toEqual({ state: 'healthy', degraded: [] })
    current = view('ready', [{ id: 'prod', state: 'degraded' }, { id: 'dev', state: 'healthy' }])
    await w.tick()
    expect(alerts).toEqual(['prod:degraded'])
    expect(w.summary()).toEqual({ state: 'degraded', degraded: ['PROD'] })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('never alerts for the demo and has no summary while Health is off', async () => {
    let current = view('demo', [{ id: 'prod', state: 'healthy' }])
    const alert = vi.fn()
    const w = new HealthWatcher({ activeProfileId: async () => null, read: async () => current, alert, changed: () => {} })
    await w.tick()
    current = view('demo', [{ id: 'prod', state: 'degraded' }])
    await w.tick()
    expect(alert).not.toHaveBeenCalled()
    current = view('moduleOff', [])
    await w.tick()
    expect(w.summary()).toBeNull()
  })
})

describe('health watcher subject alerts', () => {
  const silent = (service: string) => ({ service, lastSeen: 0, silentMinutes: 30, isReporting: false })
  const withSilent = (services: string[]): HealthView => {
    const v = view('ready', [{ id: 'prod', state: 'healthy' }])
    v.environments[0]!.snapshot = { environmentId: 'prod', state: 'healthy', blindSpots: [], silentServices: services.map(silent), pods: [], errorServices: [], podVisibility: 'visible' } as never
    return v
  }

  it('announces a service that stops reporting once an hour, across restarts', async () => {
    let now = 1_000_000
    let current = withSilent([])
    let saved: Record<string, number> = {}
    const cooldowns = { load: () => saved, save: (v: Record<string, number>) => (saved = v) }
    const alerts: string[] = []
    const deps = { activeProfileId: async () => 'p', read: async () => current, alert: (a: { kind: string; subject: string }) => alerts.push(`${a.kind}:${a.subject}`), changed: () => {}, cooldowns, now: () => now }
    const w = new HealthWatcher(deps)
    await w.tick()
    current = withSilent(['api'])
    await w.tick()
    expect(alerts).toEqual(['stoppedReporting:api'])
    // It recovers and stops again ten minutes later: the same subject inside the hour is not repeated, even after a restart.
    current = withSilent([])
    now += 5 * 60_000
    await w.tick()
    const restarted = new HealthWatcher(deps)
    current = withSilent([])
    await restarted.tick()
    current = withSilent(['api'])
    now += 5 * 60_000
    await restarted.tick()
    expect(alerts).toEqual(['stoppedReporting:api'])
    current = withSilent([])
    await restarted.tick()
    now += 60 * 60_000
    current = withSilent(['api'])
    await restarted.tick()
    expect(alerts).toEqual(['stoppedReporting:api', 'stoppedReporting:api'])
  })

  it('words each kind of alert', () => {
    const { t } = trayText('en')
    const base = { environmentId: 'prod', environmentName: 'Prod' }
    expect(healthAlertWords({ ...base, kind: 'podDown', subject: 'api-1', crashLoop: true }, t).title).toBe('api-1 is crash-looping (Prod)')
    expect(healthAlertWords({ ...base, kind: 'errorsWorsening', subject: 'api', count: 120, hours: 24, factor: 12 }, t).body).toBe('120 in 24 h, ×12 a typical day')
    expect(healthAlertWords({ ...base, kind: 'stoppedReporting', subject: '+more', others: ['a', 'b'] }, t)).toEqual({ title: 'More services stopped reporting (Prod)', body: 'a, b' })
    expect(healthAlertWords({ ...base, kind: 'degraded', subject: '' }, trayText('es').t).title).toBe('Prod está degradado')
  })
})

describe('ticket watcher', () => {
  const store = () => {
    let saved = { profiles: {} as Record<string, never> }
    return { load: () => saved, save: (v: typeof saved) => (saved = v), get value() { return saved } }
  }

  it('announces changes after the first read, at most every few minutes, and remembers across restarts', async () => {
    let now = 0
    let tickets = [{ key: 'A-1', title: 'one', status: 'To Do' }]
    const announced: string[] = []
    const s = store()
    const deps = {
      activeProfileId: async () => 'p',
      enabled: async () => true,
      list: async () => ({ ok: true as const, value: tickets }),
      store: s,
      announce: (_p: string, c: { kind: string; key: string }) => announced.push(`${c.kind}:${c.key}`),
      now: () => now
    }
    const w = new TicketWatcher(deps)
    now = 1
    await w.tick()
    tickets = [{ key: 'A-1', title: 'one', status: 'Done' }]
    now = 2
    await w.tick()
    expect(announced).toEqual([])
    now = 2 + TICKET_INTERVAL_MS
    await w.tick()
    expect(announced).toEqual(['status:A-1'])
    // A new watcher (a restart) starts from what was stored.
    const again = new TicketWatcher({ ...deps, now: () => 10 * TICKET_INTERVAL_MS })
    await again.tick()
    expect(announced).toEqual(['status:A-1'])
  })

  it('reads nothing and forgets while ticket notifications are off', async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: [] }))
    const s = store()
    s.save({ profiles: { p: {} } as never })
    const w = new TicketWatcher({ activeProfileId: async () => 'p', enabled: async () => false, list, store: s, announce: () => {} })
    await w.tick()
    expect(list).not.toHaveBeenCalled()
    expect(s.value.profiles).toEqual({})
  })
})

describe('tray sessions from the renderer', () => {
  it('names sessions like their row, flags what needs a look and leaves reviewers out', () => {
    const data = (id: string, extra: Partial<SessionData> & { readOnly?: boolean } = {}): SessionData =>
      ({ view: { id, agentName: 'Claude', cwd: '/Users/x/api/', state: 'ready', readOnly: extra.readOnly, identity: id, agentKey: 'claude' }, items: [], ...extra }) as never
    const out = traySessions([data('a', { unseen: 'replied' }), data('b', { readOnly: true })], { groups: [], top: [] })
    expect(out).toEqual([{ id: 'a', title: 'Claude · api', state: 'ready', unseen: 'replied' }])
  })
})
