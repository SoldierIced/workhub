import { describe, expect, it } from 'vitest'
import {
  addDays,
  configSchema,
  connectionSecretRef,
  CONFIG_VERSION,
  dueActions,
  groupInbox,
  inboxSettings,
  localDay,
  milestoneProblems,
  milestoneStatus,
  openItemsOf,
  PRODUCT_ALERT_KEYS,
  PRODUCT_MILESTONE_EXPECTED,
  PRODUCT_PEOPLE,
  PRODUCT_PROFILE_ID,
  PRODUCT_TRACKER_ID,
  plannerSettings,
  productCalendarEvents,
  productConnections,
  productInbox,
  productMetricState,
  productMilestoneCounts,
  productMilestones,
  productProfile,
  validateConfig,
  type WorkhubConfig
} from '../src'

// A Wednesday, ten past ten.
const NOW = new Date(2026, 10, 4, 10, 10).getTime()
const TODAY = localDay(NOW)
const MIN = 60_000

const config = (): WorkhubConfig => ({ version: CONFIG_VERSION, connections: productConnections().map((c) => ({ ...c, secretRef: connectionSecretRef(c.id) })), agents: [], accounts: [], profiles: [productProfile('/tmp/demo-data')], activeProfileId: PRODUCT_PROFILE_ID })

describe('team-lead scenario: profile', () => {
  it('is valid against the config schema and the cross-reference rules', () => {
    expect(configSchema.safeParse(config()).success).toBe(true)
    expect(validateConfig(config())).toEqual([])
  })

  it('turns on planner, health and automations, with a folder, a tracker and the planner setup', () => {
    const p = productProfile('/tmp/demo-data')
    expect(p.name).toBe('Team lead (demo)')
    expect(p.modules).toMatchObject({ planner: true, health: true, automations: true })
    expect(p.defaultFolder).toBe('/tmp/demo-data')
    expect(p.connections.tracker).toBe(PRODUCT_TRACKER_ID)
    const s = plannerSettings(p)
    expect(s.people).toHaveLength(6)
    expect(s.people.every((x) => x.emails[0]?.endsWith('@example.com'))).toBe(true)
    const inbox = inboxSettings(s)
    expect(inbox.areas).toEqual(['Activation', 'Editor', 'Billing', 'Integrations', 'Platform', 'General'])
    expect(inbox.criticalities.map((c) => [c.name, c.priority])).toEqual([['Critical', 1], ['High', 2], ['Medium', 3], ['Low', 4]])
    expect(inbox.project).toBe('NOTE')
    expect(inbox.issueTypes).toEqual({ task: 'Task', bug: 'Bug' })
    expect(inbox.descriptionTemplate).toContain('{detail}')
    expect(s.rules.map((r) => [r.action, r.leadMinutes, r.match.titleContains ?? []])).toEqual([['remind', 10, []], ['brief', 30, ['1:1']], ['brief', 15, ['Daily standup']]])
  })
})

describe('team-lead scenario: calendar', () => {
  const events = productCalendarEvents(NOW)
  const settings = plannerSettings(productProfile('/tmp/demo-data'))

  it('has today and tomorrow, with people from the list and video links', () => {
    const emails = new Set(PRODUCT_PEOPLE.flatMap((p) => p.emails))
    const days = new Set(events.map((e) => localDay(e.start)))
    expect(days.has(TODAY)).toBe(true)
    expect(days.has(addDays(TODAY, 1))).toBe(true)
    const titles = events.map((e) => e.title)
    for (const t of ['Daily standup', 'Activation metrics review', 'Roadmap check-in with the founder', 'Backlog refinement', 'Support sync']) expect(titles).toContain(t)
    expect(titles.some((t) => t.startsWith('1:1'))).toBe(true)
    for (const e of events) expect(e.attendees.filter((a) => a.email !== 'alex.morgan@example.com').every((a) => emails.has(a.email))).toBe(true)
    expect(events.filter((e) => e.meetingUrl).length).toBeGreaterThanOrEqual(5)
    expect(events.some((e) => e.recurring && e.title === 'Daily standup')).toBe(true)
  })

  it('starts a meeting within 20 minutes of launch, whatever the time', () => {
    for (const hour of [0, 7, 10, 13, 17, 23]) {
      const now = new Date(2026, 10, 4, hour, 3).getTime()
      const next = productCalendarEvents(now).filter((e) => e.start >= now).sort((a, b) => a.start - b.start)[0]!
      expect(next.start - now).toBeGreaterThanOrEqual(8 * MIN)
      expect(next.start - now).toBeLessThanOrEqual(20 * MIN)
    }
  })

  it('makes the rules fire at launch: a reminder, and a brief for the 1:1', () => {
    const due = dueActions(events, settings, NOW, () => false)
    const oneOnOne = events.find((e) => e.title.startsWith('1:1'))!
    expect(due.some((d) => d.action === 'remind' && d.event.id === oneOnOne.id)).toBe(true)
    expect(due.some((d) => d.action === 'brief' && d.event.id === oneOnOne.id && d.ruleId === 'rule-brief-one-on-one')).toBe(true)
  })

  it('matches the standup brief rule 15 minutes before the recurring standup', () => {
    const standup = events.find((e) => e.title === 'Daily standup' && e.start > NOW)!
    const due = dueActions(events, settings, standup.start - 15 * MIN, () => false)
    expect(due.some((d) => d.action === 'brief' && d.event.id === standup.id && d.ruleId === 'rule-brief-standup')).toBe(true)
  })
})

