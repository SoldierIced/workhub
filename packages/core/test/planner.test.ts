import { describe, expect, it } from 'vitest'
import {
  alertInboxProposal,
  applyAlertAction,
  applyInboxAction,
  availableAlertActions,
  availableInboxActions,
  bulkEditInbox,
  cleanCriticalities,
  cleanupInbox,
  CONFIG_VERSION,
  countByCategory,
  countsKey,
  filterInbox,
  findDuplicate,
  moveInboxItem,
  groupInbox,
  inboxDueBy,
  inboxSettings,
  INBOX_LIMITS,
  isAlertAction,
  matchPeople,
  milestoneProblems,
  milestoneStatus,
  newInboxItem,
  normalizeTitle,
  openItemsOf,
  parseConfig,
  parseInboxProposals,
  parseMilestone,
  parsePlanLinks,
  PLAN_LINK_LIMITS,
  renderInboxDescription,
  searchLimit,
  sortMilestones,
  withTicket,
  followsTicket,
  isOpenItem,
  linkTicket,
  markTicketDone,
  parsePieces,
  parseTicketKey,
  pieceShares,
  pieceTally,
  pieceViews,
  piecesOk,
  ticketStateKey,
  trackedState,
  type MilestonePiece,
  type TrackedTicket,
  type InboxItem,
  type MetricAlert,
  type Milestone,
  type MilestoneProposal,
  applyMilestoneProposal,
  DEFAULT_AGENT_MILESTONE_MODE,
  patchMilestone
} from '@workhub/core'

const DAY = 86_400_000
const manual = (progress: number, start = '2026-11-01', end = '2026-11-11'): Milestone => ({ id: 'm', name: 'M', start, end, source: { kind: 'manual', progress } })
const tracked = (start = '2026-11-01', end = '2026-11-11'): Milestone => ({ id: 't', name: 'T', start, end, source: { kind: 'tracker', query: 'project = PAY' } })

