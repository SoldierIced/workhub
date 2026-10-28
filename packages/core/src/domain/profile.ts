import type { AiReviewSettings } from '../ai-review/types'
import type { HealthSettings } from '../health/types'
import type { ConnectionKind } from './connection'

/** Optional modules (PLAN section 4): each one adds its screens only when enabled in a profile. */
export const OPTIONAL_MODULES = ['flows', 'health', 'chatWatcher', 'automations'] as const
export type OptionalModule = (typeof OPTIONAL_MODULES)[number]
export type ModuleToggles = Record<OptionalModule, boolean>

/**
 * Modules no longer offered: Flows was dropped. Its toggle is still read from older configs (and
 * kept when they are saved again) but no screen, nav item or setting shows it.
 */
export const RETIRED_MODULES = ['flows'] as const satisfies readonly OptionalModule[]
export type OfferedModule = Exclude<OptionalModule, (typeof RETIRED_MODULES)[number]>
/** The optional modules a profile can turn on today (Settings → Profiles → Modules). */
export const OFFERED_MODULES: readonly OfferedModule[] = OPTIONAL_MODULES.filter((m): m is OfferedModule => !(RETIRED_MODULES as readonly string[]).includes(m))

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
  /**
   * Where "New session" starts without asking (one of `folders` or any other folder). Unset: the
   * first of `folders` (see `profileDefaultFolder`).
   */
  defaultFolder?: string
  /** Switches per folder path (keys are entries of `folders`). */
  folderOptions?: Record<string, FolderOptions>
  /** An icon name for the profile (a Lucide icon id from the picker). */
  symbol?: string
  /** The browser that opens this profile's GitHub and Jira links (an app name on macOS, a command elsewhere); unset: the default browser. */
  linkBrowser?: string
  /** A Chrome profile directory (`Default`, `Profile 1`): links open in a new Chrome (`linkBrowser`, else Google Chrome) on that profile. macOS only. */
  linkChromeProfile?: string
  /** Also owns every folder outside all profiles' folders (at most one profile at a time). */
  ownsOutside?: boolean
  /** Names of the environment variables added to this profile's sessions; the values live in the secret store (`profileEnvRef`). */
  envNames?: string[]
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

/**
 * The colour that marks an agent account in the sidebar, by its place among the same agent's
 * accounts: blue for the first and purple for the second, as Workhub 1 marked its Personal and Work
 * accounts, then the rest of the palette. None for a session without an account, or one deleted.
 */
export function accountColor(accounts: readonly { id: string; agentId: string }[], accountId: string | null | undefined): string | undefined {
  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined
  if (!account) return undefined
  return automaticProfileColor(accounts.filter((a) => a.agentId === account.agentId).indexOf(account))
}

/** A Chrome profile directory name (`Default`, `Profile 1`); keeps odd text out of the command line. */
export const CHROME_PROFILE_DIR = /^\w[\w .-]{0,99}$/

/** A valid name for a session environment variable. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Per-folder switches of a profile (Workhub 1's "Only git repos" and "Each subfolder is its own project"). */
export interface FolderOptions {
  onlyGitRepos?: boolean
  subfoldersAreProjects?: boolean
}

/** Where the value of a profile's environment variable is kept (the secret store, never the config file). */
export const profileEnvRef = (profileId: string, name: string): string => `profile-env:${profileId}:${name}`
