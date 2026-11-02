import { addDays, localDay } from '../alerts/days'
import type { MetricAlert } from '../alerts/types'
import { alertInboxProposal } from '../inbox/alert'
import { newInboxItem } from '../inbox/inbox'
import type { InboxItem, InboxProposal, InboxSource } from '../inbox/types'
import { countsKey, ticketStateKey, type Milestone, type MilestoneCounts, type TrackedTicket } from '../milestones'
import { countByCategory } from '../tickets/ticket-tracker'
import type { TicketSummary } from '../tickets/types'
import { PRODUCT_PEOPLE, PRODUCT_TRACKER_ID } from './profile'
import { PRODUCT_QUERIES, PRODUCT_QUERY_RESULTS, productTicket } from './tracker'

const HOUR = 3_600_000

/** What the Plan screen shows for a milestone of the scenario, by its id (for tests and docs). */
export const PRODUCT_MILESTONE_EXPECTED = {
  'ms-sso': 'onTrack',
  'ms-activation': 'atRisk',
  'ms-billing': 'late',
  'ms-offline': 'notStarted',
  'ms-docs': 'done',
  'ms-offsite': 'onTrack',
  'ms-invites': 'onTrack'
} as const

/** Ids of the inbox items the scenario's milestone pieces and ticket links point at. */
export const PRODUCT_INBOX_IDS = { inviteBug: 'demo-inbox-invite-bug', experimentPlan: 'demo-inbox-experiment-plan' } as const

/** The quarter's milestones, dated around `today`; one in every status. */
export function productMilestones(today: string): Milestone[] {
  const day = (n: number) => addDays(today, n)
  const tracker = (query: string) => ({ kind: 'tracker' as const, query })
  return [
    { id: 'ms-sso', name: 'Ship SSO for teams', start: day(-40), end: day(50), source: tracker(PRODUCT_QUERIES.sso), notes: 'Team admins sign in with their identity provider and invite members from it.' },
    { id: 'ms-activation', name: 'Raise week-1 activation to 40%', start: day(-50), end: day(40), source: tracker(PRODUCT_QUERIES.activation), notes: 'Behind: new teams drop after creating a workspace and before inviting a teammate.', link: 'https://analytics.example.com/funnels/signup', links: [{ label: 'Onboarding research notes', url: 'https://docs.example.com/research/onboarding' }] },
    { id: 'ms-billing', name: 'Migrate billing provider', start: day(-85), end: day(-4), source: tracker(PRODUCT_QUERIES.billing), notes: 'Invoice emails are the last open piece.' },
    { id: 'ms-offline', name: 'Offline mode for mobile', start: day(12), end: day(80), source: tracker(PRODUCT_QUERIES.offline) },
    { id: 'ms-docs', name: 'Docs site revamp', start: day(-85), end: day(-10), source: tracker(PRODUCT_QUERIES.docs) },
    { id: 'ms-offsite', name: 'Plan the team offsite', start: day(-45), end: day(45), source: { kind: 'manual' as const, progress: 45 }, notes: 'Tracked by hand: venue shortlisted, agenda in review.' },
    {
      id: 'ms-invites',
      name: 'Reliable workspace invites',
      start: day(-10),
      end: day(30),
      // Weights 3 + 5 + 4 + 2 = 14; the done ones (NOTE-238 and the doc) weigh 5: 36 % done, a quarter of the time gone.
      source: {
        kind: 'items' as const,
        items: [
          { kind: 'ticket' as const, key: 'NOTE-238', weight: 3 },
          { kind: 'ticket' as const, key: 'NOTE-253', weight: 5 },
          { kind: 'task' as const, itemId: PRODUCT_INBOX_IDS.inviteBug, weight: 4 },
          { kind: 'link' as const, url: 'https://docs.example.com/specs/invite-states', label: 'Invite states spec', done: true, weight: 2 }
        ]
      },
      notes: 'Made of pieces: two tickets, the invite bug kept in Workhub, and the spec.'
    }
  ]
}

const tracked = (t: Pick<TicketSummary, 'key' | 'title' | 'status' | 'category' | 'url'>, now: number): TrackedTicket => ({ key: t.key, title: t.title, status: t.status, category: t.category, ...(t.url ? { url: t.url } : {}), checkedAt: now })

