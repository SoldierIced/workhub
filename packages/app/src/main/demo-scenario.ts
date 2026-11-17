import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  PRODUCT_ALERT_KEYS,
  PRODUCT_PROFILE_ID,
  PRODUCT_PROJECT,
  PRODUCT_SCENARIO,
  PRODUCT_TRACKER_SECRET,
  localDay,
  productConnections,
  productInbox,
  productMetricState,
  productMilestoneCounts,
  productMilestones,
  productProfile,
  productTicketStates,
  type ConfigurationService,
  type SecretStore
} from '@workhub/core'
import { AutomationRunLog, legacyImportDone, refreshSessionTotals, SessionRecords, Timelines, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import type { MetricAlertsState } from './metric-alerts'
import type { PlannerState } from './planner-service'

export const PLANNER_STATE_FILE = 'planner-state.json'
export const METRIC_ALERTS_FILE = 'metric-alerts.json'

/** The scenario `WORKHUB_DEMO_SCENARIO` selects ('team-lead'), or null for none (or an unknown name). */
export function demoScenario(env: Readonly<Record<string, string | undefined>> = process.env): typeof PRODUCT_SCENARIO | null {
  return env['WORKHUB_DEMO_SCENARIO'] === PRODUCT_SCENARIO ? PRODUCT_SCENARIO : null
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Seeds the scenario's milestones, inbox and metric alerts as JSON files in the data folder, unless
 * those files exist already, or `db` had its legacy import (then the scenario is in its `kv_state`
 * already, and new files would only end up renamed `.skipped`). Runs before `importLegacyJson`,
 * which stores them. Returns the files it wrote.
 */
export function seedScenarioState(dataDir: string, now: number = Date.now(), db?: WorkhubDb): string[] {
  if (db && legacyImportDone(db)) return []
  const written: string[] = []
  const plannerPath = join(dataDir, PLANNER_STATE_FILE)
  const metricsPath = join(dataDir, METRIC_ALERTS_FILE)
  const metrics = productMetricState(now)
  if (!existsSync(metricsPath)) {
    const state: MetricAlertsState = { profiles: { [PRODUCT_PROFILE_ID]: metrics } }
    writeJson(metricsPath, state)
    written.push(metricsPath)
  }
  if (!existsSync(plannerPath)) {
    const milestones = productMilestones(localDay(now))
    // The pending bug is drafted from the front-end error alert, as "Send to inbox" would.
    const alert = metrics.alerts.find((a) => a.key === PRODUCT_ALERT_KEYS.risingError)
    const inbox = productInbox(now, alert)
    const state: PlannerState = { profiles: { [PRODUCT_PROFILE_ID]: { milestones, counts: productMilestoneCounts(milestones, now), errors: {}, inbox, proposals: [], tickets: productTicketStates(milestones, inbox, now) } } }
    writeJson(plannerPath, state)
    written.push(plannerPath)
  }
  return written
}

/**
 * Saves the scenario's profile, through the configuration service so the schema and the
 * cross-reference rules apply, when the config has no profile yet. Returns whether it seeded.
 */
export async function seedScenarioConfig(configuration: Pick<ConfigurationService, 'current' | 'saveConnection' | 'saveProfile' | 'setActiveProfile' | 'saveOptions'>, folder: string): Promise<boolean> {
  if ((await configuration.current()).profiles.length > 0) return false
  for (const connection of productConnections()) {
    const saved = await configuration.saveConnection(connection, { action: 'set', value: PRODUCT_TRACKER_SECRET })
    if (!saved.ok) throw new Error(`demo scenario: ${saved.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  }
  const profile = await configuration.saveProfile(productProfile(folder))
  if (!profile.ok) throw new Error(`demo scenario: ${profile.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  const active = await configuration.setActiveProfile(PRODUCT_PROFILE_ID)
  if (!active.ok) throw new Error(`demo scenario: ${active.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
  // No first-run welcome: the profile is ready.
  await configuration.saveOptions({ welcomeDone: true })
  return true
}

/** Weeks of synthetic usage history the demo seeds. */
export const DEMO_ANALYTICS_WEEKS = 4

/**
 * Seeds weeks of synthetic sessions, turns, links, tags, automation runs and PR/ticket events, so
 * the usage reports have something to show. Only into a database without sessions; returns whether it seeded.
 * Folders sit under `folder` (the demo's data folder, which the demo profile owns).
 */
export function seedScenarioAnalytics(db: WorkhubDb, folder: string = process.cwd(), now: number = Date.now()): boolean {
  const has = db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
  if (Number(has.n) > 0) return false
  // A small fixed pseudo-random sequence: the same history on every machine.
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const projects = ['notes-api', 'notes-web', 'notes-mobile'].map((p) => join(folder, p))
  const models = [
    { agent: 'claude', model: 'claude-sonnet-4-5', inPrice: 3, outPrice: 15 },
    { agent: 'claude', model: 'claude-opus-4-1', inPrice: 15, outPrice: 75 },
    { agent: 'codex', model: 'gpt-5', inPrice: 1.25, outPrice: 10 }
  ]
  const tags = ['spike', 'refactor', 'onboarding', 'perf']
  const records = new SessionRecords(db, () => now)
  const runs = new AutomationRunLog(db)
  const timelines = new Timelines(db)
  const DAY = 86_400_000
  const start = now - DEMO_ANALYTICS_WEEKS * 7 * DAY
  db.transaction(() => {
    const insertSession = db.raw.prepare("INSERT INTO sessions (id, agent, account_id, profile_id, cwd, work_path, title, started_at, last_model, source, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'workhub', ?)")
    const insertTurn = db.raw.prepare('INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    let n = 0
    for (let day = start; day < now; day += DAY) {
      const weekday = new Date(day).getDay()
      if (weekday === 0 || weekday === 6) continue
      const count = 1 + Math.floor(rand() * 3)
      for (let i = 0; i < count; i++) {
        n++
        const id = `demo-session-${n}`
        const m = pick(models)
        const cwd = pick(projects)
        const ticket = `${PRODUCT_PROJECT}-${100 + Math.floor(rand() * 30)}`
        let at = day + (9 + Math.floor(rand() * 8)) * 3_600_000
        insertSession.run(id, m.agent, PRODUCT_PROFILE_ID, cwd, cwd, `Work on ${ticket}`, at, m.model, now)
        const turns = 5 + Math.floor(rand() * 20)
        for (let t = 0; t < turns; t++) {
          const ms = Math.floor(5_000 + rand() * 240_000)
          at += ms
          const input = Math.floor(200 + rand() * 4_000)
          const output = Math.floor(100 + rand() * 2_500)
          const cacheRead = Math.floor(rand() * 60_000)
          const usd = (input * m.inPrice + output * m.outPrice + cacheRead * m.inPrice * 0.1) / 1e6
          insertTurn.run(id, m.agent, `m${t}`, at, m.model, input, output, 0, cacheRead, usd, cwd, cwd, ms)
        }
        refreshSessionTotals(db, id)
        records.addLinks(id, [
          { kind: 'ticket', ref: ticket, source: 'user' },
          { kind: 'branch', ref: `feat/${ticket.toLowerCase()}`, source: 'git' },
          ...(rand() < 0.6 ? [{ kind: 'pr' as const, ref: `https://example.com/acme/${cwd.split(/[\\/]/).pop()}/pull/${n}`, source: 'acted' }] : [])
        ])
        if (rand() < 0.3) records.setTags(id, [pick(tags)])
        if (rand() < 0.4) timelines.appendTicketChanges(PRODUCT_PROFILE_ID, [{ kind: 'status', key: ticket, title: `Synthetic ticket ${ticket}`, from: 'To Do', to: 'In Progress' }], at)
      }
      runs.record(
        [{ id: `demo-run-${day}`, automationId: 'demo-triage', automationName: 'Morning triage', trigger: 'interval', queuedAt: day + 8 * 3_600_000, startedAt: day + 8 * 3_600_000, endedAt: day + 8 * 3_600_000 + 240_000, outcome: rand() < 0.9 ? 'ok' : 'error', merged: 0, tokens: Math.floor(5_000 + rand() * 20_000) }],
        () => PRODUCT_PROFILE_ID
      )
    }
    timelines.appendPrEvents(PRODUCT_PROFILE_ID, [
      { id: 'acme/notes-api#3|approved', kind: 'approved', url: 'https://example.com/acme/notes-api/pull/3', title: 'Synthetic change', name: 'notes-api#3', at: now - 5 * DAY },
      { id: 'acme/notes-api#3|merged', kind: 'merged', url: 'https://example.com/acme/notes-api/pull/3', title: 'Synthetic change', name: 'notes-api#3', at: now - 4 * DAY }
    ])
  })
  return true
}

/**
 * The demo's secret store. Its data is synthetic, so where the OS offers no keyring (a Linux CI
 * runner) a secret the store will not encrypt is kept in memory for the run, instead of failing to
 * seed the demo profile. Used only with a demo scenario; a real profile never keeps a secret this way.
 */
export function demoSecretStore(primary: SecretStore, unavailable: (err: unknown) => boolean): SecretStore {
  const memory = new Map<string, string>()
  const orElse = <T>(fallback: T) => (err: unknown): T => {
    if (unavailable(err)) return fallback
    throw err
  }
  return {
    get: async (ref) => memory.get(ref) ?? primary.get(ref).catch(orElse(null)),
    set: async (ref, value) => {
      const kept = await primary.set(ref, value).then(() => true, orElse(false))
      if (kept) memory.delete(ref)
      else memory.set(ref, value)
    },
    delete: async (ref) => {
      memory.delete(ref)
      await primary.delete(ref).catch(orElse(undefined))
    },
    has: async (ref) => memory.has(ref) || primary.has(ref).catch(orElse(false))
  }
}
