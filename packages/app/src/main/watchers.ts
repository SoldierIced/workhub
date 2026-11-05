import { admitFlowAlerts, admitHealthAlerts, flowAlertsOf, healthAlertSettingsOf, notifiesFlowAlerts, withAlertThresholds, type FlowAlert, type HealthAlertChannel, type HealthAlertSettings, healthAlerts, ticketChanges, worstHealth, type HealthAlert, type HealthBaseline, type HealthState, type KnownTickets, type Ticket, type TicketChange } from '@workhub/core'
import type { FlowMapResult, FlowMapSummary, HealthView } from '../shared/health-api'
import type { TicketsResult } from '../shared/tickets-api'

/** How often the watchers look; Health itself only reads again once its refresh interval passed. */
export const WATCH_INTERVAL_MS = 60_000
/** Assigned tickets are read at most this often. */
export const TICKET_INTERVAL_MS = 5 * 60_000

/** When each alert subject last fired, kept in the data folder; `flush` writes a delayed save now. */
export interface Cooldowns {
  load(): Record<string, number>
  save(firedAt: Record<string, number>): void
  flush?(): void
}

export interface HealthWatcherDeps {
  activeProfileId: () => Promise<string | null>
  /** The Health service's cached read (it reads again only when due). */
  read: (profileId: string | null) => Promise<HealthView>
  /** Announces one alert on the channels its kind is set to (Settings → Alerts). */
  alert: (alert: HealthAlert, channels: HealthAlertChannel[]) => void
  changed: () => void
  /** The profile's Health alert settings per kind (`health.alerts`); unset: every kind on, the environment's thresholds. */
  alertSettings?: (profileId: string | null) => Promise<HealthAlertSettings | undefined>
  /** When each alert subject last fired, kept across launches so a restart does not repeat it within the hour. */
  cooldowns?: Cooldowns
  now?: () => number
}

/** What the menu bar shows about Health: null while Health is off or not set up. */
export interface HealthSummary {
  state: HealthState | null
  degraded: string[]
}

/**
 * Reads Health in the background and announces state changes per environment, as Workhub 1 does.
 * The first read after launch or a profile switch only records the states; the demo never alerts.
 */
export class HealthWatcher {
  private baseline = new Map<string, HealthBaseline>()
  private last: HealthSummary | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private firedAt: Record<string, number>

  constructor(private readonly deps: HealthWatcherDeps) {
    this.firedAt = deps.cooldowns?.load() ?? {}
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), WATCH_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stops the timer and writes the cooldowns still waiting for their delayed save. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.cooldowns?.flush?.()
  }

  summary(): HealthSummary | null {
    return this.last
  }

  async tick(): Promise<void> {
    try {
      const profileId = await this.deps.activeProfileId()
      const view = await this.deps.read(profileId)
      const before = JSON.stringify(this.last)
      if (view.state !== 'ready' && view.state !== 'demo') {
        this.last = null
      } else {
        const settings = healthAlertSettingsOf(await this.deps.alertSettings?.(profileId))
        // The per-kind thresholds narrow what the comparison sees; the Health screen keeps the full snapshot.
        const readouts = view.environments
          .filter((e) => !e.snapshot.blindSpots.some((b) => b.code === 'notReadYet'))
          .map((e) => ({ id: e.id, name: e.name, state: e.snapshot.state, snapshot: withAlertThresholds(e.snapshot, settings), minErrorsToFlag: e.thresholds?.minErrorsToFlag, errorWindowHours: e.errorWindowHours }))
        const key = profileId ?? ''
        const { alerts: found, baseline } = healthAlerts(this.baseline.get(key), readouts)
        this.baseline.set(key, baseline)
        // A kind turned off is still compared (so turning it on later does not announce old news), never announced.
        const alerts = found.filter((a) => settings[a.kind].notify && settings[a.kind].channels.length > 0)
        if (view.state === 'ready' && alerts.length > 0) {
          // At most one alert per subject per hour.
          const { admitted, firedAt } = admitHealthAlerts(alerts, this.firedAt, (this.deps.now ?? Date.now)())
          this.firedAt = firedAt
          this.deps.cooldowns?.save(firedAt)
          for (const a of admitted) this.deps.alert(a, settings[a.kind].channels)
        }
        this.last = {
          state: worstHealth(readouts.map((r) => r.state)),
          degraded: view.environments.filter((e) => e.snapshot.state === 'degraded' || e.snapshot.state === 'unreachable').map((e) => e.name)
        }
      }
      if (JSON.stringify(this.last) !== before) this.deps.changed()
    } catch {
      // Health reports its own failures as states; anything else waits for the next tick.
    }
  }
}

