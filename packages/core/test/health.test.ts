import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEALTH_THRESHOLDS,
  dueTiers,
  emptySignals,
  HealthConnectionError,
  investigateSlowEndpointPrompt,
  makeSnapshot,
  mergePods,
  mergeSignals,
  median,
  parseConfig,
  refreshEnvironment,
  SLOW_CACHE_MS,
  TREND_CACHE_MS,
  trendStats,
  type HealthEnvironment,
  type HealthProvider,
  type HealthSignals,
  type HealthTier
} from '../src'

const env = (over: Partial<HealthEnvironment> = {}): HealthEnvironment => ({
  id: 'dev',
  name: 'Develop',
  apmEnvironments: ['dev'],
  k8sIndexSuffix: 'dev',
  hasKubeState: true,
  apm: { errors: 'errors-*', traces: 'traces-*', metrics: 'metrics-*' },
  kibanaUrl: '',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS },
  ...over
})

const stats = (state: 'new' | 'worsening' | 'ongoing' | 'chronic', recent: number) => ({ recent, typicalDay: 1, streakDays: 1, streakTruncated: false, daysWithData: 14, state })
const quiet = (): HealthSignals => ({ ...emptySignals(), podVisibility: 'visible', fastFetchedAt: 1, trendFetchedAt: 1, slowFetchedAt: 1 })
const pod = (name: string, over: Record<string, unknown> = {}) => ({ pod: name, notReady: false, restarts: 0, recentRestarts: 0, backOff: false, kind: 'restarting' as const, ...over })

describe('trendStats', () => {
  it('drops a key with nothing in the rolling window', () => {
    expect(trendStats([5, 5, 0], 0)).toBeNull()
  })
  it('calls a key active for one day new', () => {
    expect(trendStats([0, 0, 0, 40], 40)?.state).toBe('new')
  })
  it('calls a rolling count over twice the typical day worsening', () => {
    // typical day = median of 10, 10, 10 = 10; recent 25 > 20
    expect(trendStats([10, 10, 10, 12], 25)?.state).toBe('worsening')
  })
  it('calls a week of activity chronic and a shorter run ongoing', () => {
    expect(trendStats([5, 5, 5, 5, 5, 5, 5, 5], 6)?.state).toBe('chronic')
    expect(trendStats([0, 0, 5, 5, 5, 5], 6)?.state).toBe('ongoing')
  })
  it('marks a streak that reaches the start of the history as truncated', () => {
    expect(trendStats([3, 3, 3], 3)?.streakTruncated).toBe(true)
    expect(trendStats([0, 3, 3], 3)?.streakTruncated).toBe(false)
  })
  it('takes the upper median', () => {
    expect(median([4, 1, 3, 2])).toBe(3)
    expect(median([])).toBe(0)
  })
})

describe('mergePods', () => {
  it('flags not ready pods, back-off and restarts inside the window, worst first', () => {
    const pods = mergePods(
      {
        notReady: [pod('web-1', { notReady: true })],
        restarts: [pod('api-1', { restarts: 9, recentRestarts: 4 }), pod('job-1', { restarts: 2, recentRestarts: 1 })],
        backOff: [pod('api-1', { backOff: true })]
      },
      3
    )
    expect(pods.map((p) => [p.pod, p.kind])).toEqual([
      ['api-1', 'crashLoop'],
      ['web-1', 'notReady']
    ])
  })
  it('lists a restarting pod only from the restart threshold', () => {
    const signals = { notReady: [], restarts: [pod('a', { recentRestarts: 3 }), pod('b', { recentRestarts: 2 })], backOff: [] }
    expect(mergePods(signals, 3).map((p) => p.pod)).toEqual(['a'])
  })
})

