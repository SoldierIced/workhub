/**
 * The menu bar (macOS) / notification area (Windows) / status icon (Linux) menu, as plain data.
 * It mirrors Workhub 1's menu bar panel as far as Workhub 2 has the data: sessions that need the
 * user, every open session, usage per agent account, pull requests and their latest events,
 * Health, Slack, and the quick actions. The main process turns the model into a native menu; the
 * words come from the caller (`TrayText`), so this module stays pure and testable.
 */
import { statusLevel, type AttentionKind, type StatusLevel } from '../domain/attention'
import type { SessionState } from '../domain/session'
import type { HealthState } from '../health/types'
import type { PausePreset } from '../notifications/policy'

export interface TraySession {
  id: string
  title: string
  state: SessionState
  unseen?: AttentionKind
  awaitingAnswer?: boolean
  /** The agent's id (`claude`, `codex`…), for its icon in the popover. */
  agentId?: string
  /** Epoch ms since the session shows its current state (see `stampSince`). */
  since?: number
}

export interface TrayUsageAccount {
  name: string
  /** The agent the account belongs to (`claude`, `codex`). */
  agentId?: string
  windows: readonly { window: string; percent: number; resetsAt?: number }[]
  error?: boolean
}

export interface TrayPrEvent {
  profileId: string
  url: string
  title: string
}

export type TraySlackHealth = 'off' | 'watching' | 'checking' | 'paused' | 'failing'

export interface TrayState {
  /** "Workhub 2", or "Workhub 2 Dev" for a dev run. */
  appName: string
  sessions: readonly TraySession[]
  usage: readonly TrayUsageAccount[]
  /** Null while the code host is not connected. */
  pullRequests: { toReview: number; mine: number } | null
  /** Newest first. */
  prEvents: readonly TrayPrEvent[]
  /** Null while Health is off or not set up. */
  health: { state: HealthState | null; degraded: readonly string[] } | null
  /** Null while the Slack watcher is off. */
  slack: { health: TraySlackHealth; open: number; unread: number; error?: string } | null
  /** Notifications shown lately, newest first (Workhub 1's "Notifications" list). */
  notifications?: readonly { id: string; title: string; at?: number }[]
  /** Epoch ms; unset or in the past when notifications are not paused. */
  pausedUntil?: number
  /** Whether "Check for updates" makes sense (a packaged build). */
  canCheckForUpdates: boolean
}

export type TrayRoute = 'home' | 'sessions' | 'pullRequests' | 'tickets' | 'slack' | 'automations' | 'health' | 'settings'

export const TRAY_ROUTES: readonly TrayRoute[] = ['home', 'sessions', 'pullRequests', 'tickets', 'slack', 'automations', 'health', 'settings']

export type TrayAction =
  | { kind: 'open' }
  | { kind: 'openSession'; id: string }
  | { kind: 'navigate'; route: TrayRoute }
  | { kind: 'openPullRequest'; profileId: string; url: string }
  /** Does what a click on that notification does. */
  | { kind: 'openNotification'; id: string }
  | { kind: 'newSession' }
  | { kind: 'pause'; preset: PausePreset }
  | { kind: 'resume' }
  | { kind: 'checkForUpdates' }
  | { kind: 'quit' }

export type TrayItem =
  | { type: 'separator' }
  /** A line of information; it is shown disabled, like a section title. */
  | { type: 'label'; label: string }
  | { type: 'action'; label: string; action: TrayAction }
  | { type: 'submenu'; label: string; items: TrayItem[] }

export interface TrayText {
  t(key: string, params?: Record<string, string | number>): string
  /** Picks `<base>.one` or `<base>.other`; `count` is passed as a param. */
  tn(base: string, count: number, params?: Record<string, string | number>): string
  /** A clock time for the pause, e.g. "08:00". */
  time(epochMs: number): string
  /** A usage window's name, e.g. "5h" or "Weekly". */
  windowLabel(window: string): string
}

/** Most urgent first, at most this many sessions are listed under "Needs you". */
export const TRAY_ATTENTION_LIMIT = 8
export const TRAY_PR_EVENT_LIMIT = 5
export const TRAY_NOTIFICATION_LIMIT = 8