describe('team-lead scenario: milestones', () => {
  it('are valid and cover every status, on any day', () => {
    for (const offset of [0, 1, 3, 9, 20]) {
      const now = NOW + offset * 86_400_000
      const today = localDay(now)
      const milestones = productMilestones(today)
      const counts = productMilestoneCounts(milestones, now)
      expect(milestones.flatMap(milestoneProblems)).toEqual([])
      const statuses = Object.fromEntries(milestones.map((m) => [m.id, milestoneStatus(m, counts[m.id], today).status]))
      expect(statuses).toEqual(PRODUCT_MILESTONE_EXPECTED)
    }
    expect(new Set(Object.values(PRODUCT_MILESTONE_EXPECTED))).toEqual(new Set(['onTrack', 'atRisk', 'late', 'notStarted', 'done']))
  })

  it('include one manual and tracker ones for NOTE, WEB and OPS', () => {
    const ms = productMilestones(TODAY)
    expect(ms.filter((m) => m.source.kind === 'manual')).toHaveLength(1)
    const queries = ms.flatMap((m) => (m.source.kind === 'tracker' ? [m.source.query] : []))
    for (const p of ['NOTE', 'WEB', 'OPS']) expect(queries.some((q) => q.includes(`project = ${p}`))).toBe(true)
  })
})

describe('team-lead scenario: inbox', () => {
  const state = productMetricState(NOW)
  const items = productInbox(NOW, state.alerts.find((a) => a.key === PRODUCT_ALERT_KEYS.risingError))
  const levels = inboxSettings(plannerSettings(productProfile('/tmp/demo-data'))).criticalities
  const groups = groupInbox(items, TODAY, levels)

  it('has pending items that came from meetings, a decision and a bug drafted from an alert', () => {
    const meeting = groups.pending.filter((i) => i.source.type === 'meeting')
    expect(meeting.map((i) => [i.title, i.source.label])).toEqual(
      expect.arrayContaining([
        ['Draft empty-state copy for new workspaces', 'Activation metrics review'],
        ['Ask data for activation by signup source', 'Roadmap check-in with the founder']
      ])
    )
    expect(meeting.some((i) => i.kind === 'decision' && i.title === 'Roll out the new editor toolbar to 20% of teams')).toBe(true)
    const fromAlert = groups.pending.find((i) => i.source.type === 'alert')
    expect(fromAlert?.kind).toBe('bug')
    expect(fromAlert?.source.ref).toBe(PRODUCT_ALERT_KEYS.risingError)
  })

  it('has local tasks (overdue, due today, critical, others), approved tickets and decisions', () => {
    expect(groups.tasks.due.some((i) => i.due! < TODAY)).toBe(true)
    expect(groups.tasks.due.some((i) => i.due === TODAY)).toBe(true)
    expect(groups.tasks.urgent.some((i) => i.criticality === 'Critical')).toBe(true)
    expect(groups.tasks.rest.length).toBeGreaterThanOrEqual(2)
    expect(groups.closed.filter((i) => i.status === 'ticket').map((i) => i.ticket?.key)).toEqual(expect.arrayContaining([expect.stringMatching(/^(NOTE|WEB)-\d+$/)]))
    expect(groups.closed.filter((i) => i.status === 'ticket')).toHaveLength(2)
    expect(groups.decisions).toHaveLength(2)
  })

  it('links items to people, so People shows open items', () => {
    const open = PRODUCT_PEOPLE.map((p) => openItemsOf(items, p.id).length)
    expect(open.every((n) => n > 0)).toBe(true)
  })

  it('uses unique ids and only known areas and criticalities', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    const settings = inboxSettings(plannerSettings(productProfile('/tmp/demo-data')))
    for (const i of items) {
      if (i.area) expect(settings.areas).toContain(i.area)
      if (i.criticality) expect(levels.map((l) => l.name)).toContain(i.criticality)
    }
  })
})

