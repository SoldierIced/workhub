import {
  DEFAULT_HEALTH_THRESHOLDS,
  emptySignals,
  flowEntry,
  flowMeasures,
  matchFlowTrace,
  trendStats,
  type ConnectionTest,
  type ErrorGroup,
  type FlowDetails,
  type FlowBaseline,
  type FlowHourPoint,
  type FlowTraceLog,
  type FlowMap,
  type FlowMapReading,
  type FlowTrace,
  type FlowTraceDoc,
  type FlowTraceSort,
  type FlowTraceSummary,
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

  /** Made-up timings per measure, stable for a key: a daily rhythm with a slow hour, so the hourly charts have a shape. */
  async flowMap(_env: HealthEnvironment, map: FlowMap, now: number, hours: number): Promise<FlowMapReading> {
    const reading: FlowMapReading = { at: now, windowHours: hours, edges: {}, nodes: {}, stages: {}, errors: {} }
    const all = flowMeasures(map)
    // One part, the first with a span or the first overall, runs about 2.5x slower than its weekly baseline.
    const slowKey = (all.find((m) => m.measure.type === 'apm.span') ?? all[0])?.key
    for (const m of all) {
      const seed = [...m.key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 9973, 7)
      const base = 40 + (seed % 900)
      const start = now - hours * 3_600_000
      const hourly: FlowHourPoint[] = []
      for (let i = 0; i < hours; i++) {
        const at = start + i * 3_600_000
        const hourOfDay = new Date(at).getUTCHours()
        const traffic = 0.3 + 0.7 * Math.max(0, Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2) + 0.4)
        const spike = hourOfDay === (seed % 24) ? 2.6 : 1
        hourly.push({ at, count: Math.round(traffic * (20 + (seed % 200))), p50Ms: Math.round(base * spike), p95Ms: Math.round(base * 2.4 * spike) })
      }
      const count = hourly.reduce((s, h) => s + h.count, 0)
      const p95 = Math.round(base * 2.6)
      const failed = Math.round((count * (seed % 7)) / 100)
      const slow = slowKey === m.key
      const weeklyP95 = slow ? Math.round(p95 / 2.5) : Math.round(p95 * (0.9 + (seed % 5) / 25))
      const baseline = (factor: number, p95Ms: number): FlowBaseline => ({ count: Math.round(count * factor), p50Ms: Math.round(p95Ms / 2.6), p95Ms, errorRate: (seed % 5) / 100 })
      const codes = m.measure.type === 'apm.transaction' ? [{ code: 'HTTP 2xx', count: count - failed - Math.round(count / 50) }, { code: 'HTTP 4xx', count: Math.round(count / 50) }, ...(failed > 0 ? [{ code: 'HTTP 5xx', count: failed }] : [])].filter((c) => c.count > 0).sort((a, b) => b.count - a.count) : undefined
      reading[m.of][m.key] = {
        count,
        p50Ms: base,
        p95Ms: p95,
        p99Ms: Math.round(p95 * 1.3),
        errorRate: failed / Math.max(count, 1),
        failed,
        perMinute: Math.round((count / (hours * 60)) * 100) / 100,
        ...(codes ? { codes } : {}),
        previous: baseline(0.95, Math.round(p95 * 1.05)),
        weekly: baseline(1, weeklyP95),
        hourly
      }
    }
    return reading
  }

  /** Made-up executions: one every few minutes, a slow one now and then, a failed one in ten. */
  async flowTraces(_env: HealthEnvironment, map: FlowMap, now: number, hours: number, sort: FlowTraceSort, limit: number): Promise<FlowTraceSummary[]> {
    if (!flowEntry(map)) throw new Error('the map has no entry transaction: add an "entry" measure or a node with an apm.transaction measure')
    const all: FlowTraceSummary[] = []
    const step = Math.max(60_000, Math.round((hours * 3_600_000) / 120))
    for (let i = 0; i < 120; i++) {
      const at = now - i * step
      const seed = (i * 7919) % 9973
      all.push({ traceId: `demo-${at.toString(36)}`, at, durationMs: 300 + (seed % 1500) + (seed % 11 === 0 ? 4000 : 0), outcome: seed % 10 === 0 ? 'failure' : 'success' })
    }
    const picked = sort === 'failed' ? all.filter((t) => t.outcome === 'failure') : sort === 'slowest' ? [...all].sort((a, b) => b.durationMs - a.durationMs) : all
    return picked.slice(0, limit)
  }

  /** The execution walks the map's measured parts in order, plus one call the map does not know about. */
  async flowTrace(_env: HealthEnvironment, map: FlowMap, traceId: string): Promise<FlowTrace> {
    const at = parseInt(traceId.replace(/^demo-/, ''), 36)
    const start = Number.isFinite(at) ? at : Date.now()
    const docs: FlowTraceDoc[] = []
    let cursor = start
    const entry = flowEntry(map)
    if (entry) docs.push({ event: 'transaction', service: entry.service, name: entry.transaction, at: start, durationMs: 0, outcome: 'success' })
    for (const m of flowMeasures(map)) {
      if (m.measure.type === 'apm.transaction' && entry && m.measure.service === entry.service && m.measure.transaction === entry.transaction) continue
      const seed = [...m.key].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 9973, 7)
      const durationMs = 20 + (seed % 400)
      docs.push(m.measure.type === 'apm.transaction' ? { event: 'transaction', service: m.measure.service, name: m.measure.transaction, at: cursor, durationMs, outcome: 'success' } : { event: 'span', service: m.measure.service, name: m.measure.destination, destination: m.measure.destination, at: cursor, durationMs })
      cursor += durationMs
    }
    docs.push({ event: 'span', service: entry?.service ?? 'app', name: 'SELECT demo.orders', destination: 'postgresql', at: cursor, durationMs: 35 })
    if (docs[0]) docs[0].durationMs = cursor + 35 - start
    return matchFlowTrace(map, traceId, docs)
  }

  /** A few synthetic lines spread over the trace's span: one APM error and the rest log lines. */
  async flowTraceLogs(_env: HealthEnvironment, traceId: string, limit: number): Promise<FlowTraceLog[]> {
    const parsed = parseInt(traceId.replace(/^demo-/, ''), 36)
    const start = Number.isFinite(parsed) ? parsed : Date.now()
    const lines: FlowTraceLog[] = [
      { at: start + 20, service: 'shop-bff', level: 'info', message: 'Checkout request received', source: 'logs' },
      { at: start + 180, service: 'orders', level: 'info', message: 'Order created, publishing event', source: 'logs' },
      { at: start + 420, service: 'orders', level: 'warn', message: 'Payment provider answered slowly (retry 1 of 3)', source: 'logs' },
      { at: start + 640, service: 'orders', level: 'error', type: 'System.TimeoutException', culprit: 'Orders.Handlers.CheckoutHandler in Handle', message: 'The operation has timed out', source: 'apm.error' },
      { at: start + 700, service: 'shop-bff', level: 'warn', message: 'Falling back to the cached quote', source: 'logs' }
    ]
    return lines.slice(0, limit)
  }
}
