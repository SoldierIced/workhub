import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { JsonConfigStore } from '@workhub/adapters/config-json'
import { ConfigurationService, configSchema, DEFAULT_ALERT_RULES, PRODUCT_PROFILE_ID, PRODUCT_TRACKER_SECRET, validateConfig, type SecretStore } from '@workhub/core'
import { demoScenario, METRIC_ALERTS_FILE, PLANNER_STATE_FILE, seedScenarioConfig, seedScenarioState } from '../src/main/demo-scenario'
import { DemoMetricSource, MetricAlertService, ProductMetricSource, type MetricAlertsState } from '../src/main/metric-alerts'
import { PlannerService, type PlannerState } from '../src/main/planner-service'

const NOW = new Date(2026, 10, 4, 10, 10).getTime()
const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-demo-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, get: async (r) => values.get(r) ?? null, set: async (r, v) => void values.set(r, v), delete: async (r) => void values.delete(r), has: async (r) => values.has(r) }
}

describe('demoScenario', () => {
  it('selects the team-lead scenario only by its name', () => {
    expect(demoScenario({ WORKHUB_DEMO_SCENARIO: 'team-lead' })).toBe('team-lead')
    expect(demoScenario({ WORKHUB_DEMO_SCENARIO: 'other' })).toBeNull()
    expect(demoScenario({})).toBeNull()
  })
})

describe('seedScenarioConfig', () => {
  it('writes a valid config with the profile active, through the configuration service', async () => {
    const dir = tmp()
    const secrets = memorySecrets()
    const configuration = new ConfigurationService(new JsonConfigStore(join(dir, 'config.json')), secrets)
    expect(await seedScenarioConfig(configuration, dir)).toBe(true)
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    const parsed = configSchema.parse(stored)
    expect(validateConfig(parsed)).toEqual([])
    expect(parsed.activeProfileId).toBe(PRODUCT_PROFILE_ID)
    expect(parsed.profiles[0]).toMatchObject({ name: 'Team lead (demo)', defaultFolder: dir, modules: { planner: true, health: true, automations: true } })
    expect(parsed.options?.welcomeDone).toBe(true)
    expect([...secrets.values.values()]).toEqual([PRODUCT_TRACKER_SECRET])
  })

  it('leaves an existing config alone', async () => {
    const dir = tmp()
    const configuration = new ConfigurationService(new JsonConfigStore(join(dir, 'config.json')), memorySecrets())
    expect(await seedScenarioConfig(configuration, dir)).toBe(true)
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const again = new ConfigurationService(new JsonConfigStore(join(dir, 'config.json')), memorySecrets())
    expect(await seedScenarioConfig(again, dir)).toBe(false)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
  })
})

describe('seedScenarioState', () => {
  it('writes the planner and metric alert files once and keeps them afterwards', () => {
    const dir = tmp()
    expect(seedScenarioState(dir, NOW)).toEqual([join(dir, METRIC_ALERTS_FILE), join(dir, PLANNER_STATE_FILE)])
    const planner = JSON.parse(readFileSync(join(dir, PLANNER_STATE_FILE), 'utf8')) as PlannerState
    const metrics = JSON.parse(readFileSync(join(dir, METRIC_ALERTS_FILE), 'utf8')) as MetricAlertsState
    const p = planner.profiles[PRODUCT_PROFILE_ID]!
    expect(p.milestones).toHaveLength(7)
    expect(Object.keys(p.counts)).toHaveLength(5)
    // The pieces' tickets and those of the items in the tracker are seeded, so they show before the first read.
    expect(Object.keys(p.tickets).sort()).toEqual(['acme-notes-tracker-demo|NOTE-252', 'acme-notes-tracker-demo|NOTE-255', 'acme-notes-tracker-demo|WEB-34', '|NOTE-238', '|NOTE-253'])
    expect(p.inbox.some((i) => i.source.type === 'alert')).toBe(true)
    expect(metrics.profiles[PRODUCT_PROFILE_ID]!.alerts.length).toBeGreaterThan(8)
    writeFileSync(join(dir, PLANNER_STATE_FILE), '{"profiles":{}}')
    expect(seedScenarioState(dir, NOW)).toEqual([])
    expect(readFileSync(join(dir, PLANNER_STATE_FILE), 'utf8')).toBe('{"profiles":{}}')
  })
})

