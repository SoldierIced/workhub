// Types of the metric alerts bridge (window.hub.metricAlerts), shared by main, preload and renderer.
import type { MetricAlert, MetricAlertAction } from '@workhub/core'

export type { MetricAlert, MetricAlertAction }

/** The alerts of one profile, highest severity first. */
export interface MetricAlertsView {
  /** The profile has the Health module on (the engine runs for it). */
  enabled: boolean
  /** Synthetic data (WORKHUB_DEMO_HEALTH=1): nothing is announced. */
  demo: boolean
  alerts: MetricAlert[]
  /** Epoch ms of the last evaluation. */
  updatedAt?: number
}

export interface MetricAlertsApi {
  list(profileId: string): Promise<MetricAlertsView>
  /** Track, resolve, snooze (7 days, 30 days or until the trend changes) or reopen one alert. */
  setStatus(profileId: string, key: string, action: MetricAlertAction): Promise<MetricAlertsView>
  /** Collects and evaluates the profile now. */
  refresh(profileId: string): Promise<MetricAlertsView>
  /** The alerts of a profile changed (an evaluation or an action in another window). */
  onChanged(cb: (profileId: string) => void): () => void
  /** A metric alert notification was clicked: the Health screen shows its Alerts tab. */
  onOpen(cb: (profileId: string) => void): () => void
}
