/**
 * The menu bar popover (macOS, Windows): the same state as the native tray menu, shaped for a
 * small window instead of a list of menu items. It mirrors Workhub 1's menu bar panel: a header
 * with a summary and quick buttons, the sessions that need the user, the other open sessions,
 * usage bars per agent account, pull requests, Health, Slack, recent notifications and a footer.
 * Pure data: the renderer words it, the main process positions the window (popover-position.ts).
 */
import { statusLevel, type StatusLevel } from '../domain/attention'
import type { SessionState } from '../domain/session'
import type { HealthState } from '../health/types'
import { TRAY_ROUTES, trayAttention, type TrayAction, type TraySession, type TrayRoute, type TraySlackHealth, type TrayState } from './menu'

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

export interface TrayPopoverUsageAccount {
  name: string
  agentId?: string
  error: boolean
  /** The 5h and weekly windows first, at most three. */
  windows: TrayPopoverUsageWindow[]
}

export interface TrayPopoverView {
  appName: string
  summary: { open: number; running: number; attention: number }
  /** The most urgent level among the sessions that need the user. */
  level: StatusLevel | null
  /** Most urgent first, at most `TRAY_POPOVER_LIST_LIMIT`. */
  needsYou: TrayPopoverSession[]
  needsYouMore: number
  /** Open sessions that do not need the user, working ones first. */
  sessions: TrayPopoverSession[]
  sessionsMore: number
  usage: TrayPopoverUsageAccount[]
  pullRequests: { toReview: number; mine: number } | null
  prEvents: { profileId: string; url: string; title: string }[]
  health: { state: HealthState | null; degraded: string[]; tone: TrayTone } | null
  slack: { health: TraySlackHealth; open: number; unread: number; error?: string; tone: TrayTone } | null
  notifications: { id: string; title: string; at?: number }[]
  /** Epoch ms when notifications are paused; null when they are not. */
  pausedUntil: number | null
  canCheckForUpdates: boolean
}

export const TRAY_POPOVER_LIST_LIMIT = 6
export const TRAY_POPOVER_PR_EVENT_LIMIT = 3
export const TRAY_POPOVER_NOTIFICATION_LIMIT = 5

/** Bar color by how much of a usage window is spent: the same thresholds as the Home usage bars. */
export function usageTone(percent: number): TrayTone {
  if (percent >= 90) return 'danger'
  if (percent >= 75) return 'warning'
  return 'success'
}

const HEALTH_TONE: Record<HealthState, TrayTone> = { healthy: 'success', degraded: 'warning', blind: 'neutral', unreachable: 'danger' }
const SLACK_TONE: Record<TraySlackHealth, TrayTone> = { off: 'neutral', watching: 'success', checking: 'info', paused: 'neutral', failing: 'danger' }

const WINDOW_ORDER = ['5h', 'weekly']
const windowRank = (w: string) => {
  const i = WINDOW_ORDER.indexOf(w)
  return i < 0 ? WINDOW_ORDER.length : i
}

function popoverSession(session: TraySession): TrayPopoverSession {
  const out: TrayPopoverSession = { id: session.id, title: session.title, state: session.state, level: statusLevel(session) }
  if (session.agentId) out.agentId = session.agentId
  if (session.since !== undefined) out.since = session.since
  return out
}

const STATE_ORDER: Record<SessionState, number> = { busy: 0, starting: 1, ready: 2, error: 3, stopped: 4 }

export function buildTrayPopover(state: TrayState, now = Date.now()): TrayPopoverView {
  const attention = trayAttention(state.sessions)
  const needing = new Set(attention.sessions.map((a) => a.session.id))
  const others = state.sessions
    .filter((s) => !needing.has(s.id))
    .map(popoverSession)
    .sort((a, b) => (a.level === 'working' ? 0 : 1) - (b.level === 'working' ? 0 : 1) || STATE_ORDER[a.state] - STATE_ORDER[b.state])
  const paused = typeof state.pausedUntil === 'number' && state.pausedUntil > now
  return {
    appName: state.appName,
    summary: { open: state.sessions.length, running: attention.running, attention: attention.sessions.length },
    level: attention.level,
    needsYou: attention.sessions.slice(0, TRAY_POPOVER_LIST_LIMIT).map((a) => popoverSession(a.session)),
    needsYouMore: Math.max(0, attention.sessions.length - TRAY_POPOVER_LIST_LIMIT),
    sessions: others.slice(0, TRAY_POPOVER_LIST_LIMIT),
    sessionsMore: Math.max(0, others.length - TRAY_POPOVER_LIST_LIMIT),
    usage: state.usage.map((account) => {
      const out: TrayPopoverUsageAccount = {
        name: account.name,
        error: Boolean(account.error),
        windows: [...account.windows]
          .sort((a, b) => windowRank(a.window) - windowRank(b.window))
          .slice(0, 3)
          .map((w) => {
            const percent = Math.round(Math.min(100, Math.max(0, w.percent)))
            const win: TrayPopoverUsageWindow = { window: w.window, percent, tone: usageTone(percent) }
            if (typeof w.resetsAt === 'number' && w.resetsAt > now) win.resetsAt = w.resetsAt
            return win
          })
      }
      if (account.agentId) out.agentId = account.agentId
      return out
    }),
    pullRequests: state.pullRequests ? { ...state.pullRequests } : null,
    prEvents: state.prEvents.slice(0, TRAY_POPOVER_PR_EVENT_LIMIT).map((e) => ({ ...e })),
    health: state.health
      ? { state: state.health.state, degraded: [...state.health.degraded], tone: state.health.state ? HEALTH_TONE[state.health.state] : 'neutral' }
      : null,
    slack: state.slack ? { ...state.slack, tone: SLACK_TONE[state.slack.health] } : null,
    notifications: (state.notifications ?? []).slice(0, TRAY_POPOVER_NOTIFICATION_LIMIT).map((n) => ({ ...n })),
    pausedUntil: paused ? state.pausedUntil! : null,
    canCheckForUpdates: state.canCheckForUpdates
  }
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
    case 'checkForUpdates':
    case 'quit':
      return { kind: a['kind'] }
    case 'openSession':
      return isText(a['id'], 200) ? { kind: 'openSession', id: a['id'] } : null
    case 'openNotification':
      return isText(a['id'], 200) ? { kind: 'openNotification', id: a['id'] } : null
    case 'navigate':
      return TRAY_ROUTES.includes(a['route'] as TrayRoute) ? { kind: 'navigate', route: a['route'] as TrayRoute } : null
    case 'openPullRequest':
      return typeof a['profileId'] === 'string' && a['profileId'].length <= 200 && isText(a['url']) && /^https?:\/\//i.test(a['url'])
        ? { kind: 'openPullRequest', profileId: a['profileId'], url: a['url'] }
        : null
    case 'pause':
      return a['preset'] === 'hour' || a['preset'] === 'tomorrow' ? { kind: 'pause', preset: a['preset'] } : null
    default:
      return null
  }
}
