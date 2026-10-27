import { TREND_ORDER, type BlindSpot, type HealthEnvironment, type HealthReason, type HealthSignal, type HealthSignals, type HealthSnapshot, type PodIssue, type PodKind, HEALTH_SIGNALS } from './types'

const trendRank = (state: (typeof TREND_ORDER)[number]) => TREND_ORDER.indexOf(state)

export function podKind(pod: Pick<PodIssue, 'backOff' | 'recentRestarts' | 'notReady'>): PodKind {
  if (pod.backOff && pod.recentRestarts > 0) return 'crashLoop'
  if (pod.notReady) return 'notReady'
  return pod.backOff ? 'crashLoop' : 'restarting'
}

const blankPod = (pod: string): PodIssue => ({ pod, notReady: false, restarts: 0, recentRestarts: 0, backOff: false, kind: 'restarting' })

/**
 * Pods from the three pod queries, merged by name. A pod appears only if it matters: not ready,
 * backing off, or restarted at least `restartsToFlag` times inside the window. Worst first.
 */
export function mergePods(signals: Pick<HealthSignals, 'notReady' | 'restarts' | 'backOff'>, restartsToFlag: number): PodIssue[] {
  const byPod = new Map<string, PodIssue>()
  const get = (pod: string) => byPod.get(pod) ?? byPod.set(pod, blankPod(pod)).get(pod)!
  for (const issue of signals.notReady) get(issue.pod).notReady = true
  for (const issue of signals.restarts) {
    const pod = get(issue.pod)
    pod.restarts = issue.restarts
    pod.recentRestarts = issue.recentRestarts
  }
  for (const issue of signals.backOff) get(issue.pod).backOff = true
  const rank = (kind: PodKind) => (kind === 'crashLoop' ? 0 : kind === 'notReady' ? 1 : 2)
  return [...byPod.values()]
    .map((p) => ({ ...p, kind: podKind(p) }))
    .filter((p) => p.notReady || p.backOff || p.recentRestarts >= restartsToFlag)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.recentRestarts - a.recentRestarts || a.pod.localeCompare(b.pod))
}

/** New first, chronic last, then the larger count. */
export function orderErrors<T extends { stats: { state: (typeof TREND_ORDER)[number]; recent: number } }>(list: T[]): T[] {
  return [...list].sort((a, b) => trendRank(a.stats.state) - trendRank(b.stats.state) || b.stats.recent - a.stats.recent)
}

/**
 * The environment's state from what was read. Degraded when something needs attention; blind when
 * nothing does but part of the picture is missing (a healthy verdict is never claimed on a partial
 * picture); healthy otherwise. Chronic signals never degrade: they are listed, not alerted.
 */
export function makeSnapshot(env: HealthEnvironment, signals: HealthSignals): HealthSnapshot {
  const t = env.thresholds
  const pods = mergePods(signals, t.restartsToFlag)
  const errors = orderErrors(signals.errors)
  const silent = signals.reporting.filter((r) => !r.isReporting)
  const flagged = errors.filter((e) => e.stats.recent >= t.minErrorsToFlag)

  const reasons: HealthReason[] = []
  const add = (code: HealthReason['code'], count: number) => {
    if (count > 0) reasons.push({ code, count })
  }
  add('podsNotReady', pods.filter((p) => p.kind === 'notReady').length)
  add('podsCrashLooping', pods.filter((p) => p.kind === 'crashLoop').length)
  add('podsRestarting', pods.filter((p) => p.kind === 'restarting').length)
  add('errorsNew', flagged.filter((e) => e.stats.state === 'new').length)
  add('errorsWorsening', flagged.filter((e) => e.stats.state === 'worsening').length)
  const podOrErrorProblem = reasons.length > 0
  add('servicesSilent', silent.length)
  const degraded = podOrErrorProblem || (t.silentServicesDegrade && silent.length > 0)

  const blind: BlindSpot[] = []
  if (signals.podVisibility === 'missing') blind.push({ code: 'noPodMetrics' })
  else if (signals.podVisibility === 'notExpected') blind.push({ code: env.hasKubeState ? 'noKubernetesSuffix' : 'noKubeState' })
  if (env.apmEnvironments.filter((v) => v.trim()).length === 0) blind.push({ code: 'apmOff' })
  else if (!env.apm.errors.trim()) blind.push({ code: 'errorsOff' })
  for (const signal of HEALTH_SIGNALS) {
    const failure = signals.failures[signal]
    if (failure) blind.push({ code: 'unread', signal, detail: failure })
  }

  return {
    environmentId: env.id,
    state: degraded ? 'degraded' : blind.length === 0 ? 'healthy' : 'blind',
    podVisibility: signals.podVisibility,
    reasons,
    blindSpots: blind,
    errorServices: errors,
    pods,
    events: [...signals.events].sort((a, b) => trendRank(a.stats.state) - trendRank(b.stats.state) || b.stats.recent - a.stats.recent),
    silentServices: silent,
    reportingServiceCount: signals.reporting.length - silent.length,
    slow: signals.slow,
    containerStderr: signals.stderr ?? [],
    fetchedAt: signals.fastFetchedAt,
    trendFetchedAt: signals.trendFetchedAt,
    slowFetchedAt: signals.slowFetchedAt,
    stale: false
  }
}

/** An environment not read yet: blind, never healthy. */
export function pendingSnapshot(environmentId: string): HealthSnapshot {
  return {
    environmentId,
    state: 'blind',
    podVisibility: 'notExpected',
    reasons: [],
    blindSpots: [{ code: 'notReadYet' }],
    errorServices: [],
    pods: [],
    events: [],
    silentServices: [],
    reportingServiceCount: 0,
    slow: [],
    containerStderr: [],
    stale: false
  }
}

/** The previous figures marked stale under an `unreachable` verdict, or an empty one with the reason. */
export function unreachableSnapshot(environmentId: string, previous: HealthSnapshot | undefined, message: string): HealthSnapshot {
  const base = previous ?? pendingSnapshot(environmentId)
  return {
    ...base,
    state: 'unreachable',
    errorMessage: message,
    stale: previous?.fetchedAt !== undefined,
    reasons: [],
    blindSpots: [{ code: 'connection', detail: message }]
  }
}

export type { HealthSignal }