/** Flow-map alerts are checked this often: every map with limits costs APM queries. */
export const FLOW_ALERT_INTERVAL_MS = 5 * 60_000
/** The first check waits this long after launch so startup is not slowed. */
export const FLOW_ALERT_FIRST_DELAY_MS = 30_000

export interface FlowAlertWatcherDeps {
  activeProfileId: () => Promise<string | null>
  /** Whether the profile has both the Flow maps and Health modules on. */
  enabled: (profileId: string) => Promise<boolean>
  /** The environments that can be measured: empty unless Health is set up and live. */
  environments: (profileId: string) => Promise<{ id: string; name: string }[]>
  maps: (profileId: string) => Promise<FlowMapSummary[]>
  /** One map measured over `hours` (HealthService caches readings for a while). */
  read: (profileId: string, environmentId: string, mapId: string, hours: number) => Promise<FlowMapResult>
  alert: (alert: FlowAlert) => void
  cooldowns?: Cooldowns
  now?: () => number
  intervalMs?: number
}

/**
 * Reads the flow maps that ask for alerts over the last hour and announces the parts above their
 * limits, each at most once an hour (kept across launches). A failing map never stops the others.
 */
export class FlowAlertWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private firedAt: Record<string, number>
  private running = false

  constructor(private readonly deps: FlowAlertWatcherDeps) {
    this.firedAt = deps.cooldowns?.load() ?? {}
  }

  start(): void {
    if (this.timer || this.first) return
    const every = this.deps.intervalMs ?? FLOW_ALERT_INTERVAL_MS
    this.first = setTimeout(() => {
      this.first = null
      void this.tick()
      this.timer = setInterval(() => void this.tick(), every)
      this.timer.unref?.()
    }, FLOW_ALERT_FIRST_DELAY_MS)
    this.first.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = null
    this.timer = null
    this.deps.cooldowns?.flush?.()
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const profileId = await this.deps.activeProfileId()
      if (!profileId || !(await this.deps.enabled(profileId))) return
      const environments = await this.deps.environments(profileId)
      if (environments.length === 0) return
      const maps = await this.deps.maps(profileId)
      const found: FlowAlert[] = []
      for (const summary of maps) {
        if (summary.error) continue
        const targets = summary.environmentId ? environments.filter((e) => e.id === summary.environmentId) : environments
        for (const env of targets) {
          try {
            const result = await this.deps.read(profileId, env.id, summary.id, 1)
            // A map whose limits say `notify: false` is checked on screen only.
            if (!result.ok || !result.reading || !notifiesFlowAlerts(result.map)) continue
            found.push(...flowAlertsOf(result.map, result.reading, env))
          } catch {
            // This map in this environment waits for the next tick.
          }
        }
      }
      const { admitted, firedAt } = admitFlowAlerts(found, this.firedAt, (this.deps.now ?? Date.now)())
      this.firedAt = firedAt
      this.deps.cooldowns?.save(firedAt)
      for (const a of admitted) {
        try {
          this.deps.alert(a)
        } catch {
          // A failed notification does not hide the next one.
        }
      }
    } catch {
      // Anything unexpected waits for the next tick.
    } finally {
      this.running = false
    }
  }
}

/** What the ticket watcher keeps: the tickets last seen and when they were read, per profile. */
export interface TicketWatchState {
  profiles: Record<string, KnownTickets>
  /** When each profile's memory was last refreshed; missing in files written before it existed. */
  readAt?: Record<string, number>
}

