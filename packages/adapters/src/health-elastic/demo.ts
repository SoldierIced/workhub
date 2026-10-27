import { DEFAULT_HEALTH_THRESHOLDS, emptySignals, trendStats, type ConnectionTest, type HealthEnvironment, type HealthProvider, type HealthSettings, type HealthSignals, type HealthTier, type K8sEvent, type PodIssue, type ServiceErrorCount, type SlowTransaction } from '@workhub/core'

/**
 * Synthetic health data for screenshots, demos and tests (WORKHUB_DEMO_HEALTH=1). Everything here
 * is made up: no real cluster, service, host or company. It plays the part of a provider, so the
 * screens, verdicts and Investigate prompt run on the same code as with a real cluster.
 */

const env = (id: string, name: string, apmEnvironments: string[], hasKubeState: boolean): HealthEnvironment => ({
  id,
  name,
  apmEnvironments,
  k8sIndexSuffix: hasKubeState ? id : '',
  hasKubeState,
  apm: { errors: 'logs-apm.error-*', traces: 'traces-apm-*', metrics: 'metrics-apm.internal-*' },
  kibanaUrl: 'https://kibana.example.test',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS }
})

/** The environments the demo shows when the profile has none configured. */
export const DEMO_HEALTH_SETTINGS: HealthSettings = {
  refreshMinutes: 15,
  environments: [env('production', 'Production', ['production', 'prod'], true), env('staging', 'Staging', ['staging'], false), env('develop', 'Develop', ['develop', 'dev'], true)]
}

const series = (recent: number, days: number[]) => trendStats(days, recent)!
const err = (service: string, recent: number, days: number[]): ServiceErrorCount => ({ service, stats: series(recent, days) })
const pod = (name: string, over: Partial<PodIssue>): PodIssue => ({ pod: name, notReady: false, restarts: 0, recentRestarts: 0, backOff: false, kind: 'restarting', ...over })
const tx = (service: string, name: string, calls: number, p50: number, p95: number, p99: number, failure: number): SlowTransaction => ({ service, name, type: 'request', calls, p50Ms: p50, p95Ms: p95, p99Ms: p99, failureRate: failure })

function eventsFor(now: number): K8sEvent[] {
  return [
    { reason: 'BackOff', stats: series(46, [0, 0, 0, 4, 12, 46]), message: 'Back-off restarting failed container', object: 'notifier-worker-7d9f6b5c4-x2k8p', objectKind: 'Pod', lastSeen: now - 2 * 60_000 },
    { reason: 'FailedScheduling', stats: series(3, [1, 2, 1, 2, 1, 2, 3, 3]), message: '0/6 nodes are available: insufficient memory', object: 'report-batch-28465', objectKind: 'Pod', lastSeen: now - 41 * 60_000 }
  ]
}

function signalsFor(id: string, now: number): Partial<HealthSignals> {
  const reporting = (extra: { service: string; silent: number }[] = []) =>
    [...['checkout-api', 'catalog-service', 'search-gateway', 'notifier-worker'].map((service) => ({ service, silent: 0 })), ...extra].map(({ service, silent }) => ({
      service,
      lastSeen: now - silent * 60_000,
      silentMinutes: silent,
      isReporting: silent <= 10
    }))
  const slow = [
    tx('checkout-api', 'POST /orders', 1840, 210, 2310, 4120, 0.031),
    tx('search-gateway', 'GET /search', 9120, 140, 1450, 2890, 0.004),
    tx('catalog-service', 'GET /products/{id}', 6400, 60, 780, 1320, 0.002),
    tx('notifier-worker', 'job notify.send', 920, 90, 540, 990, 0.012)
  ]
  if (id === 'production') {
    return { podVisibility: 'visible', notReady: [], restarts: [], backOff: [], reporting: reporting(), errors: [err('checkout-api', 38, [30, 28, 35, 33, 31, 29, 30, 36, 34, 32, 31, 30, 33, 38]), err('catalog-service', 6, [4, 5, 4, 6, 5, 4, 5, 6, 5, 4, 6, 5, 4, 6])], events: [], slow, failures: {} }
  }
  if (id === 'staging') {
    // No kube-state metrics: the verdict can only be blind, never healthy.
    return { podVisibility: 'notExpected', reporting: reporting([{ service: 'report-batch', silent: 95 }]), errors: [err('checkout-api', 4, [0, 0, 0, 1, 0, 2, 4])], events: [], slow: slow.slice(0, 2), failures: {} }
  }
  return {
    podVisibility: 'visible',
    notReady: [pod('catalog-service-6c8b7d9f5-m4q2z', { notReady: true })],
    restarts: [pod('notifier-worker-7d9f6b5c4-x2k8p', { restarts: 14, recentRestarts: 6 })],
    backOff: [pod('notifier-worker-7d9f6b5c4-x2k8p', { backOff: true })],
    reporting: reporting(),
    errors: [err('notifier-worker', 212, [0, 0, 0, 0, 3, 40, 212]), err('checkout-api', 120, [20, 25, 22, 24, 21, 50, 120]), err('search-gateway', 41, [38, 40, 39, 41, 40, 42, 41, 38, 40, 41, 39, 40, 41, 40])],
    events: eventsFor(now),
    slow,
    failures: {}
  }
}

/** A provider that answers from the synthetic data above; nothing leaves the machine. */
export class DemoHealthProvider implements HealthProvider {
  readonly provider = 'demo'

  async test(): Promise<ConnectionTest> {
    return { ok: true, account: 'demo cluster (synthetic data)' }
  }

  async read(env: HealthEnvironment, _tiers: readonly HealthTier[], now: number): Promise<Partial<HealthSignals>> {
    return { ...emptySignals(), ...signalsFor(env.id, now) }
  }
}
