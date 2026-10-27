import { isReply } from '../chat/digest'
import { chatEventKey, claimEvent, type EventLedger } from '../chat/ledger'
import { isMe, pullRequestOwner, tsToMs } from '../chat/links'
import type { ChatMessage } from '../chat/types'
import type { AutomationDefinition, AutomationLimits, AutomationWindow } from './types'

/** Why a time is outside the window: `days` or `hours`; null inside it. Local time. */
export function windowReason(window: AutomationWindow, now: number): 'days' | 'hours' | null {
  const d = new Date(now)
  if (!window.days.includes(d.getDay())) return 'days'
  const hour = d.getHours()
  if (hour < window.startHour || hour >= window.endHour) return 'hours'
  return null
}

export function startedInWindow(starts: readonly number[], limits: AutomationLimits, now: number): number {
  const span = Math.max(limits.perMinutes, 1) * 60_000
  return starts.filter((t) => now - t < span).length
}

function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startedToday(starts: readonly number[], now: number): number {
  const day = startOfDay(now)
  return starts.filter((t) => t >= day && t <= now).length
}

/** When a limit blocks a start: which one and the first moment a slot is free; null when a run may start. */
export function limitWait(starts: readonly number[], limits: AutomationLimits, now: number): { reason: 'window' | 'day'; until: number } | null {
  const span = Math.max(limits.perMinutes, 1) * 60_000
  const recent = starts.filter((t) => now - t < span).sort((a, b) => a - b)
  const max = Math.max(limits.maxRuns, 1)
  if (recent.length >= max) return { reason: 'window', until: recent[recent.length - max]! + span }
  if (limits.maxPerDay !== null && startedToday(starts, now) >= limits.maxPerDay) {
    const tomorrow = new Date(startOfDay(now))
    tomorrow.setDate(tomorrow.getDate() + 1)
    return { reason: 'day', until: tomorrow.getTime() }
  }
  return null
}

/** The pause after the n-th failure in a row: 2, 4, 8… minutes, at most 60. */
export function failureBackoffMs(streak: number): number {
  return Math.min(2 ** Math.max(streak, 1), 60) * 60_000
}

export function looksRateLimited(text: string): boolean {
  const lower = text.toLowerCase()
  return ['usage limit', 'rate limit', 'hit your limit', 'limit reached', 'rate_limit', 'too many requests'].some((s) => lower.includes(s))
}

/** "…|1712345678" (epoch seconds) in an agent's limit message; the reset time in ms. */
export function resetTimeIn(text: string): number | null {
  const m = /\|(\d{10})\b/.exec(text)
  return m ? Number(m[1]) * 1000 : null
}

// The pending-work gate

export interface GateVerdict {
  actionable: boolean
  /** `missing`, `nothing`, or counts the UI words. */
  reason: 'missing' | 'nothing' | 'pending'
  queued: number
  staleClaims: number
}

/** A claim older than this is considered abandoned and worth a run. */
export const STALE_CLAIM_MS = 60 * 60_000

function dateOf(value: unknown): number | null {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : value * 1000
  return null
}

/**
 * Reads a PR-review skill's state file (already parsed; undefined when missing or unreadable).
 * Actionable: a pending request queued or whose head moved, a request still `queued`, or a
 * `claimed` one whose claim is older than an hour.
 */
export function evaluatePendingGate(root: unknown, now: number): GateVerdict {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return { actionable: true, reason: 'missing', queued: 0, staleClaims: 0 }
  const r = root as Record<string, unknown>
  let queued = 0
  for (const entry of Array.isArray(r['pendingRequests']) ? r['pendingRequests'] : []) {
    const reason = (entry as Record<string, unknown> | null)?.['reason']
    if (reason === 'queued' || reason === 'head-moved') queued += 1
  }
  let stale = 0
  const requests = typeof r['requests'] === 'object' && r['requests'] !== null ? Object.values(r['requests'] as Record<string, unknown>) : []
  for (const req of requests) {
    const status = (req as Record<string, unknown> | null)?.['status']
    if (status === 'queued') queued += 1
    else if (status === 'claimed') {
      // An unreadable claim time cannot be proven fresh.
      const claimed = dateOf((req as Record<string, unknown>)['claimedAt'])
      if (claimed !== null && now - claimed <= STALE_CLAIM_MS) continue
      stale += 1
    }
  }
  return queued + stale > 0 ? { actionable: true, reason: 'pending', queued, staleClaims: stale } : { actionable: false, reason: 'nothing', queued: 0, staleClaims: 0 }
}

// Chat triggers

export interface ChatTrigger {
  automationId: string
  link?: string
  eventKey: string
}

/**
 * The runs new chat messages fire: a top-level message from someone else, in a channel the
 * automation listens to, with a PR link (of its owner when one is set). Each event is claimed in
 * the ledger first, so one event fires at most one run, whichever automation, profile or
 * account sees it again (the first automation in order wins).
 */
export function chatTriggers(
  automations: readonly AutomationDefinition[],
  messages: readonly ChatMessage[],
  ledger: EventLedger,
  opts: { me: string; now: number; isActive?: (a: AutomationDefinition) => boolean }
): { ledger: EventLedger; triggers: ChatTrigger[] } {
  let next = ledger
  const triggers: ChatTrigger[] = []
  const ordered = [...messages].sort((a, b) => tsToMs(a.ts) - tsToMs(b.ts))
  for (const m of ordered) {
    if (isReply(m) || isMe(m.user, opts.me)) continue
    const key = chatEventKey(m.channelId, m.ts, m.threadTs)
    for (const a of automations) {
      if (!a.enabled || (opts.isActive && !opts.isActive(a)) || !a.triggers.chatChannelIds.includes(m.channelId)) continue
      const owner = a.triggers.prOwner.trim().toLowerCase()
      if (!m.prUrls.some((u) => !owner || pullRequestOwner(u) === owner)) continue
      const claim = claimEvent(next, key, a.id, opts.now)
      next = claim.ledger
      if (claim.claimed) triggers.push({ automationId: a.id, eventKey: key, ...(m.permalink ? { link: m.permalink } : {}) })
      break
    }
  }
  return { ledger: next, triggers }
}
