import { describe, expect, it } from 'vitest'
import {
  appOptions,
  buildTrayMenu,
  admitHealthAlerts,
  healthAlertKey,
  healthAlerts,
  HEALTH_ALERT_COOLDOWN_MS,
  isNotificationKind,
  NOTIFICATION_KINDS,
  notificationsPaused,
  pauseUntil,
  PAUSE_TOMORROW_HOUR,
  shouldNotify,
  ticketChanges,
  trayAttention,
  trayBadge,
  TRAY_ATTENTION_LIMIT,
  worstHealth,
  type AppOptions,
  type HealthAlert,
  type HealthReadout,
  type PodIssue,
  type PodKind,
  type ServiceReporting,
  type TrendState,
  type TrayAction,
  type TrayItem,
  type TrayState,
  type TrayText
} from '../src'

const options = (o: Partial<AppOptions> = {}): AppOptions => appOptions({ options: { ...appOptions({ options: undefined }), ...o } })

describe('notification policy', () => {
  const now = Date.UTC(2026, 9, 27, 12)

  it('lets every kind through by default', () => {
    for (const kind of NOTIFICATION_KINDS) expect(shouldNotify(kind, options(), now), kind).toBe(true)
  })

  it('honours each kind switch', () => {
    expect(shouldNotify('slack', options({ notifySlack: false }), now)).toBe(false)
    expect(shouldNotify('tickets', options({ notifyTickets: false }), now)).toBe(false)
    expect(shouldNotify('health', options({ notifyHealth: false }), now)).toBe(false)
    expect(shouldNotify('flowMaps', options({ notifyFlowMaps: false }), now)).toBe(false)
    expect(shouldNotify('flowMaps', options({ notifyHealth: false }), now)).toBe(true)
    expect(shouldNotify('automations', options({ notifyAutomations: false }), now)).toBe(false)
    expect(shouldNotify('replied', options({ notifyReplied: false }), now)).toBe(false)
    expect(shouldNotify('aiReview', options({ notifyNeedsAnswer: false }), now)).toBe(false)
    // Other kinds are not touched by one switch.
    expect(shouldNotify('health', options({ notifySlack: false }), now)).toBe(true)
  })

  it('silences every kind while paused, and only until the pause ends', () => {
    const paused = options({ notificationsPausedUntil: now + 1000 })
    expect(notificationsPaused(paused, now)).toBe(true)
    for (const kind of NOTIFICATION_KINDS) expect(shouldNotify(kind, paused, now), kind).toBe(false)
    expect(shouldNotify('replied', paused, now + 1000)).toBe(true)
    expect(notificationsPaused(options({ notificationsPausedUntil: 0 }), now)).toBe(false)
  })

  it('pauses for an hour or until tomorrow morning, local time', () => {
    const at = new Date(2026, 9, 27, 22, 15)
    expect(pauseUntil('hour', at)).toBe(at.getTime() + 3_600_000)
    const tomorrow = new Date(pauseUntil('tomorrow', at))
    expect([tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([2026, 9, 28, PAUSE_TOMORROW_HOUR, 0])
    // Just after midnight "tomorrow" is still the next calendar day.
    const late = new Date(pauseUntil('tomorrow', new Date(2026, 11, 31, 0, 30)))
    expect([late.getFullYear(), late.getMonth(), late.getDate()]).toEqual([2027, 0, 1])
  })

  it('recognizes kinds', () => {
    expect(isNotificationKind('health')).toBe(true)
    expect(isNotificationKind('flowMaps')).toBe(true)
    expect(isNotificationKind('nope')).toBe(false)
    expect(isNotificationKind(3)).toBe(false)
  })
})

describe('health alerts', () => {
  const env = (state: 'healthy' | 'degraded' | 'blind' | 'unreachable', id = 'prod') => ({ id, name: id.toUpperCase(), state })
  const b = (state: 'healthy' | 'degraded' | 'blind' | 'unreachable') => ({ prod: { state } })

  it('alerts nothing on the first read', () => {
    const r = healthAlerts(undefined, [env('degraded')])
    expect(r.alerts).toEqual([])
    expect(r.baseline).toEqual({ prod: { state: 'degraded' } })
  })

  it('alerts a degradation, an outage and a recovery', () => {
    expect(healthAlerts(b('healthy'), [env('degraded')]).alerts).toEqual([{ environmentId: 'prod', environmentName: 'PROD', kind: 'degraded', subject: '' }])
    expect(healthAlerts(b('degraded'), [env('unreachable')]).alerts.map((a) => a.kind)).toEqual(['unreachable'])
    expect(healthAlerts(b('degraded'), [env('healthy')]).alerts.map((a) => a.kind)).toEqual(['recovered'])
    expect(healthAlerts(b('unreachable'), [env('healthy')]).alerts.map((a) => a.kind)).toEqual(['recovered'])
  })

  it('does not call blind a recovery, nor blind-to-healthy news', () => {
    const blind = healthAlerts(b('degraded'), [env('blind')])
    expect(blind.alerts).toEqual([])
    expect(blind.baseline.prod?.state).toBe('degraded')
    expect(healthAlerts(blind.baseline, [env('degraded')]).alerts).toEqual([])
    expect(healthAlerts(b('blind'), [env('healthy')]).alerts).toEqual([])
  })

  const stats = (state: TrendState, recent: number, typicalDay = 10) => ({ recent, typicalDay, streakDays: 3, streakTruncated: false, daysWithData: 14, state })
  const pod = (name: string, kind: PodKind): PodIssue => ({ pod: name, notReady: kind === 'notReady', restarts: 0, recentRestarts: 0, backOff: kind === 'crashLoop', kind })
  const silent = (service: string): ServiceReporting => ({ service, lastSeen: 0, silentMinutes: 42, isReporting: false })
  const read = (over: Partial<HealthReadout['snapshot'] & object> = {}, state: 'healthy' | 'degraded' | 'blind' = 'degraded'): HealthReadout => ({
    id: 'prod',
    name: 'Prod',
    state,
    minErrorsToFlag: 10,
    errorWindowHours: 24,
    snapshot: { silentServices: [], pods: [], errorServices: [], podVisibility: 'visible', blindSpots: [], ...over }
  })

  it('announces a service that stops reporting, a pod that goes down and a signal that starts worsening', () => {
    const first = healthAlerts(undefined, [read({ silentServices: [silent('a')], pods: [pod('p1', 'notReady')] })])
    const second = healthAlerts(first.baseline, [
      read({
        silentServices: [silent('a'), silent('b')],
        pods: [pod('p1', 'notReady'), pod('p2', 'crashLoop'), pod('p3', 'restarting')],
        errorServices: [
          { service: 'api', stats: stats('worsening', 120) },
          { service: 'tiny', stats: stats('worsening', 3) },
          { service: 'old', stats: stats('chronic', 500) }
        ]
      })
    ])
    expect(second.alerts.map((a) => [a.kind, a.subject])).toEqual([
      ['stoppedReporting', 'b'],
      ['podDown', 'p2'],
      ['errorsWorsening', 'api']
    ])
    expect(second.alerts[1]?.crashLoop).toBe(true)
    expect(second.alerts[2]).toMatchObject({ count: 120, hours: 24, factor: 12 })
    // The same picture again is not news.
    expect(healthAlerts(second.baseline, [read({ silentServices: [silent('a'), silent('b')], pods: [pod('p2', 'crashLoop')], errorServices: [{ service: 'api', stats: stats('worsening', 130) }] })]).alerts).toEqual([])
  })

  it('compares a list only when it was read both times', () => {
    const unread = { code: 'unread' as const, signal: 'reporting' as const, detail: 'timeout' }
    const first = healthAlerts(undefined, [read({ blindSpots: [unread] })])
    expect(healthAlerts(first.baseline, [read({ silentServices: [silent('a')] })]).alerts).toEqual([])
    const hidden = healthAlerts(undefined, [read({ podVisibility: 'missing' })])
    expect(healthAlerts(hidden.baseline, [read({ pods: [pod('p1', 'notReady')] })]).alerts).toEqual([])
  })

  it('folds a burst into one line after the first three', () => {
    const first = healthAlerts(undefined, [read()])
    const pods = ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => pod(p, 'notReady'))
    const r = healthAlerts(first.baseline, [read({ pods })])
    expect(r.alerts.map((a) => a.subject)).toEqual(['p1', 'p2', 'p3', '+more'])
    expect(r.alerts[3]?.others).toEqual(['p4', 'p5'])
  })

  it('announces each subject at most once an hour, and a new incident gets its own recovery', () => {
    const alert = (kind: HealthAlert['kind'], subject = ''): HealthAlert => ({ environmentId: 'prod', environmentName: 'Prod', kind, subject })
    const t0 = 1_000_000
    const one = admitHealthAlerts([alert('podDown', 'p1'), alert('recovered')], {}, t0)
    expect(one.admitted).toHaveLength(2)
    const again = admitHealthAlerts([alert('podDown', 'p1'), alert('podDown', 'p2')], one.firedAt, t0 + 10 * 60_000)
    expect(again.admitted.map((a) => a.subject)).toEqual(['p2'])
    expect(admitHealthAlerts([alert('podDown', 'p1')], again.firedAt, t0 + HEALTH_ALERT_COOLDOWN_MS).admitted).toHaveLength(1)
    const degraded = admitHealthAlerts([alert('degraded')], one.firedAt, t0 + 60_000)
    expect(healthAlertKey(alert('recovered')) in degraded.firedAt).toBe(false)
    expect(admitHealthAlerts([alert('recovered')], degraded.firedAt, t0 + 120_000).admitted).toHaveLength(1)
    // Old entries are dropped, so the record does not grow forever.
    expect(Object.keys(admitHealthAlerts([], again.firedAt, t0 + 3 * HEALTH_ALERT_COOLDOWN_MS).firedAt)).toEqual([])
  })

  it('picks the worst state for the menu', () => {
    expect(worstHealth(['healthy', 'blind', 'degraded'])).toBe('degraded')
    expect(worstHealth([])).toBeNull()
  })
})

describe('ticket changes', () => {
  const t = (key: string, status: string, title = key) => ({ key, status, title })

  it('only records on the first read', () => {
    const r = ticketChanges(undefined, [t('A-1', 'To Do')])
    expect(r.changes).toEqual([])
    expect(r.known).toEqual({ 'A-1': { status: 'To Do', title: 'A-1' } })
  })

  it('reports status changes, new assignments and tickets that left', () => {
    const known = { 'A-1': { status: 'To Do', title: 'one' }, 'A-2': { status: 'In Review', title: 'two' } }
    const r = ticketChanges(known, [t('A-1', 'In Progress', 'one'), t('A-3', 'To Do', 'three')])
    expect(r.changes).toEqual([
      { kind: 'status', key: 'A-1', title: 'one', from: 'To Do', to: 'In Progress' },
      { kind: 'assigned', key: 'A-3', title: 'three', status: 'To Do' },
      { kind: 'left', key: 'A-2', title: 'two' }
    ])
    expect(Object.keys(r.known)).toEqual(['A-1', 'A-3'])
  })
})

const text: TrayText = {
  t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
  tn: (base, count) => `${base}:${count}`,
  time: () => '08:00',
  windowLabel: (w) => w
}

const baseState = (s: Partial<TrayState> = {}): TrayState => ({
  appName: 'Workhub 2',
  sessions: [],
  usage: [],
  pullRequests: null,
  prEvents: [],
  health: null,
  slack: null,
  canCheckForUpdates: false,
  ...s
})

const labels = (items: TrayItem[]): string[] => items.flatMap((i) => (i.type === 'separator' ? ['---'] : i.type === 'submenu' ? [`>${i.label}`, ...labels(i.items).map((l) => `  ${l}`)] : [i.label]))
const actions = (items: TrayItem[]): TrayAction[] => items.flatMap((i) => (i.type === 'action' ? [i.action] : i.type === 'submenu' ? actions(i.items) : []))

describe('tray attention and badge', () => {
  const sessions = [
    { id: 'a', title: 'replied', state: 'ready' as const, unseen: 'replied' as const },
    { id: 'b', title: 'busy', state: 'busy' as const },
    { id: 'c', title: 'broken', state: 'error' as const },
    { id: 'd', title: 'asks', state: 'ready' as const, awaitingAnswer: true },
    { id: 'e', title: 'idle', state: 'ready' as const }
  ]

  it('lists what needs a look, most urgent first, and counts the running ones', () => {
    const a = trayAttention(sessions)
    expect(a.sessions.map((s) => s.session.id)).toEqual(['c', 'd', 'a'])
    expect(a.running).toBe(1)
    expect(a.level).toBe('error')
  })

  it('puts the count in the macOS title and the tooltip', () => {
    const b = trayBadge(baseState({ sessions }), text)
    expect(b).toMatchObject({ count: 3, level: 'error', title: '3' })
    expect(b.tooltip).toBe('Workhub 2 · tray.tooltip.attention:3 · tray.tooltip.running:1')
    expect(trayBadge(baseState(), text)).toMatchObject({ count: 0, title: '', tooltip: 'Workhub 2' })
  })

  it('says when notifications are paused', () => {
    expect(trayBadge(baseState({ pausedUntil: Date.now() + 60_000 }), text).tooltip).toContain('tray.tooltip.paused')
  })
})

describe('tray menu', () => {
  it('has the quick actions even with nothing to show', () => {
    const items = buildTrayMenu(baseState(), text)
    expect(labels(items)).toContain('tray.nothingNeedsYou')
    expect(actions(items).map((a) => a.kind)).toEqual(['newSession', 'open', 'navigate', 'pause', 'pause', 'quit'])
  })

  it('opens each session that needs a look and caps the list', () => {
    const many = Array.from({ length: TRAY_ATTENTION_LIMIT + 2 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, state: 'ready' as const, unseen: 'replied' as const }))
    const items = buildTrayMenu(baseState({ sessions: many }), text)
    const top = items.filter((i) => i.type === 'action' && i.action.kind === 'openSession')
    expect(top).toHaveLength(TRAY_ATTENTION_LIMIT)
    expect(labels(items)).toContain('tray.more:2')
    const all = items.find((i) => i.type === 'submenu' && i.label === `tray.allSessions:${many.length}`)
    expect(all?.type === 'submenu' && all.items).toHaveLength(many.length)
  })

  it('shows usage, pull requests, Health and Slack when there is data', () => {
    const items = buildTrayMenu(
      baseState({
        usage: [{ name: 'Claude', windows: [{ window: '5h', percent: 41.6 }, { window: 'weekly', percent: 10 }, { window: 'x', percent: 1 }] }, { name: 'Codex', windows: [], error: true }],
        pullRequests: { toReview: 2, mine: 3 },
        prEvents: [{ profileId: 'p', url: 'https://x/pr/1', title: 'Approved: fix' }],
        health: { state: 'degraded', degraded: ['Prod'] },
        slack: { health: 'failing', open: 4, unread: 1, error: 'no token' },
        canCheckForUpdates: true
      }),
      text
    )
    const l = labels(items)
    expect(l).toContain('Claude — tray.usageWindow{"window":"5h","percent":42} · tray.usageWindow{"window":"weekly","percent":10}')
    expect(l).toContain('Codex — tray.usageUnavailable')
    expect(l).toContain('tray.pr.toReview{"count":2}')
    expect(l).toContain('tray.section.health: tray.health.degraded (Prod)')
    expect(l).toContain('tray.section.slack: tray.slack.failing · tray.slack.threads:4 · tray.slack.unread:1')
    expect(l).toContain('tray.slack.error{"error":"no token"}')
    expect(l).toContain('tray.checkForUpdates')
    expect(actions(items)).toContainEqual({ kind: 'openPullRequest', profileId: 'p', url: 'https://x/pr/1' })
    expect(actions(items)).toContainEqual({ kind: 'navigate', route: 'health' })
  })

  it('lists recent notifications, which open what their click opens', () => {
    const items = buildTrayMenu(baseState({ notifications: [{ id: 'n1', title: 'PROD is degraded' }] }), text)
    expect(labels(items)).toContain('>tray.section.notifications')
    expect(actions(items)).toContainEqual({ kind: 'openNotification', id: 'n1' })
  })

  it('offers to resume while paused', () => {
    const now = Date.now()
    const items = buildTrayMenu(baseState({ pausedUntil: now + 60_000 }), text, now)
    expect(labels(items)).toContain('>tray.pausedUntil{"time":"08:00"}')
    expect(actions(items)).toContainEqual({ kind: 'resume' })
    expect(actions(buildTrayMenu(baseState({ pausedUntil: now - 1 }), text, now))).not.toContainEqual({ kind: 'resume' })
  })
})