const ATTENTION_ORDER: StatusLevel[] = ['error', 'needsAnswer', 'readyToReview']

export interface TrayAttention {
  /** Sessions that need a look, most urgent first. */
  sessions: { session: TraySession; level: StatusLevel }[]
  running: number
  /** The most urgent level among them; null when nothing needs a look. */
  level: StatusLevel | null
}

/** Sessions that need a look (an error, a question or permission, an unread reply) and how many are working. */
export function trayAttention(sessions: readonly TraySession[]): TrayAttention {
  const needs: { session: TraySession; level: StatusLevel }[] = []
  let running = 0
  for (const session of sessions) {
    const level = statusLevel(session)
    if (level === 'working') running += 1
    else if (level) needs.push({ session, level })
  }
  needs.sort((a, b) => ATTENTION_ORDER.indexOf(a.level) - ATTENTION_ORDER.indexOf(b.level))
  return { sessions: needs, running, level: needs[0]?.level ?? null }
}

export interface TrayBadge {
  /** Sessions that need a look. */
  count: number
  level: StatusLevel | null
  /** macOS: text next to the icon (empty for none). */
  title: string
  /** Hover text on every platform; Linux and Windows show the count only here. */
  tooltip: string
}

export function trayBadge(state: TrayState, text: TrayText): TrayBadge {
  const attention = trayAttention(state.sessions)
  const count = attention.sessions.length
  const parts = [state.appName]
  if (count > 0) parts.push(text.tn('tray.tooltip.attention', count))
  if (attention.running > 0) parts.push(text.tn('tray.tooltip.running', attention.running))
  if (isPaused(state)) parts.push(text.t('tray.tooltip.paused'))
  return { count, level: attention.level, title: count > 0 ? String(count) : '', tooltip: parts.join(' · ') }
}

const isPaused = (state: TrayState, now = Date.now()) => typeof state.pausedUntil === 'number' && state.pausedUntil > now

const LEVEL_KEY: Record<StatusLevel, string> = {
  error: 'tray.level.error',
  needsAnswer: 'tray.level.needsAnswer',
  readyToReview: 'tray.level.replied',
  working: 'tray.level.working'
}


const truncate = (s: string, max = 48) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

function sessionLine(session: TraySession, level: StatusLevel | null, text: TrayText): string {
  const title = truncate(session.title || text.t('tray.untitled'))
  return level ? `${title} — ${text.t(LEVEL_KEY[level])}` : title
}