/**
 * The states the demo tracker gives for the tickets of the scenario's pieces and linked inbox items
 * (by `ticketStateKey`), so Plan shows them before the first refresh.
 */
export function productTicketStates(milestones: readonly Milestone[], inbox: readonly InboxItem[], now: number): Record<string, TrackedTicket> {
  const out: Record<string, TrackedTicket> = {}
  const add = (connectionId: string | undefined, key: string) => {
    const t = productTicket(key)
    if (t) out[ticketStateKey(connectionId, key)] = tracked(t, now)
  }
  for (const m of milestones) if (m.source.kind === 'items') for (const p of m.source.items) if (p.kind === 'ticket') add(p.connectionId, p.key)
  for (const i of inbox) if (i.ticket && (i.status === 'local' || i.status === 'ticket')) add(i.ticket.connectionId ?? PRODUCT_TRACKER_ID, i.ticket.key)
  return out
}

/** The counts the demo tracker gives for each tracker milestone, so Plan shows figures before the first refresh. */
export function productMilestoneCounts(milestones: readonly Milestone[], now: number): Record<string, MilestoneCounts> {
  const out: Record<string, MilestoneCounts> = {}
  for (const m of milestones) {
    const key = countsKey(m)
    if (key === null || m.source.kind !== 'tracker') continue
    out[m.id] = { ...countByCategory(PRODUCT_QUERY_RESULTS[m.source.query] ?? []), at: now, key }
  }
  return out
}

const personId = (name: string) => PRODUCT_PEOPLE.find((p) => p.name.startsWith(name))!.id

interface Seed {
  proposal: InboxProposal
  source: InboxSource
  status: InboxItem['status']
  ageHours: number
  ticket?: { key: string; url: string }
  /** A fixed id, for items a milestone or a test points at. */
  id?: string
}

const ticket = (key: string) => ({ key, url: `https://demo.example.com/browse/${key}` })

/**
 * The inbox of the scenario: items that came from meetings, waiting for approval; local tasks (one
 * overdue, one due today, one critical, one linked to a demo ticket); approved items with demo
 * tickets, still followed in the tracker; recorded decisions.
 * `alert` is the front-end error alert the pending bug is drafted from.
 */
