import type { ConnectionTest } from '../tickets/types'
import type { FlowMap, FlowMapReading, FlowTrace, FlowTraceLog, FlowTraceSort, FlowTraceSummary } from './flow-map'
import type { FlowDetails, HealthEnvironment, HealthSignals, HealthTier, PodDetails, ServiceErrorDetails } from './types'

/**
 * Environment health signals of one provider (P6: Elastic APM; Sentry or Datadog later). A
 * provider is read-only: it never writes to the system it reads.
 */
export interface HealthProvider {
  readonly provider: string
  /** Checks the connection and the credentials. Never throws. */
  test(): Promise<ConnectionTest>
  /**
   * Reads the signals of the given tiers for one environment. A query that fails is reported in
   * `failures` and leaves its signal out; a failure of the whole connection throws
   * `HealthConnectionError`, so no signal is ever shown as zero when it was not read.
   */
  read(env: HealthEnvironment, tiers: readonly HealthTier[], now: number): Promise<Partial<HealthSignals>>
  /**
   * On-demand details of one row, read when it is expanded or investigated. They throw on any
   * failure of the whole read; a part that fails on its own is reported inside the result.
   * Optional: a provider without them shows the rows without drill-downs.
   */
  errorDetails?(env: HealthEnvironment, service: string, now: number): Promise<ServiceErrorDetails>
  podDetails?(env: HealthEnvironment, pod: string, now: number): Promise<PodDetails>
  flowDetails?(env: HealthEnvironment, service: string, name: string, now: number): Promise<FlowDetails>
  /** The numbers of a flow map over the last `hours`: one read per measure, failures reported per key. */
  flowMap?(env: HealthEnvironment, map: FlowMap, now: number, hours: number): Promise<FlowMapReading>
  /** Recent executions of the flow: the entry transaction's traces over the last `hours`, sorted as asked. */
  flowTraces?(env: HealthEnvironment, map: FlowMap, now: number, hours: number, sort: FlowTraceSort, limit: number): Promise<FlowTraceSummary[]>
  /** One execution laid over the map (see `matchFlowTrace`). */
  flowTrace?(env: HealthEnvironment, map: FlowMap, traceId: string): Promise<FlowTrace>
  /** The APM errors and log lines of one execution (by `trace.id`), oldest first. */
  flowTraceLogs?(env: HealthEnvironment, traceId: string, limit: number): Promise<FlowTraceLog[]>
}