describe('milestoneStatus', () => {
  it('is not started before its start, with nothing elapsed', () => {
    expect(milestoneStatus(manual(0), undefined, '2026-10-30')).toEqual({ status: 'notStarted', progress: 0, elapsed: 0 })
  })

  it('is on track while progress keeps up with time, within the margin', () => {
    // Day 5 of a 10-day span: 50 % elapsed.
    expect(milestoneStatus(manual(45), undefined, '2026-11-06')).toEqual({ status: 'onTrack', progress: 45, elapsed: 50 })
    expect(milestoneStatus(manual(40), undefined, '2026-11-06').status).toBe('onTrack')
  })

  it('is at risk when progress is behind elapsed time by more than the margin', () => {
    expect(milestoneStatus(manual(39), undefined, '2026-11-06').status).toBe('atRisk')
    expect(milestoneStatus(manual(39), undefined, '2026-11-06', 20).status).toBe('onTrack')
  })

  it('is at risk when a counted query finds no ticket once started', () => {
    expect(milestoneStatus(tracked(), { total: 0, done: 0 }, '2026-11-01').status).toBe('atRisk')
    expect(milestoneStatus(tracked(), undefined, '2026-11-01').status).toBe('onTrack')
  })

  it('counts tracker progress from done tickets, and is done when all are', () => {
    expect(milestoneStatus(tracked(), { total: 8, done: 6 }, '2026-11-06')).toEqual({ status: 'onTrack', progress: 75, elapsed: 50 })
    expect(milestoneStatus(tracked(), { total: 4, done: 4 }, '2026-12-01').status).toBe('done')
  })

  it('is late past its end when not done, and done at 100 % whatever the date', () => {
    expect(milestoneStatus(manual(90), undefined, '2026-11-12')).toEqual({ status: 'late', progress: 90, elapsed: 100 })
    expect(milestoneStatus(manual(100), undefined, '2026-11-12').status).toBe('done')
    expect(milestoneStatus(manual(100), undefined, '2026-10-01').status).toBe('done')
  })

  it('handles a one-day milestone', () => {
    expect(milestoneStatus(manual(0, '2026-11-05', '2026-11-05'), undefined, '2026-11-05')).toEqual({ status: 'atRisk', progress: 0, elapsed: 100 })
  })

  it('sorts by severity, then nearest end', () => {
    const rows = [
      { milestone: { name: 'b', end: '2026-12-01' }, status: 'onTrack' as const },
      { milestone: { name: 'a', end: '2026-11-20' }, status: 'onTrack' as const },
      { milestone: { name: 'c', end: '2026-12-30' }, status: 'late' as const },
      { milestone: { name: 'd', end: '2026-10-01' }, status: 'done' as const },
      { milestone: { name: 'e', end: '2026-12-30' }, status: 'atRisk' as const }
    ]
    expect(sortMilestones(rows).map((r) => r.milestone.name)).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('validates and parses milestones from untrusted input', () => {
    expect(milestoneProblems({ ...manual(0), end: '2026-10-01' })).toContain('order')
    expect(milestoneProblems({ ...manual(120) })).toContain('progress')
    expect(milestoneProblems({ ...tracked(), source: { kind: 'tracker', query: ' ' } })).toContain('query')
    expect(milestoneProblems({ ...manual(0), link: 'javascript:alert(1)' })).toContain('link')
    expect(parseMilestone({ id: 'x', name: ' Launch ', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: ' label = launch ', connectionId: '' } })).toEqual({
      id: 'x',
      name: 'Launch',
      start: '2026-11-01',
      end: '2026-11-30',
      source: { kind: 'tracker', query: 'label = launch' }
    })
    expect(parseMilestone({ id: 'x', name: 'n', start: '2026-02-30', end: '2026-03-01', source: { kind: 'manual', progress: 1 } })).toBeNull()
    expect(parseMilestone('nope')).toBeNull()
    expect(countsKey(tracked())).toBe('|project = PAY')
    expect(countsKey(manual(1))).toBeNull()
  })
})

describe('tracker helpers', () => {
  it('counts tickets by category and clamps the search limit', () => {
    expect(countByCategory([{ category: 'done' }, { category: 'todo' }, { category: 'done' }])).toEqual({ total: 3, todo: 1, inProgress: 0, done: 2 })
    expect(searchLimit()).toBe(200)
    expect(searchLimit({ limit: 0 })).toBe(1)
    expect(searchLimit({ limit: 99_999 })).toBe(1000)
  })
})

const item = (over: Partial<InboxItem> = {}): InboxItem => ({ id: 'i1', kind: 'task', title: 'Fix the export', detail: '', source: { type: 'manual' }, status: 'pending', createdAt: 1_000, ...over })
const LEVELS = [
  { name: 'Critical', priority: 1 as const },
  { name: 'High', priority: 2 as const },
  { name: 'Normal', priority: 3 as const }
]

describe('inbox', () => {
  it('normalizes titles and finds duplicates among open items only', () => {
    expect(normalizeTitle('  Fíx the EXPORT!! ')).toBe('fix the export')
    const items = [item({ id: 'a', title: 'Fix the export.' }), item({ id: 'b', title: 'Other', status: 'done', closedAt: 5 }), item({ id: 'c', title: 'Alert', source: { type: 'alert', ref: 'k1' } })]
    expect(findDuplicate(items, { title: 'fix  the EXPORT' })?.id).toBe('a')
    expect(findDuplicate(items, { title: 'other' })).toBeUndefined()
    expect(findDuplicate(items, { title: 'Renamed', source: { type: 'alert', ref: 'k1' } })?.id).toBe('c')
    // One session (or meeting) proposes several items: its ref alone is no duplicate.
    const fromSession = [item({ id: 's1', title: 'First follow-up', source: { type: 'agent', ref: 'session-1' } }), item({ id: 'm1', title: 'Meeting note', source: { type: 'meeting', ref: 'session-1' } })]
    expect(findDuplicate(fromSession, { title: 'Second follow-up', source: { type: 'agent', ref: 'session-1' } })).toBeUndefined()
    expect(findDuplicate(fromSession, { title: 'Another note', source: { type: 'meeting', ref: 'session-1' } })).toBeUndefined()
    expect(findDuplicate(fromSession, { title: 'first follow-up!', source: { type: 'agent', ref: 'session-2' } })?.id).toBe('s1')
    // Only the most recent open items are compared.
    expect(findDuplicate([item({ title: 'Fix the export', createdAt: 1 }), item({ id: 'z', title: 'z', createdAt: 2 })], { title: 'fix the export' }, 1)).toBeUndefined()
  })

  it('groups pending, local tasks by urgency, decisions and closed items', () => {
    const items = [
      item({ id: 'p1', createdAt: 1 }),
      item({ id: 'p2', createdAt: 2 }),
      item({ id: 'due', status: 'local', due: '2026-11-01' }),
      item({ id: 'over', status: 'local', due: '2026-10-20' }),
      item({ id: 'crit', status: 'local', criticality: 'Critical', due: '2026-12-01' }),
      item({ id: 'norm', status: 'local', criticality: 'Normal' }),
      item({ id: 'dec', kind: 'decision', status: 'local' }),
      item({ id: 'gone', status: 'discarded', closedAt: 9 })
    ]
    const g = groupInbox(items, '2026-11-01', LEVELS)
    expect(g.pending.map((i) => i.id)).toEqual(['p2', 'p1'])
    expect(g.tasks.due.map((i) => i.id)).toEqual(['over', 'due'])
    expect(g.tasks.urgent.map((i) => i.id)).toEqual(['crit'])
    expect(g.tasks.rest.map((i) => i.id)).toEqual(['norm'])
    expect(g.decisions.map((i) => i.id)).toEqual(['dec'])
    expect(g.closed.map((i) => i.id)).toEqual(['gone'])
  })

  it('lists the approved tasks and bugs due today or overdue, overdue first (the menu bar panel)', () => {
    const items = [
      item({ id: 'pending', due: '2026-11-01' }),
      item({ id: 'due', status: 'local', due: '2026-11-01', createdAt: 1 }),
      item({ id: 'over', status: 'ticket', kind: 'bug', due: '2026-10-20' }),
      item({ id: 'later', status: 'local', due: '2026-11-02' }),
      item({ id: 'none', status: 'local' }),
      item({ id: 'dec', kind: 'decision', status: 'local', due: '2026-11-01' }),
      item({ id: 'done', status: 'done', due: '2026-11-01', closedAt: 9 })
    ]
    expect(inboxDueBy(items, '2026-11-01').map((i) => i.id)).toEqual(['over', 'due'])
  })

  it('prunes closed items a week after they closed, never open ones', () => {
    const now = 100 * DAY
    const items = [item({ id: 'old', status: 'done', closedAt: now - 8 * DAY }), item({ id: 'recent', status: 'ticket', closedAt: now - 2 * DAY }), item({ id: 'open', createdAt: 0 }), item({ id: 'dec', kind: 'decision', status: 'local', createdAt: 0 })]
    expect(cleanupInbox(items, now).map((i) => i.id)).toEqual(['recent', 'open', 'dec'])
  })

  it('caps the stored items by dropping the oldest closed ones', () => {
    const many = Array.from({ length: INBOX_LIMITS.items + 2 }, (_, n) => item({ id: `c${n}`, status: 'done', closedAt: 1_000 + n }))
    const kept = cleanupInbox(many, 2_000)
    expect(kept).toHaveLength(INBOX_LIMITS.items)
    expect(kept[0]!.id).toBe('c2')
  })

  it('moves items through their actions', () => {
    expect(availableInboxActions(item())).toEqual(['approve', 'keep', 'discard'])
    expect(applyInboxAction(item(), 'keep', 5)?.status).toBe('local')
    expect(applyInboxAction(item(), 'approve', 5)).toBeNull()
    expect(applyInboxAction(item({ kind: 'decision' }), 'approve', 5)?.status).toBe('local')
    const done = applyInboxAction(item({ status: 'local' }), 'done', 5)!
    expect(done).toMatchObject({ status: 'done', closedAt: 5 })
    expect(applyInboxAction(done, 'reopen', 6)).toEqual(item({ status: 'local' }))
    expect(applyInboxAction(item({ status: 'discarded', closedAt: 3 }), 'reopen', 6)?.status).toBe('pending')
    expect(applyInboxAction(item({ status: 'ticket' }), 'discard', 6)).toBeNull()
    const sent = withTicket(item(), { key: 'PAY-123', url: 'https://tracker.example.com/PAY-123', connectionId: 'jira' })
    expect(sent).toMatchObject({ status: 'ticket', ticket: { key: 'PAY-123', connectionId: 'jira' } })
    // Still open: it is followed in the tracker until the ticket is done.
    expect(sent.closedAt).toBeUndefined()
    expect(availableInboxActions(sent)).toEqual(['done'])
  })

  it('links a local task or bug to an existing ticket, and unlinks it', () => {
    const local = item({ status: 'local' })
    const linked = linkTicket(local, { key: 'PAY-7' })!
    expect(linked).toMatchObject({ status: 'local', ticket: { key: 'PAY-7' } })
    expect(followsTicket(linked)).toBe(true)
    expect(linkTicket(linked, null)).toEqual(local)
    // Unlinking an item sent to the tracker keeps it as a local task.
    expect(linkTicket(item({ status: 'ticket', ticket: { key: 'PAY-8' } }), null)).toMatchObject({ status: 'local' })
    expect(linkTicket(item({ status: 'ticket', ticket: { key: 'PAY-8' } }), null)!.ticket).toBeUndefined()
    expect(linkTicket(item(), { key: 'PAY-7' })).toBeNull()
    expect(linkTicket(item({ status: 'done' }), { key: 'PAY-7' })).toBeNull()
    expect(linkTicket(item({ kind: 'decision', status: 'local' }), { key: 'PAY-7' })).toBeNull()
  })

  it('marks an item that follows its ticket done, and nothing else', () => {
    expect(markTicketDone(item({ status: 'ticket', ticket: { key: 'PAY-1' } }), 9)).toMatchObject({ status: 'done', closedAt: 9, ticket: { key: 'PAY-1' } })
    expect(markTicketDone(item({ status: 'local', ticket: { key: 'PAY-1' } }), 9)?.status).toBe('done')
    expect(markTicketDone(item({ status: 'local' }), 9)).toBeNull()
    expect(markTicketDone(item({ status: 'done', ticket: { key: 'PAY-1' } }), 9)).toBeNull()
  })

  it('keeps items with a ticket open and in the tracker group, old ones included', () => {
    // An item sent to the tracker before this change carries a closedAt: it still shows, and is not pruned.
    const old = item({ id: 'old', status: 'ticket', ticket: { key: 'PAY-2' }, closedAt: 1 })
    const linked = item({ id: 'linked', status: 'local', ticket: { key: 'PAY-3' }, due: '2026-10-01' })
    const g = groupInbox([old, linked, item({ id: 'plain', status: 'local' })], '2026-11-01', LEVELS)
    expect(g.tasks.tracker.map((i) => i.id)).toEqual(['linked', 'old'])
    expect(g.tasks.due).toEqual([])
    expect(g.closed).toEqual([])
    expect(isOpenItem(old)).toBe(true)
    expect(cleanupInbox([old], 100 * DAY).map((i) => i.id)).toEqual(['old'])
  })

  it('never prunes the items a milestone is made of', () => {
    const now = 100 * DAY
    const items = [item({ id: 'piece', status: 'done', closedAt: now - 30 * DAY }), item({ id: 'other', status: 'done', closedAt: now - 30 * DAY })]
    expect(cleanupInbox(items, now, new Set(['piece'])).map((i) => i.id)).toEqual(['piece'])
  })

  it('moves an item to a status with local actions only, never to the tracker', () => {
    const pending = item()
    expect(moveInboxItem(pending, 'pending', 5)).toBe(pending)
    expect(moveInboxItem(pending, 'local', 5)?.status).toBe('local')
    expect(moveInboxItem(pending, 'done', 5)).toMatchObject({ status: 'done', closedAt: 5 })
    expect(moveInboxItem(pending, 'discarded', 5)).toMatchObject({ status: 'discarded', closedAt: 5 })
    expect(moveInboxItem(item({ status: 'done', closedAt: 3 }), 'local', 6)).toEqual(item({ status: 'local' }))
    expect(moveInboxItem(item({ status: 'discarded', closedAt: 3 }), 'done', 6)).toMatchObject({ status: 'done', closedAt: 6 })
    expect(moveInboxItem(item({ status: 'local' }), 'pending', 6)).toBeNull()
    expect(moveInboxItem(item({ kind: 'decision', status: 'local' }), 'done', 6)).toBeNull()
    expect(moveInboxItem(item({ kind: 'decision' }), 'done', 6)).toBeNull()
    expect(moveInboxItem(item({ status: 'ticket' }), 'done', 6)).toBeNull()
    expect(moveInboxItem(pending, 'ticket', 6)).toBeNull()
  })

  it('bulk edits only the selected items, clearing with null', () => {
    const items = [item({ id: 'a', area: 'Backend' }), item({ id: 'b' })]
    const next = bulkEditInbox(items, ['a'], { area: null, criticality: 'High', due: '2026-11-03' })
    expect(next[0]).toEqual({ ...item({ id: 'a' }), criticality: 'High', due: '2026-11-03' })
    expect(next[1]).toBe(items[1])
  })

  it('filters by kind, area, status and text', () => {
    const items = [item({ id: 'a', kind: 'bug', area: 'Mobile' }), item({ id: 'b', kind: 'decision', title: 'Use cursor pagination', status: 'local' })]
    expect(filterInbox(items, { kind: 'bug' }).map((i) => i.id)).toEqual(['a'])
    expect(filterInbox(items, { area: 'Mobile', status: 'all' }).map((i) => i.id)).toEqual(['a'])
    expect(filterInbox(items, { text: 'PAGINATION' }).map((i) => i.id)).toEqual(['b'])
  })

  it('renders the issue description from the template', () => {
    const it1 = item({ detail: 'Steps here', link: 'https://dash.example.com/x', source: { type: 'alert', label: 'Order errors' } })
    expect(renderInboxDescription('', it1)).toBe('Steps here\n\nSource: Metric alert: Order errors\nhttps://dash.example.com/x')
    expect(renderInboxDescription('{title} — {unknown} {source}', item())).toBe('Fix the export — {unknown} Added by hand')
    expect(renderInboxDescription('', item())).toBe('Source: Added by hand')
  })

  it('parses proposals from the control endpoint, checked and capped', () => {
    expect(parseInboxProposals({ kind: 'bug', title: '  Crash\non save ', detail: 'x', due: '2026-11-05', people: ['ana@example.com'] })).toEqual({
      ok: true,
      items: [{ kind: 'bug', title: 'Crash on save', detail: 'x', due: '2026-11-05', people: ['ana@example.com'] }]
    })
    expect(parseInboxProposals({ items: [{ title: 'a' }], source: 'Weekly sync' })).toEqual({ ok: true, items: [{ kind: 'task', title: 'a', detail: '' }], label: 'Weekly sync' })
    expect(parseInboxProposals({ items: [{ title: 'a' }, { kind: 'epic', title: 'b' }] })).toEqual({ ok: false, error: 'item 2: "kind" must be task, bug or decision' })
    expect(parseInboxProposals({ title: 'x'.repeat(301) }).ok).toBe(false)
    expect(parseInboxProposals({ title: 'a', due: 'tomorrow' }).ok).toBe(false)
    expect(parseInboxProposals({ title: 'a', link: 'file:///etc/passwd' }).ok).toBe(false)
    expect(parseInboxProposals(Array.from({ length: 21 }, () => ({ title: 'a' })))).toEqual({ ok: false, error: 'at most 20 items per request' })
    expect(parseInboxProposals(null).ok).toBe(false)
  })

  it('matches people by id, name or email and builds new items', () => {
    const people = [{ id: 'ana', name: 'Ana Costa', emails: ['ana@example.com'] }]
    expect(matchPeople(['ANA@example.com', 'ana costa', 'nobody'], people)).toEqual(['ana'])
    const created = newInboxItem({ kind: 'task', title: 'Follow up', detail: '', people: ['ana@example.com'] }, { type: 'agent', ref: 's1' }, 'id1', 42, people)
    expect(created).toEqual({ id: 'id1', kind: 'task', title: 'Follow up', detail: '', source: { type: 'agent', ref: 's1' }, people: ['ana'], status: 'pending', createdAt: 42 })
    expect(openItemsOf([created, { ...created, id: 'x', status: 'done' }], 'ana').map((i) => i.id)).toEqual(['id1'])
  })

  it('fills settings defaults and cleans criticality levels', () => {
    expect(inboxSettings({ inbox: { project: 'PAY', issueTypes: { task: 'Story' } as never } })).toMatchObject({ project: 'PAY', areas: [], issueTypes: { task: 'Story', bug: '' } })
    expect(cleanCriticalities([{ name: ' High ', priority: 2 }, { name: 'high', priority: 1 }, { name: '', priority: 3 }, { name: 'Odd', priority: 7 }])).toEqual([{ name: 'High', priority: 2 }])
  })

  it('keeps inbox settings and the milestone margin through the config schema', () => {
    const parsed = parseConfig({
      version: CONFIG_VERSION,
      profiles: [{ id: 'p', name: 'P', planner: { milestoneMargin: 250, inbox: { areas: ['Backend'], criticalities: [{ name: 'Critical', priority: 1 }], project: 'PAY' } } }]
    })
    expect(parsed.profiles[0]!.planner).toMatchObject({ milestoneMargin: 100, inbox: { areas: ['Backend'], project: 'PAY', issueTypes: { task: '', bug: '' }, trackerConnectionId: '' } })
  })
})

describe('metric alert → inbox', () => {
  const alert: MetricAlert = {
    key: 'acme|orders.errors|checkout-api|',
    kind: 'jump',
    severity: 'high',
    status: 'new',
    firstSeenDay: '2026-10-29',
    lastSeenDay: '2026-10-30',
    metric: 'orders.errors',
    label: 'Order errors',
    subject: 'checkout-api',
    source: 'acme',
    lastValue: 90,
    baseline: 40,
    changePct: 125,
    history: [],
    link: 'https://dash.example.com/orders'
  }

  it('offers "Send to inbox" only with the inbox on, and not on resolved alerts', () => {
    expect(availableAlertActions({ status: 'new' })).toEqual(['track', 'snooze', 'resolve'])
    expect(availableAlertActions({ status: 'new' }, { inbox: true })).toEqual(['track', 'sendToInbox', 'snooze', 'resolve'])
    expect(availableAlertActions({ status: 'resolved' }, { inbox: true })).toEqual(['reopen'])
    expect(isAlertAction({ type: 'sendToInbox' })).toBe(true)
  })

  it('tracks a new alert sent to the inbox and leaves others as they are', () => {
    expect(applyAlertAction([alert], alert.key, { type: 'sendToInbox' }, 1)[0]!.status).toBe('tracking')
    const snoozed = { ...alert, status: 'snoozed' as const, snoozedUntil: 5 }
    expect(applyAlertAction([snoozed], alert.key, { type: 'sendToInbox' }, 1)[0]).toBe(snoozed)
  })

  it('builds a pending bug with the alert context', () => {
    const { proposal, source } = alertInboxProposal(alert)
    expect(source).toEqual({ type: 'alert', ref: alert.key, label: 'Order errors' })
    expect(proposal.kind).toBe('bug')
    expect(proposal.title).toBe('Order errors: sudden jump on checkout-api')
    expect(proposal.detail).toContain('Value: 90 (baseline 40, +125 %)')
    expect(proposal.detail).toContain('Period: 2026-10-29 to 2026-10-30')
    expect(proposal.link).toBe('https://dash.example.com/orders')
  })
})

describe('milestone changes by agents', () => {
  const beta: Milestone = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 }, notes: 'old' }
  const launch: Milestone = { id: 'ga', name: 'GA', start: '2026-11-01', end: '2026-11-30', source: { kind: 'tracker', query: 'labels = launch' } }

  it('patches the fields of the milestone source and checks the result', () => {
    expect(patchMilestone(beta, { progress: 55.4, notes: null, link: 'https://example.com/plan' })).toEqual({ ...{ id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11' }, source: { kind: 'manual', progress: 55 }, link: 'https://example.com/plan' })
    expect(patchMilestone(launch, { query: ' labels = beta ', end: '2026-12-15' })).toMatchObject({ end: '2026-12-15', source: { kind: 'tracker', query: 'labels = beta' } })
    expect(patchMilestone(beta, { query: 'x' })).toMatch(/typed by hand/)
    expect(patchMilestone(launch, { progress: 10 })).toMatch(/counted from a tracker/)
    expect(patchMilestone(beta, { end: '2026-10-01' })).toMatch(/order/)
  })

  it('applies a proposal only while the milestone is as the agent saw it', () => {
    const p = (over: Partial<MilestoneProposal>): MilestoneProposal => ({ id: 'p1', action: 'update', milestoneId: 'beta', source: {}, createdAt: 0, ...over })
    expect(applyMilestoneProposal([beta], p({ action: 'create', milestoneId: 'ga', milestone: launch }))).toEqual([beta, launch])
    expect(applyMilestoneProposal([beta, launch], p({ action: 'create', milestoneId: 'ga', milestone: launch }))).toMatch(/already exists/)
    expect(applyMilestoneProposal([beta], p({ milestone: { ...beta, name: 'Beta 2' }, before: beta }))).toEqual([{ ...beta, name: 'Beta 2' }])
    expect(applyMilestoneProposal([{ ...beta, name: 'Edited' }], p({ milestone: { ...beta, name: 'Beta 2' }, before: beta }))).toMatch(/changed since/)
    expect(applyMilestoneProposal([beta], p({ action: 'delete', before: beta }))).toEqual([])
    expect(applyMilestoneProposal([], p({ action: 'delete', before: beta }))).toMatch(/no longer exists/)
  })

  it('asks by default and keeps the setting through the schema', () => {
    expect(DEFAULT_AGENT_MILESTONE_MODE).toBe('ask')
    const parsed = parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', planner: { agentMilestones: 'allow' } }] })
    expect(parsed.profiles[0]!.planner?.agentMilestones).toBe('allow')
    expect(() => parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', planner: { agentMilestones: 'always' } }] })).toThrow()
  })
})

describe('plan links', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Doc ${i}`, url: `https://example.com/${i}` }))

  it('parses labelled links and bare addresses, trimmed and without repeats', () => {
    expect(parsePlanLinks([{ label: '  Design   doc ', url: ' https://example.com/design ' }, 'https://example.com/board', { url: 'https://example.com/design' }])).toEqual([
      { label: 'Design doc', url: 'https://example.com/design' },
      { label: 'https://example.com/board', url: 'https://example.com/board' }
    ])
    expect(parsePlanLinks([])).toEqual([])
    expect(parsePlanLinks(many(PLAN_LINK_LIMITS.items))).toHaveLength(PLAN_LINK_LIMITS.items)
  })

  it('refuses addresses that are not http(s), too many links and long labels', () => {
    expect(parsePlanLinks([{ label: 'x', url: 'javascript:alert(1)' }])).toMatch(/http\(s\)/)
    expect(parsePlanLinks([{ label: 'x', url: 'ftp://example.com/file' }])).toMatch(/http\(s\)/)
    expect(parsePlanLinks([{ label: 'x', url: 'https://example.com/a b' }])).toMatch(/http\(s\)/)
    expect(parsePlanLinks([{ label: 'x' }])).toMatch(/url/)
    expect(parsePlanLinks([{ label: 'x', url: `https://example.com/${'a'.repeat(PLAN_LINK_LIMITS.url)}` }])).toMatch(/http\(s\)/)
    expect(parsePlanLinks([{ label: 'x'.repeat(PLAN_LINK_LIMITS.label + 1), url: 'https://example.com' }])).toMatch(/label/)
    expect(parsePlanLinks([{ label: 3, url: 'https://example.com' }])).toMatch(/label/)
    expect(parsePlanLinks(many(PLAN_LINK_LIMITS.items + 1))).toMatch(/at most 20/)
    expect(parsePlanLinks('https://example.com')).toMatch(/list/)
    expect(parsePlanLinks([null])).toMatch(/label/)
  })

  it('carries links in inbox proposals and new items, and refuses bad ones', () => {
    const parsed = parseInboxProposals({ title: 'Check the dashboard', detail: '**Errors** went up', links: [{ label: 'Dashboard', url: 'https://example.com/d' }] })
    expect(parsed).toMatchObject({ ok: true, items: [{ title: 'Check the dashboard', detail: '**Errors** went up', links: [{ label: 'Dashboard', url: 'https://example.com/d' }] }] })
    const proposal = parsed.ok ? parsed.items[0]! : null
    expect(newInboxItem(proposal!, { type: 'agent' }, 'i1', 1).links).toEqual([{ label: 'Dashboard', url: 'https://example.com/d' }])
    expect(parseInboxProposals({ title: 'x', links: [{ url: 'file:///etc/passwd' }] })).toEqual({ ok: false, error: expect.stringMatching(/http\(s\)/) })
    expect(parseInboxProposals({ title: 'x', links: many(21) })).toEqual({ ok: false, error: expect.stringMatching(/at most/) })
    expect(parseInboxProposals({ title: 'x', links: [] })).toEqual({ ok: true, items: [{ kind: 'task', title: 'x', detail: '' }] })
  })

  it('checks milestone links and loads milestones stored before links existed', () => {
    const old: Milestone = { id: 'm', name: 'M', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 10 }, notes: 'n', link: 'https://example.com' }
    expect(milestoneProblems(old)).toEqual([])
    expect(parseMilestone(old)).toEqual(old)
    expect(milestoneProblems({ ...old, links: [{ label: 'Spec', url: 'https://example.com/spec' }] })).toEqual([])
    expect(milestoneProblems({ ...old, links: [{ label: 'Bad', url: 'mailto:a@example.com' }] })).toEqual(['links'])
    expect(milestoneProblems({ ...old, links: many(21) })).toEqual(['links'])
    expect(parseMilestone({ ...old, links: [{ label: ' Spec ', url: 'https://example.com/spec' }] })).toEqual({ ...old, links: [{ label: 'Spec', url: 'https://example.com/spec' }] })
    expect(parseMilestone({ ...old, links: [{ url: 'nope' }] })).toBeNull()
    // Dates and who changed it are never taken from the caller.
    expect(parseMilestone({ ...old, createdAt: 1, updatedAt: 2, updatedBy: 'agent' })).toEqual(old)
  })

  it('patches milestone links and carries them through a proposal', () => {
    const beta: Milestone = { id: 'beta', name: 'Beta', start: '2026-11-01', end: '2026-11-11', source: { kind: 'manual', progress: 30 } }
    const links = [{ label: 'Board', url: 'https://example.com/board' }]
    const next = patchMilestone(beta, { links })
    expect(next).toEqual({ ...beta, links })
    expect(patchMilestone({ ...beta, links }, { links: null })).toEqual(beta)
    expect(patchMilestone({ ...beta, links }, { notes: 'x' })).toEqual({ ...beta, links, notes: 'x' })
    const p: MilestoneProposal = { id: 'p', action: 'update', milestoneId: 'beta', milestone: next as Milestone, before: beta, source: {}, createdAt: 0 }
    expect(applyMilestoneProposal([beta], p)).toEqual([{ ...beta, links }])
  })
})

describe('milestone pieces', () => {
  const pieces = (items: MilestonePiece[]): Milestone => ({ id: 'p', name: 'P', start: '2026-11-01', end: '2026-11-11', source: { kind: 'items', items } })
  const ticketState = (key: string, category: TrackedTicket['category'], extra: Partial<TrackedTicket> = {}): TrackedTicket => ({ key, title: `Title ${key}`, status: category === 'done' ? 'Done' : 'Open', category, checkedAt: 1, ...extra })
  const views = (items: MilestonePiece[], tickets: Record<string, TrackedTicket> = {}, inbox: Pick<InboxItem, 'id' | 'title' | 'status'>[] = []) =>
    pieceViews(items, { ticket: (c, k) => tickets[ticketStateKey(c, k)], task: (id) => inbox.find((i) => i.id === id) })
  const status = (items: MilestonePiece[], today: string, tickets: Record<string, TrackedTicket> = {}, inbox: Pick<InboxItem, 'id' | 'title' | 'status'>[] = []) => milestoneStatus(pieces(items), pieceTally(views(items, tickets, inbox)), today)

  it('reads ticket keys as typed, upper-cased', () => {
    expect(parseTicketKey(' abc-12 ')).toBe('ABC-12')
    expect(parseTicketKey('MY_PROJ-7')).toBe('MY_PROJ-7')
    for (const bad of ['ABC', '12-ABC', 'ABC-', 'A B-1', '', 42]) expect(parseTicketKey(bad)).toBeNull()
  })

  it('parses pieces with a default weight of 5 and refuses bad ones', () => {
    expect(parsePieces([{ kind: 'ticket', key: 'abc-1' }, { kind: 'task', itemId: ' i1 ', weight: 10 }, { kind: 'link', url: 'https://docs.example.com/a', weight: 1 }])).toEqual([
      { kind: 'ticket', key: 'ABC-1', weight: 5 },
      { kind: 'task', itemId: 'i1', weight: 10 },
      { kind: 'link', url: 'https://docs.example.com/a', label: 'https://docs.example.com/a', done: false, weight: 1 }
    ])
    expect(parsePieces([{ kind: 'ticket', key: 'ABC-1', connectionId: 'jira-2', weight: 3 }])).toEqual([{ kind: 'ticket', key: 'ABC-1', connectionId: 'jira-2', weight: 3 }])
    expect(parsePieces([{ kind: 'ticket', key: 'ABC-1', weight: 0 }])).toMatch(/weight/)
    expect(parsePieces([{ kind: 'ticket', key: 'ABC-1', weight: 11 }])).toMatch(/weight/)
    expect(parsePieces([{ kind: 'ticket', key: 'ABC-1', weight: 2.5 }])).toMatch(/weight/)
    expect(parsePieces([{ kind: 'ticket', key: 'nope' }])).toMatch(/key/)
    expect(parsePieces([{ kind: 'task', itemId: '' }])).toMatch(/itemId/)
    expect(parsePieces([{ kind: 'link', url: 'ftp://x' }])).toMatch(/url/)
    expect(parsePieces([{ kind: 'link', url: 'https://x.example.com', done: 'yes' }])).toMatch(/done/)
    expect(parsePieces([{ kind: 'other' }])).toMatch(/kind/)
    expect(parsePieces([{ kind: 'ticket', key: 'ABC-1' }, { kind: 'ticket', key: 'abc-1' }])).toMatch(/twice/)
    expect(parsePieces(Array.from({ length: 101 }, (_v, i) => ({ kind: 'ticket', key: `ABC-${i + 1}` })))).toMatch(/at most 100/)
    expect(parsePieces('x')).toMatch(/list/)
  })

  it('checks a pieces milestone as a whole, and parses one from the renderer', () => {
    expect(milestoneProblems(pieces([]))).toEqual([])
    expect(milestoneProblems(pieces([{ kind: 'ticket', key: 'abc-1', weight: 5 }]))).toContain('pieces')
    expect(piecesOk([{ kind: 'ticket', key: 'ABC-1', weight: 5 }])).toBe(true)
    expect(piecesOk([{ weight: 5, key: 'ABC-1', kind: 'ticket' }])).toBe(true)
    expect(piecesOk([{ kind: 'ticket', key: 'ABC-1' }])).toBe(false)
    expect(parseMilestone({ id: 'x', name: 'X', start: '2026-11-01', end: '2026-11-30', source: { kind: 'items', items: [{ kind: 'ticket', key: 'abc-1' }] } })?.source).toEqual({ kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 5 }] })
    expect(parseMilestone({ id: 'x', name: 'X', start: '2026-11-01', end: '2026-11-30', source: { kind: 'items', items: [{ kind: 'ticket', key: 'abc-1', weight: 99 }] } })).toBeNull()
    expect(countsKey(pieces([]))).toBeNull()
  })

  it('weighs progress: done weights over all weights', () => {
    const items: MilestonePiece[] = [
      { kind: 'link', url: 'https://a.example.com', label: 'A', done: false, weight: 2 },
      { kind: 'link', url: 'https://b.example.com', label: 'B', done: true, weight: 8 }
    ]
    expect(pieceShares(items)).toEqual([20, 80])
    expect(views(items).map((v) => v.share)).toEqual([20, 80])
    expect(status(items, '2026-11-06')).toMatchObject({ progress: 80, status: 'onTrack' })
  })

  it('counts an empty list as 0 % and at risk once started, like an empty query', () => {
    expect(status([], '2026-10-30')).toEqual({ status: 'notStarted', progress: 0, elapsed: 0 })
    expect(status([], '2026-11-02')).toMatchObject({ status: 'atRisk', progress: 0 })
    expect(pieceTally([])).toEqual({ total: 0, done: 0, count: 0, doneCount: 0 })
  })

  it('never counts a ticket of unknown state as done', () => {
    const items: MilestonePiece[] = [{ kind: 'ticket', key: 'ABC-1', weight: 5 }, { kind: 'ticket', key: 'ABC-2', weight: 5 }, { kind: 'ticket', key: 'ABC-3', weight: 5 }, { kind: 'ticket', key: 'ABC-4', weight: 5 }]
    const tickets = {
      '|ABC-1': ticketState('ABC-1', 'done'),
      '|ABC-2': ticketState('ABC-2', 'done', { missing: true }),
      '|ABC-3': ticketState('ABC-3', 'done', { unsupported: true })
    }
    const v = views(items, tickets)
    expect(v.map((x) => x.state)).toEqual(['done', 'unknown', 'unknown', 'unknown'])
    expect(v[0]!.title).toBe('Title ABC-1')
    expect(v[3]!.title).toBe('ABC-4')
    expect(v[1]!.error).toBe('missing')
    expect(status(items, '2026-11-02', tickets).progress).toBe(25)
    expect(trackedState(undefined)).toBe('unknown')
    // A failed read keeps the last good state.
    expect(trackedState(ticketState('ABC-5', 'inProgress', { error: 'offline' }))).toBe('inProgress')
  })

  it('reads a ticket from its own connection', () => {
    const items: MilestonePiece[] = [{ kind: 'ticket', key: 'ABC-1', connectionId: 'jira-2', weight: 5 }]
    expect(views(items, { '|ABC-1': ticketState('ABC-1', 'done') })[0]!.state).toBe('unknown')
    expect(views(items, { 'jira-2|ABC-1': ticketState('ABC-1', 'done') })[0]!.state).toBe('done')
  })

  it('counts a local task as done only when its item is done', () => {
    const items: MilestonePiece[] = [{ kind: 'task', itemId: 'a', weight: 5 }, { kind: 'task', itemId: 'b', weight: 5 }, { kind: 'task', itemId: 'c', weight: 5 }, { kind: 'task', itemId: 'gone', weight: 5 }]
    const inbox = [
      { id: 'a', title: 'A', status: 'done' as const },
      { id: 'b', title: 'B', status: 'local' as const },
      { id: 'c', title: 'C', status: 'discarded' as const }
    ]
    const v = views(items, {}, inbox)
    expect(v.map((x) => [x.state, x.status])).toEqual([['done', 'done'], ['todo', 'local'], ['todo', 'discarded'], ['unknown', undefined]])
    expect(v[3]!.missing).toBe(true)
    expect(status(items, '2026-11-02', {}, inbox).progress).toBe(25)
  })

  it('is done, and only then 100 %, when every piece is done', () => {
    const items: MilestonePiece[] = [{ kind: 'link', url: 'https://a.example.com', label: 'A', done: true, weight: 1 }, { kind: 'task', itemId: 'a', weight: 10 }]
    expect(status(items, '2026-12-01', {}, [{ id: 'a', title: 'A', status: 'done' }])).toMatchObject({ status: 'done', progress: 100 })
    // 199 of 200 rounds to 100 % but is not done.
    const many: MilestonePiece[] = [{ kind: 'link', url: 'https://a.example.com', label: 'A', done: false, weight: 1 }, ...Array.from({ length: 20 }, (_v, i): MilestonePiece => ({ kind: 'link', url: `https://b${i}.example.com`, label: 'B', done: true, weight: 10 }))]
    expect(status(many, '2026-11-12')).toMatchObject({ status: 'late', progress: 99 })
  })

  it('patches the pieces, converting another source, and keeps the other rules', () => {
    const m = manual(10)
    const next = patchMilestone(m, { items: [{ kind: 'ticket', key: 'ABC-1', weight: 3 }] })
    expect(typeof next !== 'string' && next.source).toEqual({ kind: 'items', items: [{ kind: 'ticket', key: 'ABC-1', weight: 3 }] })
    expect(patchMilestone(pieces([]), { progress: 3 })).toMatch(/made of pieces/)
    expect(patchMilestone(m, { items: [], progress: 3 })).toMatch(/cannot go with/)
  })
})