describe('makeSnapshot', () => {
  it('is healthy only when everything was read and is quiet', () => {
    expect(makeSnapshot(env(), quiet()).state).toBe('healthy')
  })
  it('is blind, never healthy, without Kubernetes metrics', () => {
    const s = makeSnapshot(env(), { ...quiet(), podVisibility: 'missing' })
    expect(s.state).toBe('blind')
    expect(s.blindSpots.map((b) => b.code)).toEqual(['noPodMetrics'])
  })
  it('is blind when a signal could not be read, with the reason', () => {
    const s = makeSnapshot(env(), { ...quiet(), failures: { slow: 'timed out' } })
    expect(s.state).toBe('blind')
    expect(s.blindSpots[0]).toEqual({ code: 'unread', signal: 'slow', detail: 'timed out' })
  })
  it('is blind without service.environment values or an errors index', () => {
    expect(makeSnapshot(env({ apmEnvironments: [' '] }), quiet()).blindSpots.map((b) => b.code)).toEqual(['apmOff'])
    expect(makeSnapshot(env({ apm: { errors: '', traces: 't', metrics: 'm' } }), quiet()).blindSpots.map((b) => b.code)).toEqual(['errorsOff'])
  })
  it('degrades on new or worsening error signals from the threshold, not below it', () => {
    const below = makeSnapshot(env(), { ...quiet(), errors: [{ service: 'api', stats: stats('new', 9) }] })
    expect(below.state).toBe('healthy')
    const above = makeSnapshot(env(), { ...quiet(), errors: [{ service: 'api', stats: stats('new', 10) }, { service: 'web', stats: stats('worsening', 50) }] })
    expect(above.state).toBe('degraded')
    expect(above.reasons).toEqual([
      { code: 'errorsNew', count: 1 },
      { code: 'errorsWorsening', count: 1 }
    ])
  })
  it('lists chronic errors but never degrades on them', () => {
    const s = makeSnapshot(env(), { ...quiet(), errors: [{ service: 'api', stats: stats('chronic', 5000) }] })
    expect(s.state).toBe('healthy')
    expect(s.errorServices).toHaveLength(1)
  })
  it('orders error services new first, chronic last, then by count', () => {
    const s = makeSnapshot(env(), {
      ...quiet(),
      errors: [
        { service: 'c', stats: stats('chronic', 900) },
        { service: 'o', stats: stats('ongoing', 50) },
        { service: 'n1', stats: stats('new', 5) },
        { service: 'n2', stats: stats('new', 20) }
      ]
    })
    expect(s.errorServices.map((e) => e.service)).toEqual(['n2', 'n1', 'o', 'c'])
  })
  it('degrades on a silent service only when the threshold says so', () => {
    const reporting = [{ service: 'api', lastSeen: 0, silentMinutes: 90, isReporting: false }]
    expect(makeSnapshot(env(), { ...quiet(), reporting }).state).toBe('healthy')
    const strict = env({ thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, silentServicesDegrade: true } })
    expect(makeSnapshot(strict, { ...quiet(), reporting }).state).toBe('degraded')
    expect(makeSnapshot(env(), { ...quiet(), reporting }).reasons).toEqual([{ code: 'servicesSilent', count: 1 }])
  })
})

class FakeProvider implements HealthProvider {
  readonly provider = 'fake'
  calls: HealthTier[][] = []
  constructor(private readonly behave: (tiers: readonly HealthTier[]) => Partial<HealthSignals>) {}
  async test() {
    return { ok: true as const, account: 'fake' }
  }
  async read(_env: HealthEnvironment, tiers: readonly HealthTier[]) {
    this.calls.push([...tiers])
    return this.behave(tiers)
  }
}

