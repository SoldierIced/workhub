import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HEALTH_THRESHOLDS,
  itemId,
  type FlowDetails,
  type HealthDetailRequest,
  type HealthSnapshot,
  type PodDetails,
  type ServiceErrorDetails,
  type TrendStats
} from '@workhub/core'
import type { HealthDetailResult, HealthEnvironmentView } from '../src/shared/health-api'
import { errorsPrompt, flowPrompt, podPrompt, silence, togetherPrompt } from '../src/renderer/lib/healthPrompts'
import { investigateRow, investigateTogether } from '../src/renderer/lib/healthInvestigate'
import { infraRequest, leadGroupText, noPodMetrics, shortType, verdictText, whyText } from '../src/renderer/lib/health'
import { translate, translatePlural } from '../src/renderer/i18n/translate'

const words = (locale: 'en' | 'es') => ({
  t: (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate(locale, k, p),
  tn: (b: Parameters<typeof translatePlural>[1], n: number, p?: Parameters<typeof translatePlural>[3]) => translatePlural(locale, b, n, p),
  formatNumber: (n: number) => new Intl.NumberFormat(locale).format(n)
})

const stats = (over: Partial<TrendStats> = {}): TrendStats => ({ recent: 2380, typicalDay: 26, streakDays: 3, streakTruncated: false, daysWithData: 14, state: 'worsening', ...over })

const snapshot: HealthSnapshot = {
  environmentId: 'prod',
  state: 'degraded',
  podVisibility: 'visible',
  reasons: [],
  blindSpots: [],
  errorServices: [
    { service: 'checkout-api', stats: stats() },
    { service: 'billing', stats: stats({ state: 'new', recent: 40, typicalDay: 0 }) }
  ],
  pods: [{ pod: 'checkout-api-7d9f8b6c5-x2k4q', notReady: true, restarts: 12, recentRestarts: 4, backOff: true, kind: 'crashLoop' }],
  events: [{ reason: 'FailedScheduling', stats: stats({ recent: 5 }), object: 'billing-5c4d7f9b8-abcde', objectKind: 'Pod' }],
  silentServices: [{ service: 'notifier', lastSeen: Date.UTC(2026, 9, 27, 10), silentMinutes: 180, isReporting: false }],
  reportingServiceCount: 4,
  slow: [{ service: 'checkout-api', name: 'POST /orders', calls: 900, p50Ms: 400, p95Ms: 2300, p99Ms: 4100, failureRate: 0.02 }],
  containerStderr: [],
  stale: false
}

const env: HealthEnvironmentView = {
  id: 'prod',
  name: 'Production',
  snapshot,
  kibanaUrl: 'https://kibana.example',
  serviceUrls: { 'checkout-api': 'https://kibana.example/app/apm/services/checkout-api' },
  errorUrls: { 'checkout-api': 'https://kibana.example/app/apm/services/checkout-api/errors' },
  podUrls: {},
  slowFlowHours: DEFAULT_HEALTH_THRESHOLDS.slowFlowHours,
  errorWindowHours: DEFAULT_HEALTH_THRESHOLDS.errorWindowHours,
  thresholds: DEFAULT_HEALTH_THRESHOLDS,
  hasKubeState: true,
  k8sIndexSuffix: 'prod'
}

const promptEnv = { name: env.name, thresholds: env.thresholds }

const errorDetails: ServiceErrorDetails = {
  service: 'checkout-api',
  groups: [
    {
      groupingKey: 'abc123def',
      exceptionType: 'System.NullReferenceException',
      message: 'Object reference not set',
      culprit: 'OrdersController.Create',
      endpoint: 'POST /orders',
      recent: 1930,
      total: 2100,
      activeDays: 3,
      daysWithData: 14,
      typicalDay: 20,
      isNew: false
    }
  ],
  fetchedAt: 0
} as ServiceErrorDetails

const podDetails: PodDetails = {
  pod: 'checkout-api-7d9f8b6c5-x2k4q',
  status: { container: 'checkout-api', waitingReason: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled', lastExitCode: 137 },
  events: [{ reason: 'BackOff', message: 'Back-off restarting failed container', count: 3, occurrences: 40 }],
  stderr: [{ text: 'Unhandled exception: out of memory' }],
  fetchedAt: 0
}

const flowDetails: FlowDetails = {
  service: 'checkout-api',
  name: 'POST /orders',
  sampledTransactions: 20,
  spans: [{ resource: 'postgresql', type: 'db', subtype: 'postgresql', calls: 600, totalMs: 30_000, averageMs: 50, callsPerTransaction: 30, shareOfWallTime: 0.65 }],
  comparison: {
    service: 'checkout-api',
    transaction: 'POST /orders',
    windowHours: 24,
    previous: { errors: 2, transactions: 800, failedTransactions: 4, p95Ms: 900 },
    current: { errors: 30, transactions: 900, failedTransactions: 18, p95Ms: 2300 },
    newErrorTypes: [{ groupingKey: 'k', exceptionType: 'TimeoutException', firstSeen: 0, count: 9 }]
  },
  fetchedAt: 0
} as FlowDetails

describe('Health prompts', () => {
  it('words the errors of a service with its groups and the Kibana link', () => {
    const text = errorsPrompt('en', snapshot.errorServices[0]!, { value: errorDetails }, promptEnv, env.errorUrls['checkout-api'])
    expect(text).toContain('Investigate the errors of checkout-api in Production.')
    expect(text).toContain('1. System.NullReferenceException: 1,930 errors')
    expect(text).toContain('POST /orders')
    expect(text).toContain('OrdersController.Create')
    expect(text).toContain('Kibana: https://kibana.example/app/apm/services/checkout-api/errors')
    expect(text.endsWith(translate('en', 'healthPrompt.ask'))).toBe(true)
  })
  it('says why the groups could not be read, and leaves the request out when asked to', () => {
    const text = errorsPrompt('es', snapshot.errorServices[0]!, { error: 'timeout' }, promptEnv, null, false)
    expect(text).toContain('timeout')
    expect(text).not.toContain(translate('es', 'healthPrompt.ask'))
    expect(text).not.toContain('Kibana:')
  })
  it('words a pod with its status, events and last stderr', () => {
    const text = podPrompt('en', snapshot.pods[0]!, { value: podDetails }, promptEnv, undefined)
    expect(text).toContain('Investigate the pod checkout-api-7d9f8b6c5-x2k4q of checkout-api in Production.')
    expect(text).toContain('CrashLoopBackOff')
    expect(text).toContain('OOMKilled')
    expect(text).toContain('137')
    expect(text).toContain('- BackOff')
    expect(text).toContain('    Unhandled exception: out of memory')
  })
  it('words a slow flow with its spans and the window comparison', () => {
    const text = flowPrompt('en', snapshot.slow[0]!, { value: flowDetails }, promptEnv, undefined)
    expect(text).toContain('Investigate the slow endpoint POST /orders of checkout-api in Production.')
    expect(text).toContain('postgresql')
    expect(text).toContain('65%')
    expect(text).toContain('TimeoutException')
  })
  it('combines the selected rows under numbered sections and asks once', () => {
    const s = { errors: snapshot.errorServices.slice(0, 1), silent: snapshot.silentServices, pods: snapshot.pods, events: [], flows: [] }
    const text = togetherPrompt('en', s, {
      env: promptEnv,
      profileName: 'Work',
      involved: { repositories: ['checkout-api'], unmatched: ['notifier'] },
      errors: { 'checkout-api': { value: errorDetails } },
      pods: {},
      flows: {},
      errorServices: snapshot.errorServices,
      links: { errors: {}, pods: {}, services: {} }
    })
    expect(text.startsWith('Investigate 3 signals in Production (Work).')).toBe(true)
    expect(text).toContain('Repositories involved: checkout-api.')
    expect(text).toContain('No folder of this profile is named like: notifier.')
    expect(text).toContain('## 1. checkout-api · errors')
    expect(text).toContain('## 2. notifier · stopped reporting')
    expect(text).toContain('## 3. checkout-api-7d9f8b6c5-x2k4q · pod')
    expect(text).toContain('timed out')
    expect(text).not.toContain(translate('en', 'healthPrompt.ask'))
    expect(text.endsWith(translate('en', 'healthPrompt.together.ask'))).toBe(true)
  })
  it('words a silence in minutes, hours or days', () => {
    expect(silence(45)).toBe('45 min')
    expect(silence(180)).toBe('3 h')
    expect(silence(3000)).toBe('2 d')
  })
})

type Detail = (request: HealthDetailRequest) => Promise<HealthDetailResult>

const fakeDetails: Detail = async (request) => {
  if (request.kind === 'errors') return { ok: true, value: errorDetails }
  if (request.kind === 'pod') return { ok: true, value: podDetails }
  return { ok: true, value: flowDetails }
}

const folders = ['/code/checkout-api', '/code/billing', '/code/misc']

describe('Investigate with Claude', () => {
  const deps = (details: Detail = fakeDetails, timeoutMs?: number) => ({ locale: 'en' as const, folders, profileName: 'Work', env, details, timeoutMs })

  it('reads the row details first and opens in the service repository', async () => {
    const asked: HealthDetailRequest[] = []
    const r = await investigateRow({ kind: 'errors', entry: snapshot.errorServices[0]! }, deps(async (q) => (asked.push(q), fakeDetails(q))))
    expect(asked).toEqual([{ kind: 'errors', service: 'checkout-api' }])
    expect(r.folder).toBe('/code/checkout-api')
    expect(r.draft).toContain('System.NullReferenceException')
  })
  it('maps a pod to its repository through its container', async () => {
    const r = await investigateRow({ kind: 'pod', pod: snapshot.pods[0]! }, deps())
    expect(r.folder).toBe('/code/checkout-api')
  })
  it('still writes the draft when the details fail, saying why', async () => {
    const r = await investigateRow({ kind: 'flow', tx: snapshot.slow[0]! }, deps(async () => ({ ok: false, error: 'boom' })))
    expect(r.draft).toContain('POST /orders')
    expect(r.folder).toBe('/code/checkout-api')
  })
  it('leaves the folder unset when no repository matches', async () => {
    const r = await investigateRow({ kind: 'silent', service: snapshot.silentServices[0]! }, deps())
    expect(r.folder).toBeUndefined()
  })

  it('opens one session in the shared folder when every row maps to it', async () => {
    const selection = new Set([itemId('errors', 'checkout-api'), itemId('pod', snapshot.pods[0]!.pod), itemId('flow', 'checkout-api|POST /orders')])
    const r = await investigateTogether(selection, snapshot, deps())
    expect(r?.folder).toBe('/code/checkout-api')
    expect(r?.draft).not.toContain('Repositories involved')
    expect(r?.draft).toContain('## 3. POST /orders · slow endpoint of checkout-api')
  })
  it('names the repositories involved when the rows span several', async () => {
    const selection = new Set([itemId('errors', 'checkout-api'), itemId('errors', 'billing'), itemId('silent', 'notifier')])
    const r = await investigateTogether(selection, snapshot, deps())
    expect(r?.folder).toBeUndefined()
    expect(r?.draft).toContain('Repositories involved: checkout-api, billing.')
    expect(r?.draft).toContain('No folder of this profile is named like: notifier.')
  })
  it('stops waiting for slow details and names them as timed out', async () => {
    const never: Detail = () => new Promise(() => undefined)
    const r = await investigateTogether(new Set([itemId('errors', 'checkout-api')]), snapshot, deps(never, 20))
    expect(r?.draft).toContain('timed out')
  })
  it('does nothing without a selection', async () => {
    expect(await investigateTogether(new Set(), snapshot, deps())).toBeNull()
    expect(await investigateTogether(new Set(['errors:gone']), snapshot, deps())).toBeNull()
  })
})

describe('Health drill-down words', () => {
  it('explains why a signal is listed', () => {
    expect(whyText(stats(), 24, words('en'))).toContain('2,380')
    expect(whyText(stats({ state: 'new', daysWithData: 1 }), 24, words('es'))).toContain('2380')
    expect(whyText(stats({ state: 'chronic', typicalDay: 0 }), 24, words('en'))).toBeTruthy()
  })
  it('shortens exception types and words the lead group', () => {
    expect(shortType('System.NullReferenceException')).toBe('NullReferenceException')
    expect(shortType('Some message with spaces')).toBe('Some message with spaces')
    expect(leadGroupText(errorDetails.groups, 2380, words('en'))).toContain('81%')
    expect(leadGroupText([], 10, words('en'))).toBeNull()
  })
  it('asks infra for the pod metrics, naming the streams when there is a suffix', () => {
    const text = infraRequest({ name: 'Production', k8sIndexSuffix: 'prod' }, words('en').t)
    expect(text).toContain('Production')
    expect(text).toContain('prod')
    expect(infraRequest({ name: 'Production', k8sIndexSuffix: '' }, words('en').t).length).toBeLessThan(text.length)
  })
  it('tells why the pods card is empty and when infra can help', () => {
    expect(noPodMetrics({ hasKubeState: false, k8sIndexSuffix: 'x' }, 'visible').askInfra).toBe(true)
    expect(noPodMetrics({ hasKubeState: true, k8sIndexSuffix: 'x' }, 'missing').title).toBe('health.pods.missing.title')
    expect(noPodMetrics({ hasKubeState: true, k8sIndexSuffix: '' }, 'notExpected').askInfra).toBe(false)
  })
  it('words the window verdict', () => {
    expect(verdictText({ kind: 'clean' }, words('en'))).toBe(translate('en', 'health.slow.verdict.clean'))
    const regressed = verdictText({ kind: 'regressed', reasons: [{ code: 'latency', before: 900, after: 2300 }, { code: 'newErrorTypes', count: 2 }] }, words('en'))
    expect(regressed).toContain('900 ms')
    expect(regressed).toContain('2.3 s')
  })
})
