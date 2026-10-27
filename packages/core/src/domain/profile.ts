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
  modules: ModuleToggles
}
