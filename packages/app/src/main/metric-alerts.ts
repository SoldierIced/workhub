import {
  applyAlertAction,
  demoMetricSamples,
  detectMetricAlerts,
  DEMO_METRIC_SOURCE,
  DEMO_METRICS,
  HEALTH_METRIC_SOURCE,
  HEALTH_METRICS,
  healthMetricSamples,
  mergeSamples,
  productMetricSamples,
  PRODUCT_METRICS,
  PRODUCT_METRIC_SOURCE,
  reconcileAlerts,
  severityAtLeast,
  sortAlerts,
  type AlertRulesConfig,
  type MetricAlert,
  type MetricAlertAction,
  type MetricSample,
  type MetricSeriesStore,
  type MetricSource
} from '@workhub/core'
import type { HealthView } from '../shared/health-api'
import type { MetricAlertsView } from '../shared/metric-alerts-api'

/** Samples are collected this often: the series are daily, so more often only refreshes today's value. */
export const METRIC_ALERT_INTERVAL_MS = 5 * 60_000
/** The first run waits this long after launch so startup is not slowed. */
export const METRIC_ALERT_FIRST_DELAY_MS = 30_000

export interface ProfileMetricState {
  series: MetricSeriesStore
  alerts: MetricAlert[]
  /** Epoch ms of the last evaluation. */
  updatedAt?: number
}

/** `metric-alerts.json`: per profile, the daily series and the alerts. */
export interface MetricAlertsState {
  profiles: Record<string, ProfileMetricState>
}

export interface MetricAlertsStore {
  load(fallback: MetricAlertsState): MetricAlertsState
  save(value: MetricAlertsState): void
  flush?(): void
}

/** A profile the engine runs for: the Health module is on. */
export interface MetricAlertProfile {
  id: string
  rules: AlertRulesConfig
}

export interface MetricAlertServiceDeps {
  /** Every profile with the Health module on, with its rules. */
  profiles: () => Promise<MetricAlertProfile[]>
  /** The sources of a profile. */
  sources: (profileId: string) => readonly MetricSource[]
  store: MetricAlertsStore
  /** Newly opened or escalated alerts at or above the profile's minimum severity, worst first. */
  notify: (profileId: string, alerts: MetricAlert[]) => void
  /** The alerts of a profile changed (evaluation or user action). */
  changed: (profileId: string) => void
  /** Synthetic data: nothing is announced (the Health demo never alerts). */
  demo?: boolean
  now?: () => number
  intervalMs?: number
  firstDelayMs?: number
}

const EMPTY_PROFILE: ProfileMetricState = { series: {}, alerts: [] }

/** A stored state read defensively: a hand-edited or older file never stops the engine. */
function cleanState(raw: MetricAlertsState): MetricAlertsState {
  const profiles: Record<string, ProfileMetricState> = {}
  const source = raw && typeof raw.profiles === 'object' && raw.profiles !== null ? raw.profiles : {}
  for (const [id, p] of Object.entries(source)) {
    if (!p || typeof p !== 'object') continue
    profiles[id] = {
      series: p.series && typeof p.series === 'object' && !Array.isArray(p.series) ? p.series : {},
      alerts: Array.isArray(p.alerts) ? p.alerts.filter((a) => a && typeof a.key === 'string') : [],
      ...(typeof p.updatedAt === 'number' ? { updatedAt: p.updatedAt } : {})
    }
  }
  return { profiles }
}

/**
 * The metric alert engine of the main process: per profile with Health on, it collects samples
 * from every source, merges them into the daily series, runs the rules, reconciles the alerts,
 * announces what opened or escalated and says what changed. One run at a time, so a user's action
 * never races an evaluation.
 */
