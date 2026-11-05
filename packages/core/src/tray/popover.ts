/**
 * The menu bar popover (macOS, Windows): the same state as the native tray menu, shaped for a
 * small window of flat rows instead of a list of menu items. A header with one verdict line, a
 * "Today" block (the next meetings, Plan tasks due today, pull requests, and Health or Slack only
 * while they are in trouble), one usage bar per agent account, short session lists (needs you,
 * working) and the recent notifications, and a fixed footer. The blocks follow the user's choice
 * (Settings → Notifications → Menu bar panel). Pure data: the renderer words it, the main process
 * positions the window (popover-position.ts).
 */
import { statusLevel, type StatusLevel } from '../domain/attention'
import type { SessionState } from '../domain/session'
import type { HealthState } from '../health/types'
import { DEFAULT_TRAY_POPOVER_OPTIONS, type TrayPopoverOptions } from '../config/schema'
import { pausedIndefinitely } from '../notifications/policy'
import { TRAY_ROUTES, TRAY_SETTINGS_SECTIONS, trayAttention, type TrayAction, type TraySession, type TrayRoute, type TraySettingsSection, type TraySlackHealth, type TrayState } from './menu'

export type TrayTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export interface TrayPopoverSession {
  id: string
  title: string
  agentId?: string
  state: SessionState
  level: StatusLevel | null
  /** Epoch ms since it shows this state, when known. */
  since?: number
}

export interface TrayPopoverUsageWindow {
  window: string
  /** 0-100, rounded. */
  percent: number
  tone: TrayTone
  resetsAt?: number
}

/** One usage row: an agent account and its most spent window. */
export interface TrayPopoverUsage {
  name: string
  agentId?: string
  window: TrayPopoverUsageWindow
}

/** A meeting row of "Today". */
export interface TrayPopoverMeeting {
  id: string
  title: string
  startsAt: number
  endsAt?: number
  location?: string
  /** "Meet", "Zoom", "Teams"…, from the call link. */
  provider?: string
  hasJoinUrl: boolean
  /** Started and not ended. */
  ongoing: boolean
  /** Starts within `TRAY_POPOVER_SOON_MS` (or is on): with a call link the row offers "Join". */
  soon: boolean
}

/** The header's one line: what needs the user, else what is working, else nothing. */
export interface TrayPopoverVerdict {
  kind: 'needsYou' | 'working' | 'caughtUp' | 'empty'
  count: number
  tone: TrayTone
}

export interface TrayPopoverView {
  appName: string
  summary: { open: number; running: number; attention: number }
  /** The most urgent level among the sessions that need the user. */
  level: StatusLevel | null
  verdict: TrayPopoverVerdict
  /** "Today": empty lists and nulls leave rows out; with nothing at all the block is not drawn. */
  today: {
    /** Soonest first, at most the user's meeting count. */
    meetings: TrayPopoverMeeting[]
    /** Overdue first, at most `TRAY_POPOVER_PLAN_LIMIT`. */
    plan: { id: string; title: string; overdue: boolean }[]
    /** Null without a code host (or hidden). */
    pullRequests: { toReview: number; mine: number } | null
    /** Only while Health is degraded or unreachable. */
    health: { state: HealthState; degraded: string[]; tone: TrayTone } | null
    /** Only while the Slack watcher fails. */
    slack: { error?: string; tone: TrayTone } | null
  }
  /** One row per agent account with a reading; empty hides the block. */
  usage: TrayPopoverUsage[]
  /** Most urgent first, at most `TRAY_POPOVER_NEEDS_YOU_LIMIT`. */
  needsYou: TrayPopoverSession[]
  needsYouMore: number
  /** Working sessions that do not need the user, longest running first, at most `TRAY_POPOVER_WORKING_LIMIT`. */
  working: TrayPopoverSession[]
  workingMore: number
  /** Newest first, at most `TRAY_POPOVER_NOTIFICATION_LIMIT`; none about a session already listed above. */
  notifications: { id: string; title: string; at?: number }[]
  notificationsMore: number
  /** Epoch ms when notifications are paused; null when they are not. */
  pausedUntil: number | null
  /** Paused until the user resumes (no end time to show). */
  pausedIndefinitely: boolean
  canCheckForUpdates: boolean
}

export const TRAY_POPOVER_NEEDS_YOU_LIMIT = 5
export const TRAY_POPOVER_WORKING_LIMIT = 3
export const TRAY_POPOVER_NOTIFICATION_LIMIT = 4
export const TRAY_POPOVER_PLAN_LIMIT = 2
/** A meeting this close to its start offers "Join". */
export const TRAY_POPOVER_SOON_MS = 15 * 60_000

/** Bar color by how much of a usage window is spent: the same thresholds as the Home usage bars. */
export function usageTone(percent: number): TrayTone {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warning'
  return 'success'
}