export interface TicketStore {
  load(fallback: TicketWatchState): TicketWatchState
  save(value: TicketWatchState): void
  /** Writes a delayed save now (at quit). */
  flush?(): void
}

/** A profile's memory older than this is only refreshed: its changes are old news. */
export const TICKET_MEMORY_STALE_MS = 24 * 3_600_000
/** More changes than this in one read are announced as one summary. */
export const TICKET_BURST_LIMIT = 5
/**
 * A list this long may be cut by the tracker (each adapter caps its assigned list, at 100 or more), so
 * it never announces a ticket as gone. Conservative until the tracker port says when it cut a list.
 */
export const TICKET_LIST_CAP = 100

export interface TicketWatcherDeps {
  activeProfileId: () => Promise<string | null>
  /** Whether ticket notifications are on: while off nothing is read and the memory is dropped. */
  enabled: () => Promise<boolean>
  list: (profileId: string) => Promise<TicketsResult<Pick<Ticket, 'key' | 'title' | 'status'>[]>>
  store: TicketStore
  announce: (profileId: string, change: TicketChange) => void
  /** One notification for a burst of changes (see `ticketSummaryWords`); without it a burst is only recorded. */
  announceSummary?: (profileId: string, changes: TicketChange[]) => void
  now?: () => number
}

/**
 * Reads the assigned tickets of the active profile now and then and announces status changes,
 * new assignments and tickets that left, as Workhub 1 does. What was seen is kept in the data
 * folder, so a restart does not announce the same change again. Only the active profile is read,
 * so a profile's memory can be weeks old when it becomes active again: past a day it is refreshed
 * without notifying, and a burst of changes becomes one summary. A list at the trackers' cap may
 * leave tickets out, so it never announces a ticket as gone.
 */
export class TicketWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRead = 0
  private known: Record<string, KnownTickets>
  private readAt: Record<string, number>

  constructor(private readonly deps: TicketWatcherDeps) {
    const stored = deps.store.load({ profiles: {}, readAt: {} })
    this.known = stored.profiles ?? {}
    this.readAt = stored.readAt ?? {}
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), WATCH_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stops the timer and writes the memory still waiting for its delayed save. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.store.flush?.()
  }

  async tick(force = false): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    if (!force && now - this.lastRead < TICKET_INTERVAL_MS && this.lastRead !== 0) return
    try {
      const profileId = await this.deps.activeProfileId()
      if (!profileId) return
      if (!(await this.deps.enabled())) {
        // Turned on again later, the first read only records (no burst of old changes).
        if (this.known[profileId]) {
          delete this.known[profileId]
          delete this.readAt[profileId]
          this.save()
        }
        return
      }
      this.lastRead = now
      const r = await this.deps.list(profileId)
      if (!r.ok) return
      const readAt = this.readAt[profileId]
      const fresh = readAt !== undefined && now - readAt <= TICKET_MEMORY_STALE_MS
      const before = fresh ? this.known[profileId] : undefined
      const { changes: all, known } = ticketChanges(before, r.value)
      const capped = r.value.length >= TICKET_LIST_CAP
      // A full list may have pushed tickets out: they are kept in memory rather than announced as gone.
      const changes = capped ? all.filter((c) => c.kind !== 'left') : all
      this.known[profileId] = capped && before ? { ...before, ...known } : known
      this.readAt[profileId] = now
      this.save()
      if (changes.length > TICKET_BURST_LIMIT) this.deps.announceSummary?.(profileId, changes)
      else for (const change of changes) this.deps.announce(profileId, change)
    } catch {
      // A tracker failure is not news; the next read tries again.
    }
  }

  private save(): void {
    this.deps.store.save({ profiles: this.known, readAt: this.readAt })
  }
}

/** The words of a burst of ticket changes folded into one notification. */
export function ticketSummaryWords(changes: readonly TicketChange[], t: (key: string, params?: Record<string, string | number>) => string): { title: string; body: string } {
  const keys = changes.slice(0, 6).map((c) => c.key).join(', ') + (changes.length > 6 ? ', …' : '')
  return { title: t('notify.ticket.summary', { count: changes.length }), body: keys }
}
