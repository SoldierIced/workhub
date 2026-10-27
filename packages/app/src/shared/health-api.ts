// Types of the Health bridge (window.hub.health), shared by main, preload and renderer.
import type { Connection, ConnectionTest, HealthSnapshot, SecretChange } from '@workhub/core'

/**
 * - ready: a configured provider serves the profile.
 * - demo: synthetic data (WORKHUB_DEMO_HEALTH=1), no cluster or credentials needed.
 * - moduleOff: the profile has the Health module turned off.
 * - noConnection: the profile has no health connection.
 * - incomplete: the connection lacks its URL, user or secret.
 * - noEnvironments: connected, but no environment to watch yet.
 * - unsupported: the provider has no adapter yet (Sentry).
 */
export type HealthState = 'ready' | 'demo' | 'moduleOff' | 'noConnection' | 'incomplete' | 'noEnvironments' | 'unsupported'

export interface HealthEnvironmentView {
  id: string
  name: string
  snapshot: HealthSnapshot
  /** Kibana link to the environment's services; null without a Kibana URL. */
  kibanaUrl: string | null
  /** Kibana link per service named in the snapshot. */
  serviceUrls: Record<string, string>
  /** The thresholds the verdict used, to word the numbers (window hours, minimum calls). */
  slowFlowHours: number
  errorWindowHours: number
}

export interface HealthView {
  state: HealthState
  connectionName?: string
  refreshMinutes: number
  environments: HealthEnvironmentView[]
  /** Epoch milliseconds of the last read. */
  updatedAt?: number
}

export interface HealthApi {
  /** The last read of the profile; reads again when the refresh interval passed or `force` is set (never more than every 30 s). */
  get(profileId: string | null, force?: boolean): Promise<HealthView>
  /** Checks a connection as typed in the form, before it is saved. */
  test(connection: Connection, secret: SecretChange, indexToProbe?: string): Promise<ConnectionTest>
}
