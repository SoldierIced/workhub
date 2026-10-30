// Types of the Health bridge (window.hub.health), shared by main, preload and renderer.
import type { Connection, ConnectionTest, FlowDetails, FlowMap, FlowMapReading, FlowTrace, FlowTraceLog, FlowTraceSort, FlowTraceSummary, HealthDetailRequest, HealthSnapshot, HealthThresholds, PodDetails, SecretChange, ServiceErrorDetails } from '@workhub/core'

/**
 * - ready: a configured provider serves the profile.
 * - demo: synthetic data (WORKHUB_DEMO_HEALTH=1), no cluster or credentials needed.
 * - moduleOff: the profile has the Health module turned off.
 * - noConnection: the profile has no health connection.
 * - incomplete: the connection lacks its URL, user or secret.
 * - noEnvironments: connected, but no environment to watch yet.
 * - unsupported: the provider has no adapter yet (Sentry).
 */
export type HealthState = 'ready' | 'demo' | 'moduleOff' | 'noConnection' | 'incomplete' | 'noEnvironments' | 'unsupported'

export interface HealthEnvironmentView {
  id: string
  name: string
  snapshot: HealthSnapshot
  /** Kibana link to the environment's services; null without a Kibana URL. */
  kibanaUrl: string | null
  /** Kibana link per service named in the snapshot. */
  serviceUrls: Record<string, string>
  /** Kibana errors page per service with errors. */
  errorUrls: Record<string, string>
  /** Kibana Discover per listed pod. */
  podUrls: Record<string, string>
  /** The thresholds the verdict used, to word the numbers (window hours, minimum calls). */
  slowFlowHours: number
  errorWindowHours: number
  thresholds: HealthThresholds
  /** Whether the environment is expected to ship kube-state metrics, and its Kubernetes suffix (for the infra request). */
  hasKubeState: boolean
  k8sIndexSuffix: string
}

export interface HealthView {
  state: HealthState
  connectionName?: string
  refreshMinutes: number
  environments: HealthEnvironmentView[]
  /** Epoch milliseconds of the last read. */
  updatedAt?: number
}

/** What a row asks for, and what it gets; a failure says why instead of throwing across the bridge. */
export type HealthDetail = ServiceErrorDetails | PodDetails | FlowDetails
export type HealthDetailResult<T extends HealthDetail = HealthDetail> = { ok: true; value: T } | { ok: false; error: string }

/** One flow-map file of the data folder, as the list shows it. */
export interface FlowMapSummary {
  id: string
  name: string
  description?: string
  /** The environment the map measures itself on, when the file names one. */
  environmentId?: string
  file: string
  nodes: number
  edges: number
  /** The file could not be parsed: the reason. */
  error?: string
}

/** A map with its numbers; `reading` is missing while the provider cannot measure (demo and Elastic can). */
export type FlowMapResult = { ok: true; map: FlowMap; reading?: FlowMapReading } | { ok: false; error: string }

export type FlowTracesResult = { ok: true; traces: FlowTraceSummary[] } | { ok: false; error: string }
export type FlowTraceResult = { ok: true; trace: FlowTrace } | { ok: false; error: string }
export type FlowTraceLogsResult = { ok: true; logs: FlowTraceLog[] } | { ok: false; error: string }

export interface HealthApi {
  /** Recent executions of a map's entry transaction on an environment (never cached: the list is cheap). */
  flowTraces(profileId: string | null, environmentId: string, mapId: string, hours: number, sort: FlowTraceSort): Promise<FlowTracesResult>
  /** One execution laid over the map (kept 10 minutes). */
  flowTrace(profileId: string | null, environmentId: string, mapId: string, traceId: string): Promise<FlowTraceResult>
  /** The APM errors and log lines of one execution, oldest first. */
  flowTraceLogs(profileId: string | null, environmentId: string, mapId: string, traceId: string): Promise<FlowTraceLogsResult>
  /** The flow maps of the data folder (`flow-maps/*.json`), bad files included with their error. */
  flowMaps(profileId: string | null): Promise<FlowMapSummary[]>
  /** One map, measured on an environment over the last `hours` (kept 10 minutes; `force` reads again). */
  flowMap(profileId: string | null, environmentId: string, mapId: string, hours: number, force?: boolean): Promise<FlowMapResult>
  /** The last read of the profile; reads again when the refresh interval passed or `force` is set (never more than every 30 s). */
  get(profileId: string | null, force?: boolean): Promise<HealthView>
  /**
   * The on-demand details of one row (error groups, a pod's events and stderr, a flow's spans and
   * window comparison). Kept 10 minutes; `force` reads again unless the last read is under 30 s old.
   */
  details(profileId: string | null, environmentId: string, request: HealthDetailRequest, force?: boolean): Promise<HealthDetailResult>
  /** Checks a connection as typed in the form, before it is saved. */
  test(connection: Connection, secret: SecretChange, indexToProbe?: string): Promise<ConnectionTest>
}