export function buildTrayMenu(state: TrayState, text: TrayText, now = Date.now()): TrayItem[] {
  const { t, tn } = text
  const attention = trayAttention(state.sessions)
  const items: TrayItem[] = []
  const nav = (route: TrayRoute): TrayAction => ({ kind: 'navigate', route })

  // Header: the app and a one-line summary.
  items.push({ type: 'label', label: state.appName })
  const summary = [tn('tray.summary.open', state.sessions.length), tn('tray.summary.running', attention.running)]
  if (attention.sessions.length) summary.push(tn('tray.summary.attention', attention.sessions.length))
  items.push({ type: 'label', label: summary.join(' · ') })
  items.push({ type: 'separator' })

  // Sessions that need the user, most urgent first.
  items.push({ type: 'label', label: t('tray.section.needsYou') })
  if (attention.sessions.length === 0) items.push({ type: 'label', label: t('tray.nothingNeedsYou') })
  for (const { session, level } of attention.sessions.slice(0, TRAY_ATTENTION_LIMIT)) {
    items.push({ type: 'action', label: sessionLine(session, level, text), action: { kind: 'openSession', id: session.id } })
  }
  if (attention.sessions.length > TRAY_ATTENTION_LIMIT) {
    items.push({ type: 'action', label: tn('tray.more', attention.sessions.length - TRAY_ATTENTION_LIMIT), action: nav('sessions') })
  }
  if (state.sessions.length) {
    items.push({
      type: 'submenu',
      label: tn('tray.allSessions', state.sessions.length),
      items: state.sessions.map((s) => ({ type: 'action', label: sessionLine(s, statusLevel(s), text), action: { kind: 'openSession', id: s.id } }))
    })
  }

  // Usage per agent account.
  if (state.usage.length) {
    items.push({ type: 'separator' })
    items.push({ type: 'label', label: t('tray.section.usage') })
    for (const account of state.usage) {
      const windows = account.windows.slice(0, 2).map((w) => t('tray.usageWindow', { window: text.windowLabel(w.window), percent: Math.round(w.percent) }))
      const detail = account.error ? t('tray.usageUnavailable') : windows.length ? windows.join(' · ') : t('tray.usageUnknown')
      items.push({ type: 'action', label: `${truncate(account.name, 32)} — ${detail}`, action: nav('home') })
    }
  }

  // Pull requests and their latest events.
  if (state.pullRequests || state.prEvents.length) {
    items.push({ type: 'separator' })
    items.push({ type: 'label', label: t('tray.section.pullRequests') })
    if (state.pullRequests) {
      items.push({ type: 'action', label: t('tray.pr.toReview', { count: state.pullRequests.toReview }), action: nav('pullRequests') })
      items.push({ type: 'action', label: t('tray.pr.mine', { count: state.pullRequests.mine }), action: nav('pullRequests') })
    }
    if (state.prEvents.length) {
      items.push({
        type: 'submenu',
        label: t('tray.pr.recent'),
        items: state.prEvents.slice(0, TRAY_PR_EVENT_LIMIT).map((e) => ({ type: 'action', label: truncate(e.title, 64), action: { kind: 'openPullRequest', profileId: e.profileId, url: e.url } }))
      })
    }
  }

  // Health and Slack.
  if (state.health || state.slack) items.push({ type: 'separator' })
  if (state.health) {
    const label = state.health.state ? t(`tray.health.${state.health.state}`) : t('tray.health.pending')
    const where = state.health.degraded.length ? ` (${truncate(state.health.degraded.join(', '), 32)})` : ''
    items.push({ type: 'action', label: `${t('tray.section.health')}: ${label}${where}`, action: nav('health') })
  }
  if (state.slack) {
    const parts = [t(`tray.slack.${state.slack.health}`), tn('tray.slack.threads', state.slack.open)]
    if (state.slack.unread) parts.push(tn('tray.slack.unread', state.slack.unread))
    items.push({ type: 'action', label: `${t('tray.section.slack')}: ${parts.join(' · ')}`, action: nav('slack') })
    if (state.slack.health === 'failing' && state.slack.error) items.push({ type: 'action', label: t('tray.slack.error', { error: truncate(state.slack.error, 60) }), action: nav('slack') })
  }

  if (state.notifications?.length) {
    items.push({ type: 'separator' })
    items.push({
      type: 'submenu',
      label: t('tray.section.notifications'),
      items: state.notifications.slice(0, TRAY_NOTIFICATION_LIMIT).map((n) => ({ type: 'action', label: truncate(n.title, 64), action: { kind: 'openNotification', id: n.id } }))
    })
  }

  // Quick actions.
  items.push({ type: 'separator' })
  items.push({ type: 'action', label: t('tray.newSession'), action: { kind: 'newSession' } })
  items.push({ type: 'action', label: t('tray.open', { app: state.appName }), action: { kind: 'open' } })
  items.push({ type: 'action', label: t('tray.settings'), action: nav('settings') })
  const paused = isPaused(state, now)
  items.push({
    type: 'submenu',
    label: paused ? t('tray.pausedUntil', { time: text.time(state.pausedUntil!) }) : t('tray.pause'),
    items: [
      { type: 'action', label: t('tray.pause.hour'), action: { kind: 'pause', preset: 'hour' } },
      { type: 'action', label: t('tray.pause.tomorrow'), action: { kind: 'pause', preset: 'tomorrow' } },
      ...(paused ? [{ type: 'separator' } as const, { type: 'action', label: t('tray.resume'), action: { kind: 'resume' } } as const] : [])
    ]
  })
  if (state.canCheckForUpdates) items.push({ type: 'action', label: t('tray.checkForUpdates'), action: { kind: 'checkForUpdates' } })
  items.push({ type: 'separator' })
  items.push({ type: 'action', label: t('tray.quit', { app: state.appName }), action: { kind: 'quit' } })
  return items
}
