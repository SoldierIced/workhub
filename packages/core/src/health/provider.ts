import type { ConnectionTest } from '../tickets/types'
import type { HealthEnvironment, HealthSignals, HealthTier } from './types'

/**
 * Environment health signals of one provider (P6: Elastic APM; Sentry or Datadog later). A
 * provider is read-only: it never writes to the system it reads.
 */
export interface HealthProvider {
  readonly provider: string
  /** Checks the connection and the credentials. Never throws. */
  test(): Promise<ConnectionTest>
  /**
   * Reads the signals of the given tiers for one environment. A query that fails is reported in
   * `failures` and leaves its signal out; a failure of the whole connection throws
   * `HealthConnectionError`, so no signal is ever shown as zero when it was not read.
   */
  read(env: HealthEnvironment, tiers: readonly HealthTier[], now: number): Promise<Partial<HealthSignals>>
}