export function productInbox(now: number, alert?: MetricAlert): InboxItem[] {
  const today = localDay(now)
  const meeting = (label: string, ref: string): InboxSource => ({ type: 'meeting', ref, label })
  const seeds: Seed[] = [
    // Waiting for approval, from meetings.
    {
      proposal: { kind: 'task', title: 'Draft empty-state copy for new workspaces', detail: 'New workspaces open on a blank page. Draft two or three short options with Tom and test them with five new teams.', area: 'Activation', criticality: 'High', due: addDays(today, 3), people: [personId('Tom')] },
      source: meeting('Activation metrics review', 'demo-activation-review'),
      status: 'pending',
      ageHours: 3
    },
    {
      proposal: { kind: 'task', title: 'Ask data for activation by signup source', detail: 'The founder wants week-1 activation split by signup source since the new onboarding shipped. Ask data for the export and share it with Kenji.', area: 'Activation', criticality: 'Medium', due: addDays(today, 5), people: [personId('Sara'), personId('Kenji')] },
      source: meeting('Roadmap check-in with the founder', 'demo-roadmap-checkin'),
      status: 'pending',
      ageHours: 5
    },
    {
      proposal: { kind: 'decision', title: 'Roll out the new editor toolbar to 20% of teams', detail: 'Agreed to start at 20% and widen if save failures stay flat for a week. Priya owns the flag; Kenji reads the experiment.', area: 'Editor', criticality: 'High', people: [personId('Priya'), personId('Kenji')] },
      source: meeting('Roadmap check-in with the founder', 'demo-roadmap-checkin'),
      status: 'pending',
      ageHours: 5
    },
    // Local tasks.
    {
      proposal: { kind: 'task', title: 'Send the cancellation reasons summary to Omar', detail: 'Top reasons for the last four weeks, with counts.', area: 'Billing', criticality: 'Medium', due: addDays(today, -3), people: [personId('Omar')] },
      source: meeting('Support sync', 'demo-support-sync'),
      status: 'local',
      ageHours: 96
    },
    {
      proposal: { kind: 'task', title: 'Review the editor toolbar with Tom before the critique', detail: 'Check the keyboard shortcuts and the accessibility notes.', area: 'Editor', criticality: 'High', due: today, people: [personId('Tom')] },
      source: { type: 'manual' },
      status: 'local',
      ageHours: 20
    },
    {
      proposal: { kind: 'bug', title: 'Workspace invite links expire too early', detail: 'Support reports invite links that stop working after a few hours. Needs a clear resend path before the next onboarding experiment.', area: 'Activation', criticality: 'Critical', people: [personId('Mia'), personId('Priya')] },
      source: { type: 'manual' },
      status: 'local',
      ageHours: 30,
      id: PRODUCT_INBOX_IDS.inviteBug
    },
    {
      proposal: { kind: 'task', title: 'Prepare the milestones summary for the founder', detail: 'One page: status, risks, asks.', area: 'General', criticality: 'Low', due: addDays(today, 9), people: [personId('Sara')] },
      source: { type: 'manual' },
      status: 'local',
      ageHours: 48
    },
    {
      proposal: { kind: 'task', title: 'Write the experiment plan for the invite prompt', detail: 'Cover, in order:\n\n1. **Hypothesis**: a prompt after the first page raises invites.\n2. **Metric**: week-1 invites per new workspace.\n3. Sample size and guardrails (`save_failed` must stay flat).', area: 'Activation', criticality: 'Medium', due: addDays(today, 6), people: [personId('Kenji')], links: [{ label: 'Experiment template', url: 'https://docs.example.com/experiments/template' }, { label: 'Invite funnel', url: 'https://analytics.example.com/funnels/invite' }] },
      source: meeting('Activation metrics review', 'demo-activation-review'),
      status: 'local',
      ageHours: 26,
      // Linked to the existing experiment ticket: it is done when the ticket is.
      ticket: ticket('NOTE-252'),
      id: PRODUCT_INBOX_IDS.experimentPlan
    },
    // Approved: tickets created in the demo tracker.
    {
      proposal: { kind: 'task', title: 'Add the cancellation reason to the analytics events', detail: 'Include the reason code in the cancellation event.', area: 'Billing', criticality: 'Medium', people: [personId('Kenji')] },
      source: meeting('Roadmap check-in with the founder', 'demo-roadmap-checkin'),
      status: 'ticket',
      ageHours: 40,
      ticket: ticket('NOTE-255')
    },
    {
      proposal: { kind: 'bug', title: 'Calendar integration drops recurring events', detail: 'Customers who connect their calendar lose the recurring meetings in the sidebar.', area: 'Integrations', criticality: 'High', people: [personId('Omar')] },
      source: meeting('Support sync', 'demo-support-sync'),
      status: 'ticket',
      ageHours: 60,
      ticket: ticket('WEB-34')
    },
    // Recorded decisions.
    {
      proposal: { kind: 'decision', title: 'Keep email-link sign-in as the fallback for 2 more weeks', detail: 'Revisit when SSO passes the QA regression run.', area: 'Platform', people: [personId('Mia'), personId('Priya')] },
      source: meeting('Daily standup', 'demo-daily-standup'),
      status: 'local',
      ageHours: 72
    },
    {
      proposal: { kind: 'decision', title: 'Pause offline mode work until the billing migration is done', detail: 'Mobile work resumes in the next planning.', area: 'Platform', people: [personId('Sara')] },
      source: meeting('Roadmap check-in with the founder', 'demo-roadmap-checkin'),
      status: 'local',
      ageHours: 120
    }
  ]
  if (alert) {
    const { proposal, source } = alertInboxProposal(alert)
    seeds.unshift({ proposal: { ...proposal, area: 'Editor', criticality: 'High', people: [personId('Kenji')] }, source, status: 'pending', ageHours: 1 })
  }
  return seeds.map((s, i) => {
    const createdAt = now - s.ageHours * HOUR
    const item = newInboxItem(s.proposal, s.source, s.id ?? `demo-inbox-${i + 1}`, createdAt, PRODUCT_PEOPLE)
    return { ...item, status: s.status, ...(s.ticket ? { ticket: s.ticket } : {}) }
  })
}
