/**
 * Health notifications, as Workhub 1 sends them: what changed in an environment since its last
 * read. The first read of an environment has nothing to compare with and alerts nothing.
 */
import type { HealthState } from '../health/types'

export interface HealthReadout {
  id: string
  name: string
  state: HealthState
}

export type HealthAlertKind = 'degraded' | 'recovered' | 'unreachable'

export interface HealthAlert {
  environmentId: string
  environmentName: string
  kind: HealthAlertKind
}

/** The state each environment is compared with next time. */
export type HealthBaseline = Record<string, HealthState>

/**
 * Alerts between two reads, and the baseline for the next one. Blind is not recovery: an
 * environment that was degraded and now cannot be fully read stays degraded for the comparison,
 * so finding the same pods down on the next read is not a new incident.
 */
export function healthAlerts(baseline: HealthBaseline | undefined, readouts: readonly HealthReadout[]): { alerts: HealthAlert[]; baseline: HealthBaseline } {
  const next: HealthBaseline = {}
  const alerts: HealthAlert[] = []
  for (const env of readouts) {
    const previous = baseline?.[env.id]
    const current: HealthState = env.state === 'blind' && previous === 'degraded' ? 'degraded' : env.state
    next[env.id] = current
    if (previous === undefined || previous === current) continue
    const alert = (kind: HealthAlertKind) => alerts.push({ environmentId: env.id, environmentName: env.name, kind })
    if (current === 'degraded') alert('degraded')
    else if (current === 'unreachable') alert('unreachable')
    else if (current === 'healthy' && (previous === 'degraded' || previous === 'unreachable')) alert('recovered')
  }
  return { alerts, baseline: next }
}

/** The state the menu bar shows for a set of environments: the worst one, null when there are none. */
export function worstHealth(states: readonly HealthState[]): HealthState | null {
  const order: HealthState[] = ['unreachable', 'degraded', 'blind', 'healthy']
  for (const s of order) if (states.includes(s)) return s
  return null
}