describe('team-lead scenario: metric alerts', () => {
  const alerts = productMetricState(NOW).alerts
  const by = (key: string) => alerts.find((a) => a.key === key)!

  it('shows a high and a medium funnel drop', () => {
    expect(by(PRODUCT_ALERT_KEYS.workspaceDrop)).toMatchObject({ kind: 'rateDrop', severity: 'high' })
    expect(by(PRODUCT_ALERT_KEYS.workspaceDrop).changePoints).toBeLessThan(-10)
    expect(by(PRODUCT_ALERT_KEYS.inviteDrop)).toMatchObject({ kind: 'rateDrop', severity: 'medium' })
    const points = by(PRODUCT_ALERT_KEYS.inviteDrop).changePoints!
    expect(points).toBeLessThan(-5)
    expect(points).toBeGreaterThan(-10)
  })

  it('shows a sustained rise, a jump above 100 %, a new reason and a rising front-end error', () => {
    expect(by(PRODUCT_ALERT_KEYS.sustainedReason)).toMatchObject({ kind: 'sustainedTrend' })
    expect(by(PRODUCT_ALERT_KEYS.jumpReason)).toMatchObject({ kind: 'jump', severity: 'high' })
    expect(by(PRODUCT_ALERT_KEYS.jumpReason).changePct).toBeGreaterThan(100)
    expect(by(PRODUCT_ALERT_KEYS.newReason)).toMatchObject({ kind: 'newSubject' })
    expect(by(PRODUCT_ALERT_KEYS.risingError)).toMatchObject({ kind: 'jump' })
  })

  it('reports a key event with missing data, with labels and example links', () => {
    expect(by(PRODUCT_ALERT_KEYS.missingEvent)).toMatchObject({ kind: 'missingData', label: 'Key event: workspace_created' })
    for (const key of Object.values(PRODUCT_ALERT_KEYS)) {
      const a = by(key)
      expect(a.label).toBeTruthy()
      expect(a.link).toMatch(/^https:\/\/analytics\.example\.com\//)
    }
  })

  it('is in mixed states: new, tracking, snoozed and one proposing to resolve', () => {
    expect(new Set(alerts.map((a) => a.status))).toEqual(new Set(['new', 'tracking', 'snoozed']))
    expect(by(PRODUCT_ALERT_KEYS.workspaceDrop).status).toBe('tracking')
    expect(by(PRODUCT_ALERT_KEYS.jumpReason).status).toBe('snoozed')
    expect(by(PRODUCT_ALERT_KEYS.quietError)).toMatchObject({ proposeResolve: true })
    expect(alerts.filter((a) => a.proposeResolve)).toHaveLength(1)
  })

  it('keeps the Elastic-style demo signals', () => {
    expect(alerts.some((a) => a.source === 'demo')).toBe(true)
  })

  it('shows the same stories on every working day', () => {
    for (const day of [2, 3, 4, 5, 6]) {
      const kinds = productMetricState(new Date(2026, 10, day, 10).getTime()).alerts.filter((a) => a.source === 'analytics').map((a) => `${a.metric}/${a.subject}:${a.kind}:${a.severity}`)
      expect(kinds).toEqual(expect.arrayContaining(['funnel.verifyWorkspace/Signup funnel:rateDrop:high', 'funnel.workspaceInvite/Signup funnel:rateDrop:medium', 'cancellations.byReason/Too many bugs:sustainedTrend:medium']))
    }
  })
})
