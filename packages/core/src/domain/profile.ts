import type { AiReviewSettings } from '../ai-review/types'
import type { HealthSettings } from '../health/types'
import type { ConnectionKind } from './connection'

/** Optional modules (PLAN section 4): each one adds its screens only when enabled in a profile. */
export const OPTIONAL_MODULES = ['flows', 'health', 'chatWatcher', 'automations'] as const
export type OptionalModule = (typeof OPTIONAL_MODULES)[number]
export type ModuleToggles = Record<OptionalModule, boolean>

export const NO_MODULES: ModuleToggles = { flows: false, health: false, chatWatcher: false, automations: false }

/**
 * A work context: which connection serves each kind, which agent accounts it uses and which
 * optional modules are on.
 */
export interface Profile {
  id: string
  name: string
  /** At most one connection id per kind. */
  connections: Partial<Record<ConnectionKind, string>>
  /** Agent account ids bound to this profile (any number, any agents). */
  accountIds: string[]
  /**
   * Agent ids offered in this profile. Undefined means every known agent; an empty list means
   * only agents that have a bound account.
   */
  agentIds?: string[]
  /**
   * The user's order of preference among the agents this profile offers, as `EffectiveAgent.key`
   * (`claude` or `claude:<accountId>`). Automatic choices (open a session from a pull request or
   * ticket, the default of a new session) take the first one that fits. Empty: Claude first.
   */
  preferredAgents?: string[]
  modules: ModuleToggles
  /** Folders the profile works in (Workhub 1's profile folders): new sessions and history group by them. */
  folders?: string[]
  /** Health module setup: environments to watch and the refresh interval (the cluster is the profile's `health` connection). */
  health?: HealthSettings
  /** Tracked Slack threads quiet for this many minutes are shown archived (default 15; see `threadArchiveMinutes`). */
  slackArchiveMinutes?: number
  /** AI review before a pull request (see `aiReviewSettings` for the defaults). */
  aiReview?: AiReviewSettings
  /** What happens when a Claude account runs out of usage (see `failoverMode`; default `ask`). */
  accountFailover?: 'ask' | 'automatic' | 'off'
  /** The profile's colour (`#rrggbb`), down the left edge of its sessions in the sidebar. Unset: `profileColor` picks one. */
  color?: string
}

/** Colours a profile without one of its own takes, by its place in the list (Workhub 1's accent palette). */
export const PROFILE_COLORS = ['#3b82f6', '#a855f7', '#f97316', '#10b981', '#ec4899', '#eab308', '#06b6d4', '#ef4444'] as const

/** The colour a profile without one of its own takes at this place in the list. */
export function automaticProfileColor(index: number): string {
  return PROFILE_COLORS[Math.max(0, index) % PROFILE_COLORS.length]!
}

/** A profile's colour: its own, else the palette colour of its place among the profiles. */
export function profileColor(profiles: readonly Pick<Profile, 'id' | 'color'>[], profileId: string | null | undefined): string | undefined {
  if (!profileId) return undefined
  const index = profiles.findIndex((p) => p.id === profileId)
  if (index < 0) return undefined
  return profiles[index]!.color ?? automaticProfileColor(index)
}
