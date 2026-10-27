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
  /** Switches per folder path (keys are entries of `folders`). */
  folderOptions?: Record<string, FolderOptions>
  /** An icon name for the profile (a Lucide icon id from the picker). */
  symbol?: string
  /** The browser that opens this profile's GitHub and Jira links (an app name on macOS, a command elsewhere); unset: the default browser. */
  linkBrowser?: string
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
}

/** A valid name for a session environment variable. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Per-folder switches of a profile (Workhub 1's "Only git repos" and "Each subfolder is its own project"). */
export interface FolderOptions {
  onlyGitRepos?: boolean
  subfoldersAreProjects?: boolean
}

/** Where the value of a profile's environment variable is kept (the secret store, never the config file). */
export const profileEnvRef = (profileId: string, name: string): string => `profile-env:${profileId}:${name}`
