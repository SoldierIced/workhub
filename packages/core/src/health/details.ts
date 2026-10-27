import type { PodStatus, WindowComparison, WindowRegression, WindowStats, WindowVerdict } from './types'

/**
 * Infrastructure containers (log shippers, networking, DNS, storage drivers, autoscalers, agents):
 * their stderr says nothing about the services, so the stderr card hides them unless asked.
 * Matched by name, at a dash boundary (`ebs-csi` matches `ebs-csi-node`), or by their namespace.
 */
export const SYSTEM_CONTAINERS: readonly string[] = [
  'kube-proxy',
  'filebeat',
  'metricbeat',
  'elastic-agent',
  'external-secrets',
  'coredns',
  'aws-node',
  'aws-eks-nodeagent',
  'metrics-server',
  'node-exporter',
  'cluster-autoscaler',
  'ebs-csi',
  'efs-csi',
  'ebs-plugin',
  'efs-plugin',
  'csi',
  'liveness-probe',
  'node-driver-registrar',
  'fluent-bit',
  'fluentd',
  'kube-state-metrics',
  'otel-collector',
  'opentelemetry-collector',
  'apm-server',
  'aws-load-balancer-controller',
  'cert-manager',
  'karpenter'
]

/** Namespaces that only hold infrastructure. */
export const SYSTEM_NAMESPACES: readonly string[] = ['kube-system', 'kube-public', 'kube-node-lease']

export function isSystemContainer(container: string, namespace?: string): boolean {
  const name = container.toLowerCase()
  if (SYSTEM_CONTAINERS.some((c) => name === c || name.startsWith(`${c}-`))) return true
  if (!namespace) return false
  const ns = namespace.toLowerCase()
  return SYSTEM_NAMESPACES.includes(ns) || SYSTEM_CONTAINERS.includes(ns)
}

/** The reason worth a chip: the waiting reason, else how the last run ended unless it ended normally. */
export function podStatusHeadline(status: PodStatus | undefined): string | undefined {
  if (!status) return undefined
  if (status.waitingReason) return status.waitingReason
  return status.lastTerminatedReason && status.lastTerminatedReason !== 'Completed' ? status.lastTerminatedReason : undefined
}

export const failureRate = (w: WindowStats): number => (w.transactions > 0 ? w.failedTransactions / w.transactions : 0)

/** Limits of the window verdict; the defaults are Workhub 1's, plus a latency rule for slow flows. */
export interface WindowVerdictLimits {
  minErrors: number
  errorFactor: number
  /** Percentage points the failure rate must rise. */
  failureRatePoints: number
  latencyFactor: number
  /** p95 must also rise by this many milliseconds, so 4 ms -> 9 ms is not a regression. */
  latencyMinDeltaMs: number
}

export const DEFAULT_WINDOW_LIMITS: WindowVerdictLimits = { minErrors: 5, errorFactor: 3, failureRatePoints: 2, latencyFactor: 1.5, latencyMinDeltaMs: 100 }

/**
 * Whether the current window is worse than the previous one: more errors than `max(minErrors,
 * errorFactor x before)`, a failure rate up by `failureRatePoints`, a p95 up by `latencyFactor`
 * (and `latencyMinDeltaMs`), or a new error type. With no transactions and no errors in either
 * window there is no signal, which is never called clean.
 */
export function windowVerdict(c: WindowComparison, limits: WindowVerdictLimits = DEFAULT_WINDOW_LIMITS): WindowVerdict {
  const { previous: before, current: after } = c
  if (before.errors + after.errors + before.transactions + after.transactions === 0) return { kind: 'noSignal' }
  const reasons: WindowRegression[] = []
  if (after.errors > Math.max(limits.minErrors, limits.errorFactor * before.errors)) reasons.push({ code: 'errors', before: before.errors, after: after.errors })
  if ((failureRate(after) - failureRate(before)) * 100 >= limits.failureRatePoints && after.failedTransactions > 0) {
    reasons.push({ code: 'failureRate', before: failureRate(before), after: failureRate(after) })
  }
  if (before.p95Ms !== undefined && after.p95Ms !== undefined && after.p95Ms >= before.p95Ms * limits.latencyFactor && after.p95Ms - before.p95Ms >= limits.latencyMinDeltaMs) {
    reasons.push({ code: 'latency', before: before.p95Ms, after: after.p95Ms })
  }
  if (c.newErrorTypes.length > 0) reasons.push({ code: 'newErrorTypes', count: c.newErrorTypes.length })
  return reasons.length === 0 ? { kind: 'clean' } : { kind: 'regressed', reasons }
}