describe('the seeded scenario through the services', () => {
  const profile = async () => {
    const dir = tmp()
    const configuration = new ConfigurationService(new JsonConfigStore(join(dir, 'config.json')), memorySecrets())
    await seedScenarioConfig(configuration, dir)
    seedScenarioState(dir, NOW)
    return { dir, profiles: async () => (await configuration.current()).profiles }
  }

  it('shows every milestone status in the planner view, including after a refresh from the demo tracker', async () => {
    const { dir, profiles } = await profile()
    const stored = JSON.parse(readFileSync(join(dir, PLANNER_STATE_FILE), 'utf8')) as PlannerState
    const demo = new DemoTracker('jira', { scenario: 'team-lead' })
    const service = new PlannerService({ profiles, store: { load: () => stored, save: () => undefined }, tracker: async () => ({ tracker: demo }), changed: () => undefined, now: () => NOW })
    const statuses = (view: Awaited<ReturnType<typeof service.view>>) => Object.fromEntries(view.milestones.map((m) => [m.milestone.id, m.status]))
    const expected = { 'ms-sso': 'onTrack', 'ms-activation': 'atRisk', 'ms-billing': 'late', 'ms-offline': 'notStarted', 'ms-docs': 'done', 'ms-offsite': 'onTrack', 'ms-invites': 'onTrack' }
    expect(statuses(await service.view(PRODUCT_PROFILE_ID))).toEqual(expected)
    expect(statuses(await service.refreshMilestones(PRODUCT_PROFILE_ID))).toEqual(expected)
    const view = await service.view(PRODUCT_PROFILE_ID)
    expect(view.milestones.find((m) => m.milestone.id === 'ms-invites')).toMatchObject({ progress: 36 })
    expect(view.milestones.find((m) => m.milestone.id === 'ms-invites')!.pieces!.map((p) => p.state)).toEqual(['done', 'inProgress', 'todo', 'done'])
    // After a read from the demo tracker, the items in the tracker are still open with their tickets' states.
    expect(view.inbox.filter((i) => i.ticket).map((i) => [i.ticket!.key, i.status, view.itemTickets[i.id]?.category]).sort()).toEqual([
      ['NOTE-252', 'local', 'todo'],
      ['NOTE-255', 'ticket', 'inProgress'],
      ['WEB-34', 'ticket', 'todo']
    ])
    expect(view.tracker).toMatchObject({ search: true, create: true })
    expect(view.inbox.filter((i) => i.status === 'pending')).toHaveLength(4)
  })

  it('approving a pending item creates a NOTE issue in the demo tracker', async () => {
    const { dir, profiles } = await profile()
    const stored = JSON.parse(readFileSync(join(dir, PLANNER_STATE_FILE), 'utf8')) as PlannerState
    const demo = new DemoTracker('jira', { scenario: 'team-lead' })
    const service = new PlannerService({ profiles, store: { load: () => stored, save: () => undefined }, tracker: async () => ({ tracker: demo }), changed: () => undefined, now: () => NOW })
    const item = (await service.view(PRODUCT_PROFILE_ID)).inbox.find((i) => i.title === 'Draft empty-state copy for new workspaces')!
    const result = await service.act(PRODUCT_PROFILE_ID, item.id, 'approve')
    expect(result).toMatchObject({ ok: true, ticket: { key: 'NOTE-900' } })
    expect(demo.created[0]).toMatchObject({ project: 'NOTE', issueType: 'Task' })
  })

  it('keeps the seeded alert states when the engine evaluates the sources', async () => {
    const { dir } = await profile()
    const stored = JSON.parse(readFileSync(join(dir, METRIC_ALERTS_FILE), 'utf8')) as MetricAlertsState
    const before = stored.profiles[PRODUCT_PROFILE_ID]!.alerts
    const days = async () => [1, 2, 3, 4, 5]
    const service = new MetricAlertService({
      profiles: async () => [{ id: PRODUCT_PROFILE_ID, rules: DEFAULT_ALERT_RULES }],
      sources: () => [new DemoMetricSource(days), new ProductMetricSource(days)],
      store: { load: () => stored, save: () => undefined },
      notify: () => undefined,
      changed: () => undefined,
      demo: true,
      now: () => NOW
    })
    const view = await service.refresh(PRODUCT_PROFILE_ID)
    const status = (alerts: { key: string; status: string }[]) => Object.fromEntries(alerts.map((a) => [a.key, a.status]))
    expect(status(view.alerts)).toEqual(status(before))
    expect(view.alerts.filter((a) => a.proposeResolve)).toHaveLength(1)
  })
})

