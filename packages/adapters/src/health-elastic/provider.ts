import type { ConnectionTest, HealthEnvironment, HealthProvider, HealthSignal, HealthSignals, HealthTier, PodIssue } from '@workhub/core'
import { ElasticClient, ElasticError, toConnectionError } from './client'
import * as q from './queries'

/** Failures of one signal, collected while the rest of the tier is still read. */
type Failures = Partial<Record<HealthSignal, string>>

export interface ElasticHealthProviderOptions {
  client: ElasticClient
  /** Index used by Test connection; the first configured one, `*` when none. */
  testIndex?: string
}

/**
 * Elasticsearch (Elastic APM and the Kubernetes integration) as a `HealthProvider`. Read-only:
 * aggregation-only `_search` and `_count`. A failure of the whole connection throws
 * `HealthConnectionError`; a failure of one query is reported as that signal's failure.
 */
export class ElasticHealthProvider implements HealthProvider {
  readonly provider = 'elastic-apm'
  private readonly client: ElasticClient
  private readonly testIndex: string

  constructor(options: ElasticHealthProviderOptions) {
    this.client = options.client
    this.testIndex = options.testIndex?.trim() || '*'
  }

  async test(): Promise<ConnectionTest> {
    try {
      const count = await this.client.count(this.testIndex, { match_all: {} })
      return { ok: true, account: `${count.toLocaleString('en-US')} documents in ${this.testIndex}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async read(env: HealthEnvironment, tiers: readonly HealthTier[], now: number): Promise<Partial<HealthSignals>> {
    const out: Partial<HealthSignals> = {}
    const failures: Failures = {}
    const jobs: Promise<void>[] = []
    if (tiers.includes('fast')) jobs.push(this.fast(env, now, out, failures))
    if (tiers.includes('trend')) jobs.push(this.trend(env, out, failures))
    if (tiers.includes('slow')) jobs.push(this.slow(env, out, failures))
    await Promise.all(jobs)
    out.failures = failures
    return out
  }

  /** Runs one query; a connection-level failure aborts the refresh, any other becomes the signal's failure. */
  private async attempt<T>(signal: HealthSignal, failures: Failures, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ElasticError) {
        if (error.isConnectionLevel) throw toConnectionError(error)
        failures[signal] = error.message
      } else {
        failures[signal] = error instanceof Error ? error.message : String(error)
      }
      return undefined
    }
  }

  private async fast(env: HealthEnvironment, now: number, out: Partial<HealthSignals>, failures: Failures): Promise<void> {
    const t = env.thresholds
    const wantsPods = env.hasKubeState && q.kubernetesSuffix(env) !== ''
    const pods = async () => {
      if (!wantsPods) {
        out.podVisibility = 'notExpected'
        return
      }
      const telemetry = q.kubeTelemetry(env)
      const count = await this.attempt('pods', failures, () => this.client.count(telemetry.index, telemetry.body))
      if (count === undefined) return
      out.podVisibility = count > 0 ? 'visible' : 'missing'
      if (count === 0) {
        out.notReady = []
        out.restarts = []
        out.backOff = []
        return
      }
      const read = async (request: q.EsRequest, parse: (r: unknown) => PodIssue[]) => {
        const response = await this.client.search(request.index, request.body)
        return parse(response)
      }
      // The three pod signals are one: if any query fails the pod picture is incomplete and none is kept.
      const parts = await this.attempt('pods', failures, () =>
        Promise.all([read(q.podsNotReady(env), q.parsePodsNotReady), read(q.containerRestarts(env), q.parseContainerRestarts), read(q.backOffEvents(env), q.parseBackOffEvents)])
      )
      if (parts) [out.notReady, out.restarts, out.backOff] = parts
    }
    const reporting = async () => {
      if (!q.readsMetrics(env)) return
      const request = q.apmReporting(env)
      const response = await this.attempt('reporting', failures, () => this.client.search(request.index, request.body))
      if (response !== undefined) out.reporting = q.parseApmReporting(response, now, t.silentAfterMinutes)
    }
    await Promise.all([pods(), reporting()])
  }

  private async trend(env: HealthEnvironment, out: Partial<HealthSignals>, failures: Failures): Promise<void> {
    const errors = async () => {
      if (!q.readsErrors(env)) return
      const request = q.errorsByService(env)
      const response = await this.attempt('errors', failures, () => this.client.search(request.index, request.body))
      if (response !== undefined) out.errors = q.parseErrorsByService(response)
    }
    const events = async () => {
      if (q.kubernetesSuffix(env) === '') return
      const request = q.warningEvents(env)
      const response = await this.attempt('events', failures, () => this.client.search(request.index, request.body))
      if (response !== undefined) out.events = q.parseWarningEvents(response)
    }
    await Promise.all([errors(), events()])
  }

  private async slow(env: HealthEnvironment, out: Partial<HealthSignals>, failures: Failures): Promise<void> {
    if (!q.readsTraces(env)) return
    const request = q.slowTransactions(env)
    const response = await this.attempt('slow', failures, () => this.client.search(request.index, request.body))
    if (response !== undefined) out.slow = q.parseSlowTransactions(response, env.thresholds.slowFlowMinCalls, env.thresholds.slowFlowCount)
  }
}