describe('refresh tiers', () => {
  it('reads every tier the first time and only the fast one while the caches are fresh', () => {
    expect(dueTiers(undefined, 1000)).toEqual(['fast', 'trend', 'slow'])
    const fresh = { trendFetchedAt: 1000, slowFetchedAt: 1000 }
    expect(dueTiers(fresh, 1000 + 60_000)).toEqual(['fast'])
    expect(dueTiers(fresh, 1000 + TREND_CACHE_MS)).toEqual(['fast', 'trend'])
    expect(dueTiers(fresh, 1000 + SLOW_CACHE_MS)).toEqual(['fast', 'trend', 'slow'])
  })

  it('keeps the figures of a tier that was not read', async () => {
    const trendErrors = [{ service: 'api', stats: stats('ongoing', 30) }]
    const provider = new FakeProvider((tiers) => (tiers.includes('trend') ? { errors: trendErrors, podVisibility: 'visible' } : { podVisibility: 'visible' }))
    const first = await refreshEnvironment(provider, env(), undefined, 1_000)
    expect(first.snapshot.errorServices).toHaveLength(1)
    const second = await refreshEnvironment(provider, env(), first, 1_000 + 5 * 60_000)
    expect(provider.calls[1]).toEqual(['fast'])
    expect(second.snapshot.errorServices).toHaveLength(1)
    expect(second.signals?.fastFetchedAt).toBe(1_000 + 5 * 60_000)
    expect(second.signals?.trendFetchedAt).toBe(1_000)
  })

  it('keeps the last good figures when a signal fails, and shows the failure as a blind spot', async () => {
    const good = [{ service: 'api', stats: stats('ongoing', 30) }]
    let fail = false
    const provider = new FakeProvider(() => (fail ? { failures: { errors: 'HTTP 500' }, podVisibility: 'visible' } : { errors: good, podVisibility: 'visible' }))
    const first = await refreshEnvironment(provider, env(), undefined, 0)
    fail = true
    const second = await refreshEnvironment(provider, env(), first, TREND_CACHE_MS)
    expect(second.snapshot.errorServices).toEqual(good)
    expect(second.snapshot.blindSpots.some((b) => b.code === 'unread' && b.signal === 'errors')).toBe(true)
    expect(second.snapshot.state).toBe('blind')
  })

  it('clears a failure once the signal reads again', () => {
    const merged = mergeSignals({ ...emptySignals(), failures: { slow: 'x' } }, { slow: [] }, ['slow'])
    expect(merged.failures).toEqual({})
  })

  it('goes unreachable on a connection failure, keeping the old figures marked stale', async () => {
    let down = false
    const provider = new FakeProvider(() => {
      if (down) throw new HealthConnectionError('no route to host')
      return { errors: [{ service: 'api', stats: stats('ongoing', 30) }], podVisibility: 'visible' }
    })
    const first = await refreshEnvironment(provider, env(), undefined, 0)
    down = true
    const second = await refreshEnvironment(provider, env(), first, 60_000)
    expect(second.snapshot.state).toBe('unreachable')
    expect(second.snapshot.stale).toBe(true)
    expect(second.snapshot.errorMessage).toBe('no route to host')
    expect(second.snapshot.errorServices).toHaveLength(1)
    expect(second.signals).toBe(first.signals)
  })

  it('is unreachable, not stale, when nothing was ever read', async () => {
    const provider = new FakeProvider(() => {
      throw new HealthConnectionError('401')
    })
    const r = await refreshEnvironment(provider, env(), undefined, 0)
    expect(r.snapshot.state).toBe('unreachable')
    expect(r.snapshot.stale).toBe(false)
  })
})

describe('investigateSlowEndpointPrompt', () => {
  it('summarizes the endpoint and asks for analysis without changing anything', () => {
    const prompt = investigateSlowEndpointPrompt({ name: 'Develop', slowFlowHours: 24 }, { service: 'checkout', name: 'POST /orders', calls: 1200, p50Ms: 80.4, p95Ms: 2310.7, p99Ms: 4000, failureRate: 0.031 })
    expect(prompt).toContain('"POST /orders"')
    expect(prompt).toContain('"checkout"')
    expect(prompt).toContain('p95 2311 ms')
    expect(prompt).toContain('3.1% failures')
    expect(prompt).toContain('Do not change anything')
  })
})

describe('health config', () => {
  it('clamps hand-edited values instead of refusing to load', () => {
    const parsed = parseConfig({
      profiles: [{ id: 'work', name: 'Work', health: { refreshMinutes: 1, environments: [{ id: 'dev', name: 'Dev', thresholds: { errorWindowHours: 9999, restartsToFlag: 0 } }] } }]
    })
    const health = parsed.profiles[0]?.health
    expect(health?.refreshMinutes).toBe(5)
    expect(health?.environments[0]?.thresholds.errorWindowHours).toBe(168)
    expect(health?.environments[0]?.thresholds.restartsToFlag).toBe(1)
    expect(health?.environments[0]?.thresholds.minErrorsToFlag).toBe(10)
    expect(health?.environments[0]?.apm).toEqual({ errors: '', traces: '', metrics: '' })
  })
})
