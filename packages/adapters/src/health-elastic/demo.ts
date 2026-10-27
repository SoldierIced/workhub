import {
  DEFAULT_HEALTH_THRESHOLDS,
  emptySignals,
  trendStats,
  type ConnectionTest,
  type ErrorGroup,
  type FlowDetails,
  type HealthEnvironment,
  type HealthProvider,
  type HealthSettings,
  type HealthSignals,
  type HealthTier,
  type K8sEvent,
  type PodDetails,
  type PodIssue,
  type ServiceErrorCount,
  type ServiceErrorDetails,
  type SignalTrend,
  type SlowTransaction
} from '@workhub/core'

/**
 * Synthetic health data for screenshots, demos and tests (WORKHUB_DEMO_HEALTH=1). Everything here
 * is made up: no real cluster, service, host or company. It plays the part of a provider, so the
 * screens, verdicts and Investigate prompt run on the same code as with a real cluster.
 */

const env = (id: string, name: string, apmEnvironments: string[], hasKubeState: boolean, k8sIndexSuffix = hasKubeState ? id : ''): HealthEnvironment => ({
  id,
  name,
  apmEnvironments,
  k8sIndexSuffix,
  hasKubeState,
  apm: { errors: 'logs-apm.error-*', traces: 'traces-apm-*', metrics: 'metrics-apm.internal-*' },
  kibanaUrl: 'https://kibana.example.test',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS }
})

/** The environments the demo shows when the profile has none configured. */
export const DEMO_HEALTH_SETTINGS: HealthSettings = {
  refreshMinutes: 15,
  environments: [env('production', 'Production', ['production', 'prod'], true), env('staging', 'Staging', ['staging'], false, 'staging'), env('develop', 'Develop', ['develop', 'dev'], true)]
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

function stderrTrends(): SignalTrend[] {
  return [
    { key: 'checkout-api', namespace: 'shop', stats: series(310, [40, 52, 45, 48, 50, 47, 310]) },
    { key: 'report-batch', namespace: 'jobs', stats: series(22, [18, 25, 20, 22, 19, 24, 22]) },
    { key: 'fluent-bit', namespace: 'logging', stats: series(1200, [1100, 1180, 1220, 1190, 1210, 1170, 1200]) },
    { key: 'coredns', namespace: 'kube-system', stats: series(85, [80, 90, 84, 88, 82, 86, 85]) }
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
    // No kube-state metrics: the verdict can only be blind, never healthy; container stderr stands in.
    return { podVisibility: 'notExpected', reporting: reporting([{ service: 'report-batch', silent: 95 }]), errors: [err('checkout-api', 4, [0, 0, 0, 1, 0, 2, 4])], events: [], stderr: stderrTrends(), slow: slow.slice(0, 2), failures: {} }
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

  async errorDetails(env: HealthEnvironment, service: string, now: number): Promise<ServiceErrorDetails> {
    const hour = 3_600_000
    const group = (groupingKey: string, over: Partial<ErrorGroup>): ErrorGroup => ({ groupingKey, recent: 0, total: 0, activeDays: 1, daysWithData: 7, typicalDay: 0, isNew: false, ...over })
    const groups: ErrorGroup[] = [
      group(`${service}-g1`, {
        exceptionType: 'System.NullReferenceException',
        message: 'Object reference not set to an instance of an object.',
        culprit: `${service}.Handlers.OrderHandler in Handle`,
        endpoint: 'POST /orders',
        recent: 160,
        total: 160,
        firstSeen: now - 5 * hour,
        lastSeen: now - 2 * 60_000,
        isNew: true
      }),
      group(`${service}-g2`, {
        exceptionType: 'TimeoutException',
        message: 'The operation has timed out after 30000 ms (inventory)',
        culprit: `${service}.Clients.InventoryClient in Reserve`,
        endpoint: 'POST /orders',
        recent: 40,
        total: 220,
        firstSeen: now - 6 * 24 * hour,
        lastSeen: now - 20 * 60_000,
        activeDays: 6,
        typicalDay: 30
      })
    ]
    return { service, groups: env.id === 'staging' ? groups.slice(1) : groups, fetchedAt: now }
  }

  async podDetails(_env: HealthEnvironment, pod: string, now: number): Promise<PodDetails> {
    const crash = pod.startsWith('notifier-worker')
    return {
      pod,
      status: crash
        ? { container: 'notifier-worker', namespace: 'shop', waitingReason: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled', lastExitCode: 137, lastTerminatedAt: now - 4 * 60_000 }
        : { container: pod.split('-').slice(0, 2).join('-'), namespace: 'shop' },
      events: crash
        ? [
            { reason: 'BackOff', message: 'Back-off restarting failed container notifier-worker', lastSeen: now - 2 * 60_000, count: 46, occurrences: 212 },
            { reason: 'OOMKilling', message: 'Memory cgroup out of memory: killed process 1 (node)', lastSeen: now - 4 * 60_000, count: 6 }
          ]
        : [{ reason: 'Unhealthy', message: 'Readiness probe failed: HTTP probe failed with statuscode: 503', lastSeen: now - 60_000, count: 12, occurrences: 30 }],
      stderr: crash
        ? [
            { timestamp: now - 5 * 60_000, text: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' },
            { timestamp: now - 5 * 60_000, text: ' 1: 0xb7a940 node::Abort() [node]' }
          ]
        : [{ timestamp: now - 90_000, text: 'warn: database pool exhausted, waiting for a connection (30 s)' }],
      fetchedAt: now
    }
  }

  async flowDetails(env: HealthEnvironment, service: string, name: string, now: number): Promise<FlowDetails> {
    const hours = env.thresholds.slowFlowHours
    return {
      service,
      name,
      sampledTransactions: 100,
      sampledWallMs: 412_000,
      spans: [
        { resource: 'postgresql', type: 'db', subtype: 'postgresql', calls: 2400, totalMs: 288_000, averageMs: 120, callsPerTransaction: 24, shareOfWallTime: 0.7 },
        { resource: 'inventory:8080', type: 'external', subtype: 'http', calls: 100, totalMs: 82_000, averageMs: 820, callsPerTransaction: 1, shareOfWallTime: 0.2 },
        { resource: 'redis', type: 'db', subtype: 'redis', calls: 300, totalMs: 1_800, averageMs: 6, callsPerTransaction: 3, shareOfWallTime: 0.004 }
      ],
      comparison: {
        service,
        transaction: name,
        windowHours: hours,
        previous: { errors: 30, transactions: 1700, failedTransactions: 20, p95Ms: 1300 },
        current: { errors: 120, transactions: 1840, failedTransactions: 57, p95Ms: 2310 },
        newErrorTypes: [{ groupingKey: `${service}-g1`, exceptionType: 'System.NullReferenceException', culprit: `${service}.Handlers.OrderHandler in Handle`, firstSeen: now - 5 * 3_600_000, count: 160 }]
      },
      fetchedAt: now
    }
  }
}