export class MetricAlertService {
  private state: MetricAlertsState
  private timer: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: MetricAlertServiceDeps) {
    this.state = cleanState(deps.store.load({ profiles: {} }))
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer || this.first) return
    this.first = setTimeout(() => {
      this.first = null
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? METRIC_ALERT_INTERVAL_MS)
      this.timer.unref?.()
    }, this.deps.firstDelayMs ?? METRIC_ALERT_FIRST_DELAY_MS)
    this.first.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
    this.deps.store.flush?.()
  }

  /** Runs `op` after whatever is running; a failure never blocks the next one. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Evaluates every profile with Health on. */
  tick(): Promise<void> {
    return this.serial(async () => {
      try {
        for (const profile of await this.deps.profiles()) await this.evaluate(profile)
      } catch {
        // The next tick tries again.
      }
    })
  }

  /** Evaluates one profile now ("Refresh" on the Alerts tab). */
  refresh(profileId: string): Promise<MetricAlertsView> {
    return this.serial(async () => {
      const profile = (await this.deps.profiles()).find((p) => p.id === profileId)
      if (profile) await this.evaluate(profile)
      return this.viewOf(profileId, Boolean(profile))
    })
  }

  async list(profileId: string): Promise<MetricAlertsView> {
    const enabled = (await this.deps.profiles()).some((p) => p.id === profileId)
    return this.viewOf(profileId, enabled)
  }

  /** Applies a user's action to one alert. */
  setStatus(profileId: string, key: string, action: MetricAlertAction): Promise<MetricAlertsView> {
    return this.serial(async () => {
      const current = this.state.profiles[profileId]
      if (current?.alerts.some((a) => a.key === key)) {
        this.state.profiles[profileId] = { ...current, alerts: applyAlertAction(current.alerts, key, action, this.now()) }
        this.deps.store.save(this.state)
        this.deps.changed(profileId)
      }
      return this.list(profileId)
    })
  }

  private viewOf(profileId: string, enabled: boolean): MetricAlertsView {
    const p = this.state.profiles[profileId] ?? EMPTY_PROFILE
    return { enabled, demo: this.deps.demo === true, alerts: sortAlerts(p.alerts), ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}) }
  }

  private async evaluate(profile: MetricAlertProfile): Promise<void> {
    const now = this.now()
    const sources = this.deps.sources(profile.id)
    const samples: MetricSample[] = []
    for (const source of sources) {
      try {
        samples.push(...(await source.collect(profile.id, now)))
      } catch {
        // A failing source keeps its stored history; the others still count.
      }
    }
    const before = this.state.profiles[profile.id] ?? EMPTY_PROFILE
    const series = mergeSamples(before.series, samples, now)
    const detections = detectMetricAlerts(series, sources.flatMap((s) => s.definitions()), profile.rules, now)
    const { alerts, opened, escalated } = reconcileAlerts(before.alerts, detections, now, profile.rules.businessDays)
    this.state.profiles[profile.id] = { series, alerts, updatedAt: now }
    this.deps.store.save(this.state)
    const announce = sortAlerts([...opened, ...escalated].filter((a) => a.status !== 'snoozed' && severityAtLeast(a.severity, profile.rules.notifyMinSeverity)))
    if (announce.length > 0 && !this.deps.demo) {
      try {
        this.deps.notify(profile.id, announce)
      } catch {
        // A failed notification does not undo the evaluation.
      }
    }
    if (JSON.stringify(before.alerts) !== JSON.stringify(alerts)) this.deps.changed(profile.id)
  }
}

/** Health's own read (cached by the Health service) as a metric source. */
export class HealthMetricSource implements MetricSource {
  readonly id = HEALTH_METRIC_SOURCE

  constructor(private readonly read: (profileId: string) => Promise<HealthView>) {}

  definitions() {
    return HEALTH_METRICS
  }

  async collect(profileId: string, now: number): Promise<MetricSample[]> {
    const view = await this.read(profileId)
    if (view.state !== 'ready' && view.state !== 'demo') return []
    return healthMetricSamples(
      view.environments.map((e) => ({ name: e.name, snapshot: e.snapshot, errorUrls: e.errorUrls, serviceUrls: e.serviceUrls })),
      now
    )
  }
}

/** Synthetic product metrics with a month of history, so the Alerts tab has something to show in the Health demo. */
export class DemoMetricSource implements MetricSource {
  readonly id = DEMO_METRIC_SOURCE

  constructor(private readonly businessDays: (profileId: string) => Promise<readonly number[]>) {}

  definitions() {
    return DEMO_METRICS
  }

  async collect(profileId: string, now: number): Promise<MetricSample[]> {
    return demoMetricSamples(now, await this.businessDays(profileId))
  }
}

/** The team-lead scenario's funnel, cancellation reason, front-end error and key event metrics (`npm run demo`), with a month of history. */
export class ProductMetricSource implements MetricSource {
  readonly id = PRODUCT_METRIC_SOURCE

  constructor(private readonly businessDays: (profileId: string) => Promise<readonly number[]>) {}

  definitions() {
    return PRODUCT_METRICS
  }

  async collect(profileId: string, now: number): Promise<MetricSample[]> {
    return productMetricSamples(now, await this.businessDays(profileId))
  }
}
