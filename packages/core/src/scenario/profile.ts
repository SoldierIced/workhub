/**
 * The "a day of a team lead" demo scenario (`npm run demo`): a synthetic profile, people and
 * connection for a made-up collaborative notes app ("Acme Notes"). Nothing here is real. The same engine serves any role; this is
 * only the data the demo starts from.
 */
import type { Connection } from '../domain/connection'
import { NO_MODULES, type Profile } from '../domain/profile'
import type { MeetingRule, Person, PlannerSettings } from '../calendar/types'
import type { CriticalityLevel } from '../inbox/types'

/** The value of `WORKHUB_DEMO_SCENARIO` that selects this scenario. */
export const PRODUCT_SCENARIO = 'team-lead'

export const PRODUCT_PROFILE_ID = 'team-lead-demo'
export const PRODUCT_TRACKER_ID = 'acme-notes-tracker-demo'
/** The demo tracker answers with a made-up secret; Workhub never sends it anywhere. */
export const PRODUCT_TRACKER_SECRET = 'demo-token'
export const PRODUCT_PROJECT = 'NOTE'

/** The user of the demo: the organizer of nothing, an attendee of everything. */
export const PRODUCT_ME = { name: 'Alex Morgan', email: 'alex.morgan@example.com' }

export const PRODUCT_PEOPLE: readonly Person[] = [
  { id: 'priya-nair', name: 'Priya Nair', emails: ['priya.nair@example.com'], handles: { slack: 'priya.nair', jira: 'priya.nair' }, notes: 'Tech lead. Weekly 1:1: delivery risks, tech debt, estimates.' },
  { id: 'tom-becker', name: 'Tom Becker', emails: ['tom.becker@example.com'], handles: { slack: 'tom.becker' }, notes: 'Designer. Owns the editor toolbar and the workspace setup flow.' },
  { id: 'kenji-ito', name: 'Kenji Ito', emails: ['kenji.ito@example.com'], handles: { slack: 'kenji.ito' }, notes: 'Data analyst. Funnel dashboards and experiment read-outs.' },
  { id: 'sara-lind', name: 'Sara Lind', emails: ['sara.lind@example.com'], handles: { slack: 'sara.lind' }, notes: 'Founder. Wants the milestones and the risks, short.' },
  { id: 'omar-haddad', name: 'Omar Haddad', emails: ['omar.haddad@example.com'], handles: { slack: 'omar.haddad', jira: 'omar.haddad' }, notes: 'Support lead. Customer feedback and cancellation reasons.' },
  { id: 'mia-novak', name: 'Mia Novak', emails: ['mia.novak@example.com'], handles: { slack: 'mia.novak', jira: 'mia.novak' }, notes: 'QA. Release readiness and regression runs.' }
]

export const PRODUCT_AREAS = ['Activation', 'Editor', 'Billing', 'Integrations', 'Platform', 'General'] as const

export const PRODUCT_CRITICALITIES: readonly CriticalityLevel[] = [
  { name: 'Critical', priority: 1 },
  { name: 'High', priority: 2 },
  { name: 'Medium', priority: 3 },
  { name: 'Low', priority: 4 }
]

export const PRODUCT_BUG_TEMPLATE = `{detail}

Expected behavior:
Actual behavior:
Steps to reproduce:

Source: {source}
{link}`

export const PRODUCT_RULES: readonly MeetingRule[] = [
  { id: 'rule-remind-all', name: 'Remind before every meeting', enabled: true, match: {}, action: 'remind', leadMinutes: 10 },
  { id: 'rule-brief-one-on-one', name: 'Brief for 1:1s', enabled: true, match: { titleContains: ['1:1'] }, action: 'brief', leadMinutes: 30 },
  { id: 'rule-brief-standup', name: 'Brief for the daily standup', enabled: true, match: { titleContains: ['Daily standup'], recurringOnly: true }, action: 'brief', leadMinutes: 15 }
]

export const PRODUCT_CALENDAR_ID = 'demo-calendar'

/** The synthetic calendar and tracker connections the demo profile points at. */
export function productConnections(): Connection[] {
  return [{ id: PRODUCT_TRACKER_ID, kind: 'tracker', provider: 'jira', name: 'Acme Notes tracker (demo)', endpoint: 'https://acme-notes.example.com', settings: { email: PRODUCT_ME.email, projectKeys: 'NOTE,WEB,OPS' } }]
}

/** The demo profile. `folder` is where its sessions start (the demo data folder). */
export function productProfile(folder: string): Profile {
  const planner: PlannerSettings = {
    calendarIds: [],
    refreshMinutes: 15,
    reminderLeadMinutes: 10,
    rules: PRODUCT_RULES.map((r) => ({ ...r, match: { ...r.match } })),
    briefTemplate: '',
    people: PRODUCT_PEOPLE.map((p) => ({ ...p, emails: [...p.emails], ...(p.handles ? { handles: { ...p.handles } } : {}) })),
    inbox: {
      areas: [...PRODUCT_AREAS],
      criticalities: PRODUCT_CRITICALITIES.map((c) => ({ ...c })),
      trackerConnectionId: PRODUCT_TRACKER_ID,
      project: PRODUCT_PROJECT,
      issueTypes: { task: 'Task', bug: 'Bug' },
      descriptionTemplate: PRODUCT_BUG_TEMPLATE
    }
  }
  return {
    id: PRODUCT_PROFILE_ID,
    name: 'Team lead (demo)',
    connections: { tracker: PRODUCT_TRACKER_ID },
    accountIds: [],
    modules: { ...NO_MODULES, planner: true, health: true, automations: true },
    folders: [folder],
    defaultFolder: folder,
    color: '#3b82f6',
    planner
  }
}
