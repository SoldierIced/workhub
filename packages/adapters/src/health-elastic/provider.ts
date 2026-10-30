import { flowEntry, flowMeasures, HealthConnectionError, matchFlowTrace, type FlowTrace, type FlowTraceLog, type FlowTraceSort, type FlowTraceSummary, type ConnectionTest, type FlowDetails, type FlowMap, type FlowMapReading, type HealthEnvironment, type HealthProvider, type HealthSignal, type HealthSignals, type HealthTier, type PodDetails, type PodIssue, type ServiceErrorDetails } from '@workhub/core'
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
    // The fast tier first: whether pods are visible decides between warning events and container stderr.
    if (tiers.includes('fast')) await this.fast(env, now, out, failures)
    const jobs: Promise<void>[] = []
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
    // Without Kubernetes metrics, container stderr is the only infrastructure signal there is.
    const stderr = async () => {
      if (q.kubernetesSuffix(env) === '' || out.podVisibility === 'visible') {
        out.stderr = []
        return
      }
      const request = q.containerStderr(env)
      const response = await this.attempt('stderr', failures, () => this.client.search(request.index, request.body))
      if (response !== undefined) out.stderr = q.parseTrends(response)
    }
    await Promise.all([errors(), events(), stderr()])
  }

  private async slow(env: HealthEnvironment, out: Partial<HealthSignals>, failures: Failures): Promise<void> {
    if (!q.readsTraces(env)) return
    const request = q.slowTransactions(env)
    const response = await this.attempt('slow', failures, () => this.client.search(request.index, request.body))
    if (response !== undefined) out.slow = q.parseSlowTransactions(response, env.thresholds.slowFlowMinCalls, env.thresholds.slowFlowCount)
  }

  // On-demand details ------------------------------------------------------------------------------

  /** Runs one detail query; a connection-level failure is thrown as such, any other too (the row shows it). */
  private async ask(request: q.EsRequest) {
    try {
      return await this.client.search(request.index, request.body)
    } catch (error) {
      if (error instanceof ElasticError && error.isConnectionLevel) throw toConnectionError(error)
      throw error
    }
  }

  /** A part of a detail that fails on its own: its message, so the other parts still show. */
  private async part<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
      return { value: await run() }
    } catch (error) {
      if (error instanceof HealthConnectionError) throw error
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  async errorDetails(env: HealthEnvironment, service: string, now: number): Promise<ServiceErrorDetails> {
    if (!q.readsErrors(env)) return { service, groups: [], fetchedAt: now }
    const response = await this.ask(q.errorGroups(env, service))
    return { service, groups: q.parseErrorGroups(response, now, env.thresholds.errorWindowHours), fetchedAt: now }
  }

  async podDetails(env: HealthEnvironment, pod: string, now: number): Promise<PodDetails> {
    const hours = env.thresholds.errorWindowHours
    const kube = q.kubernetesSuffix(env) !== ''
    const [status, events, stderr] = await Promise.all([
      this.part(async () => (kube && env.hasKubeState ? q.parsePodStatus(await this.ask(q.podStatus(env, [pod])))[pod] : undefined)),
      this.part(async () => (kube ? q.parsePodEvents(await this.ask(q.podEvents(env, pod, hours))) : [])),
      this.part(async () => (kube ? q.parsePodStderr(await this.ask(q.podStderr(env, pod, hours))) : []))
    ])
    return { pod, status: status.value, events: events.value ?? [], eventsError: events.error, stderr: stderr.value ?? [], stderrError: stderr.error, fetchedAt: now }
  }

  async flowDetails(env: HealthEnvironment, service: string, name: string, now: number): Promise<FlowDetails> {
    const hours = env.thresholds.slowFlowHours
    const out: FlowDetails = { service, name, sampledTransactions: 0, sampledWallMs: 0, spans: [], fetchedAt: now }
    if (!q.readsTraces(env)) return out
    const spans = this.part(async () => {
      const sample = q.parseExecutions(await this.ask(q.slowestExecutions(env, service, name)))
      if (sample.ids.length === 0) return { sample, spans: [] }
      return { sample, spans: q.parseSpanBreakdown(await this.ask(q.spanBreakdown(env, sample)), sample) }
    })
    const comparison = this.part(async () => {
      const errors = q.readsErrors(env) ? this.ask(q.windowErrors(env, service, now, hours)) : Promise.resolve(undefined)
      const newTypes = q.readsErrors(env) ? this.ask(q.newErrorTypes(env, service, now, hours)) : Promise.resolve(undefined)
      const [e, t, n] = await Promise.all([errors, this.ask(q.windowTransactions(env, service, name, now, hours)), newTypes])
      return q.parseWindowComparison(e, t, n, service, name, now, hours)
    })
    const [s, c] = await Promise.all([spans, comparison])
    if (s.value) {
      out.spans = s.value.spans
      out.sampledTransactions = s.value.sample.ids.length
      out.sampledWallMs = s.value.sample.wallMs
    }
    out.spansError = s.error
    out.comparison = c.value
    out.comparisonError = c.error
    return out
  }

  /** Every measure of the map at once; a measure that fails is reported under its key, the rest still read. */
  async flowMap(env: HealthEnvironment, map: FlowMap, now: number, hours: number): Promise<FlowMapReading> {
    const reading: FlowMapReading = { at: now, windowHours: hours, edges: {}, nodes: {}, stages: {}, errors: {} }
    if (!q.readsTraces(env)) {
      for (const m of flowMeasures(map)) reading.errors[m.key] = 'the environment has no traces index or APM environment'
      return reading
    }
    await Promise.all(
      flowMeasures(map).map(async (m) => {
        const r = await this.part(async () => q.parseFlowMeasure(await this.ask(q.flowMeasure(env, m.measure, now, hours)), m.measure, hours))
        if (r.value) reading[m.of][m.key] = r.value
        else reading.errors[m.key] = r.error ?? 'unknown failure'
      })
    )
    return reading
  }

  async flowTraces(env: HealthEnvironment, map: FlowMap, now: number, hours: number, sort: FlowTraceSort, limit: number): Promise<FlowTraceSummary[]> {
    const entry = flowEntry(map)
    if (!entry) throw new Error('the map has no entry transaction: add an "entry" measure or a node with an apm.transaction measure')
    if (!q.readsTraces(env)) throw new Error('the environment has no traces index or APM environment')
    return q.parseFlowTraces(await this.ask(q.flowTraces(env, entry, now, hours, sort, limit)))
  }

  async flowTrace(env: HealthEnvironment, map: FlowMap, traceId: string): Promise<FlowTrace> {
    if (!q.readsTraces(env)) throw new Error('the environment has no traces index or APM environment')
    const docs = q.parseFlowTraceDocs(await this.ask(q.flowTraceDocs(env, traceId)))
    if (docs.length === 0) throw new Error(`trace ${traceId} was not found in the traces index`)
    return matchFlowTrace(map, traceId, docs)
  }

  /** APM errors and container log lines of one execution, oldest first; a source that fails is skipped unless both do. */
  async flowTraceLogs(env: HealthEnvironment, traceId: string, limit: number): Promise<FlowTraceLog[]> {
    const sources: Promise<{ value?: FlowTraceLog[]; error?: string }>[] = []
    if (q.readsErrors(env)) sources.push(this.part(async () => q.parseFlowTraceErrors(await this.ask(q.flowTraceErrors(env, traceId, limit)))))
    if (q.kubernetesSuffix(env)) sources.push(this.part(async () => q.parseFlowTraceContainerLogs(await this.ask(q.flowTraceContainerLogs(env, traceId, limit, Date.now())))))
    if (sources.length === 0) throw new Error('the environment has no errors index and no Kubernetes index suffix to read logs from')
    const results = await Promise.all(sources)
    const failures = results.flatMap((r) => (r.error ? [r.error] : []))
    if (failures.length === results.length) throw new Error(`could not read the logs of trace ${traceId}: ${failures.join('; ')}`)
    return results.flatMap((r) => r.value ?? []).sort((a, b) => a.at - b.at).slice(0, limit)
  }
}
