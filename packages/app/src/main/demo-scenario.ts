import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  PRODUCT_ALERT_KEYS,
  PRODUCT_PROFILE_ID,
  PRODUCT_SCENARIO,
  PRODUCT_TRACKER_SECRET,
  localDay,
  productConnections,
  productInbox,
  productMetricState,
  productMilestoneCounts,
  productMilestones,
  productProfile,
  productTicketStates,
  type ConfigurationService
} from '@workhub/core'
import type { MetricAlertsState } from './metric-alerts'
import type { PlannerState } from './planner-service'

export const PLANNER_STATE_FILE = 'planner-state.json'
export const METRIC_ALERTS_FILE = 'metric-alerts.json'

/** The scenario `WORKHUB_DEMO_SCENARIO` selects ('team-lead'), or null for none (or an unknown name). */
export function demoScenario(env: Readonly<Record<string, string | undefined>> = process.env): typeof PRODUCT_SCENARIO | null {
  return env['WORKHUB_DEMO_SCENARIO'] === PRODUCT_SCENARIO ? PRODUCT_SCENARIO : null
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Seeds the scenario's milestones, inbox and metric alerts into the data folder, unless those
 * files exist already (a second run keeps whatever the user did). Runs before the services read
 * their state files. Returns the files it wrote.
 */
export function seedScenarioState(dataDir: string, now: number = Date.now()): string[] {
  const written: string[] = []
  const plannerPath = join(dataDir, PLANNER_STATE_FILE)
  const metricsPath = join(dataDir, METRIC_ALERTS_FILE)
  const metrics = productMetricState(now)
  if (!existsSync(metricsPath)) {
    const state: MetricAlertsState = { profiles: { [PRODUCT_PROFILE_ID]: metrics } }
    writeJson(metricsPath, state)
    written.push(metricsPath)
  }
  if (!existsSync(plannerPath)) {
    const milestones = productMilestones(localDay(now))
    // The pending bug is drafted from the front-end error alert, as "Send to inbox" would.
    const alert = metrics.alerts.find((a) => a.key === PRODUCT_ALERT_KEYS.risingError)
    const inbox = productInbox(now, alert)
    const state: PlannerState = { profiles: { [PRODUCT_PROFILE_ID]: { milestones, counts: productMilestoneCounts(milestones, now), errors: {}, inbox, proposals: [], tickets: productTicketStates(milestones, inbox, now) } } }
    writeJson(plannerPath, state)
    written.push(plannerPath)
  }
  return written
}

/**
 * Saves the scenario's profile, through the configuration service so the schema and the
 * cross-reference rules apply, when the config has no profile yet. Returns whether it seeded.
 */
export async function seedScenarioConfig(configuration: Pick<ConfigurationService, 'current' | 'saveConnection' | 'saveProfile' | 'setActiveProfile' | 'saveOptions'>, folder: string): Promise<boolean> {
  if ((await configuration.current()).profiles.length > 0) return false
  for (const connection of productConnections()) {
    const saved = await configuration.saveConnection(connection, { action: 'set', value: PRODUCT_TRACKER_SECRET })
    if (!saved.ok) throw new Error(`demo scenario: ${saved.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  }
  const profile = await configuration.saveProfile(productProfile(folder))
  if (!profile.ok) throw new Error(`demo scenario: ${profile.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  const active = await configuration.setActiveProfile(PRODUCT_PROFILE_ID)
  if (!active.ok) throw new Error(`demo scenario: ${active.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  // No first-run welcome: the profile is ready.
  await configuration.saveOptions({ welcomeDone: true })
  return true
}