const HEALTH_TONE: Record<HealthState, TrayTone> = { healthy: 'success', degraded: 'warning', blind: 'neutral', unreachable: 'danger' }
/** The Health states "Today" shows: the rest live on the Health screen. */
const HEALTH_SHOWN: readonly HealthState[] = ['degraded', 'unreachable']
const LEVEL_TONE: Record<StatusLevel, TrayTone> = { error: 'danger', needsAnswer: 'warning', readyToReview: 'success', working: 'info' }

const WINDOW_ORDER = ['5h', 'weekly']
const windowRank = (w: string) => {
  const i = WINDOW_ORDER.indexOf(w)
  return i < 0 ? WINDOW_ORDER.length : i
}

const PROVIDERS: readonly [RegExp, string][] = [
  [/(^|\.)meet\.google\.com$/, 'Meet'],
  [/(^|\.)zoom\.(us|com)$/, 'Zoom'],
  [/(^|\.)teams\.(microsoft|live)\.com$/, 'Teams'],
  [/(^|\.)webex\.com$/, 'Webex'],
  [/(^|\.)whereby\.com$/, 'Whereby'],
  [/(^|\.)around\.co$/, 'Around'],
  [/(^|\.)meet\.jit\.si$/, 'Jitsi']
]

/** The video call service of a link ("Meet", "Zoom"…); undefined for anything else. */
export function meetingProvider(url: string | undefined): string | undefined {
  if (!url) return undefined
  const host = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url.trim())?.[1]?.toLowerCase()
  if (!host) return undefined
  return PROVIDERS.find(([re]) => re.test(host))?.[1]
}

function popoverSession(session: TraySession): TrayPopoverSession {
  const out: TrayPopoverSession = { id: session.id, title: session.title, state: session.state, level: statusLevel(session) }
  if (session.agentId) out.agentId = session.agentId
  if (session.since !== undefined) out.since = session.since
  return out
}

function verdictOf(summary: TrayPopoverView['summary'], level: StatusLevel | null): TrayPopoverVerdict {
  if (summary.attention > 0) return { kind: 'needsYou', count: summary.attention, tone: level ? LEVEL_TONE[level] : 'warning' }
  if (summary.running > 0) return { kind: 'working', count: summary.running, tone: 'info' }
  if (summary.open > 0) return { kind: 'caughtUp', count: 0, tone: 'success' }
  return { kind: 'empty', count: 0, tone: 'neutral' }
}

/** One row per account with a reading: its most spent window (5h before weekly on a tie). */
function usageOf(accounts: TrayState['usage'], now: number): TrayPopoverUsage[] {
  const rows: TrayPopoverUsage[] = []
  for (const account of accounts) {
    if (account.error) continue
    let best: TrayPopoverUsageWindow | null = null
    for (const w of [...account.windows].sort((a, b) => windowRank(a.window) - windowRank(b.window))) {
      const percent = Math.round(Math.min(100, Math.max(0, w.percent)))
      if (best && best.percent >= percent) continue
      best = { window: w.window, percent, tone: usageTone(percent) }
      if (typeof w.resetsAt === 'number' && w.resetsAt > now) best.resetsAt = w.resetsAt
    }
    if (!best) continue
    const row: TrayPopoverUsage = { name: account.name, window: best }
    if (account.agentId) row.agentId = account.agentId
    rows.push(row)
  }
  return rows
}

function meetingsOf(events: TrayState['calendar'], count: number, now: number): TrayPopoverMeeting[] {
  return [...(events ?? [])]
    .filter((e) => (e.endsAt ?? e.startsAt) > now || e.startsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, count)
    .map((e) => {
      const ongoing = e.startsAt <= now
      const m: TrayPopoverMeeting = { id: e.id, title: e.title, startsAt: e.startsAt, hasJoinUrl: Boolean(e.joinUrl), ongoing, soon: ongoing || e.startsAt - now <= TRAY_POPOVER_SOON_MS }
      if (e.endsAt !== undefined) m.endsAt = e.endsAt
      if (e.location) m.location = e.location
      const provider = meetingProvider(e.joinUrl)
      if (provider) m.provider = provider
      return m
    })
}

export function buildTrayPopover(state: TrayState, now = Date.now()): TrayPopoverView {
  const show: TrayPopoverOptions = { ...DEFAULT_TRAY_POPOVER_OPTIONS, ...state.popover }
  const attention = trayAttention(state.sessions)
  const needing = new Set(attention.sessions.map((a) => a.session.id))
  const working = state.sessions
    .filter((s) => !needing.has(s.id))
    .map(popoverSession)
    .filter((s) => s.level === 'working')
    .sort((a, b) => (a.since ?? now) - (b.since ?? now))
  // A session already under "Needs you" or "Working" is not repeated under "Recent".
  const listed = new Set([...needing, ...working.map((s) => s.id)])
  const notifications = show.recent ? (state.notifications ?? []).filter((n) => !n.sessionId || !listed.has(n.sessionId)) : []
  const paused = typeof state.pausedUntil === 'number' && state.pausedUntil > now
  const summary = { open: state.sessions.length, running: attention.running, attention: attention.sessions.length }
  const health = state.health
  const plan = show.plan ? [...(state.planDueToday ?? [])].sort((a, b) => Number(Boolean(b.overdue)) - Number(Boolean(a.overdue))) : []
  return {
    appName: state.appName,
    summary,
    level: attention.level,
    verdict: verdictOf(summary, attention.level),
    today: {
      meetings: show.meetings ? meetingsOf(state.calendar, show.meetingCount, now) : [],
      plan: plan.slice(0, TRAY_POPOVER_PLAN_LIMIT).map((i) => ({ id: i.id, title: i.title, overdue: Boolean(i.overdue) })),
      pullRequests: show.pullRequests && state.pullRequests ? { ...state.pullRequests } : null,
      health: show.health && health?.state && HEALTH_SHOWN.includes(health.state) ? { state: health.state, degraded: [...health.degraded], tone: HEALTH_TONE[health.state] } : null,
      slack: state.slack?.health === 'failing' ? { ...(state.slack.error ? { error: state.slack.error } : {}), tone: 'danger' } : null
    },
    usage: show.usage ? usageOf(state.usage, now) : [],
    needsYou: attention.sessions.slice(0, TRAY_POPOVER_NEEDS_YOU_LIMIT).map((a) => popoverSession(a.session)),
    needsYouMore: Math.max(0, attention.sessions.length - TRAY_POPOVER_NEEDS_YOU_LIMIT),
    working: working.slice(0, TRAY_POPOVER_WORKING_LIMIT),
    workingMore: Math.max(0, working.length - TRAY_POPOVER_WORKING_LIMIT),
    notifications: notifications.slice(0, TRAY_POPOVER_NOTIFICATION_LIMIT).map((n) => ({ id: n.id, title: n.title, ...(n.at !== undefined ? { at: n.at } : {}) })),
    notificationsMore: Math.max(0, notifications.length - TRAY_POPOVER_NOTIFICATION_LIMIT),
    pausedUntil: paused ? state.pausedUntil! : null,
    pausedIndefinitely: paused && pausedIndefinitely(state.pausedUntil),
    canCheckForUpdates: state.canCheckForUpdates
  }
}

/** Whether the popover's "Today" block has anything to show. */
export function hasToday(today: TrayPopoverView['today']): boolean {
  return today.meetings.length > 0 || today.plan.length > 0 || today.pullRequests !== null || today.health !== null || today.slack !== null
}

export interface SinceEntry {
  key: string
  at: number
}

/**
 * Stamps each session with the time it entered its current state (level, or plain state when it
 * needs nothing). `previous` is what the last call returned; sessions that are gone are dropped.
 */
export function stampSince(
  previous: ReadonlyMap<string, SinceEntry>,
  sessions: readonly TraySession[],
  now: number
): { sessions: TraySession[]; since: Map<string, SinceEntry> } {
  const since = new Map<string, SinceEntry>()
  const stamped = sessions.map((s) => {
    const key = statusLevel(s) ?? s.state
    const prev = previous.get(s.id)
    const entry = prev && prev.key === key ? prev : { key, at: now }
    since.set(s.id, entry)
    return { ...s, since: entry.at }
  })
  return { sessions: stamped, since }
}

const isText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** A tray action sent by the popover's renderer, checked field by field; null for anything else. */
export function parseTrayAction(raw: unknown): TrayAction | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  switch (a['kind']) {
    case 'open':
    case 'newSession':
    case 'resume':
    case 'clearNotifications':
    case 'checkForUpdates':
    case 'quit':
      return { kind: a['kind'] }
    case 'openSession':
      return isText(a['id'], 200) ? { kind: 'openSession', id: a['id'] } : null
    case 'openNotification':
      return isText(a['id'], 200) ? { kind: 'openNotification', id: a['id'] } : null
    case 'openMeeting':
      return isText(a['id'], 500) ? { kind: 'openMeeting', id: a['id'] } : null
    case 'openSettings':
      return TRAY_SETTINGS_SECTIONS.includes(a['section'] as TraySettingsSection) ? { kind: 'openSettings', section: a['section'] as TraySettingsSection } : null
    case 'navigate':
      return TRAY_ROUTES.includes(a['route'] as TrayRoute) ? { kind: 'navigate', route: a['route'] as TrayRoute } : null
    case 'openPullRequest':
      return typeof a['profileId'] === 'string' && a['profileId'].length <= 200 && isText(a['url']) && /^https?:\/\//i.test(a['url'])
        ? { kind: 'openPullRequest', profileId: a['profileId'], url: a['url'] }
        : null
    case 'pause':
      return a['preset'] === 'hour' || a['preset'] === 'tomorrow' || a['preset'] === 'indefinite' ? { kind: 'pause', preset: a['preset'] } : null
    default:
      return null
  }
}
