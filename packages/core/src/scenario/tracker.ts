import type { StatusCategory, TicketSummary } from '../tickets/types'

/** A made-up tracker ticket for the demo tracker. */
export interface ProductTicket {
  key: string
  title: string
  state: 'todo' | 'progress' | 'review' | 'done'
  type: 'Task' | 'Bug' | 'Story'
  priority: 'High' | 'Medium' | 'Low'
  description: string
  labels: string[]
  /** Part of the active sprint; the others are in the backlog. */
  sprint?: boolean
  comments?: { author: string; body: string; minutesAgo: number }[]
}

const STATE_STATUS: Record<ProductTicket['state'], { status: string; category: StatusCategory }> = {
  todo: { status: 'To Do', category: 'todo' },
  progress: { status: 'In Progress', category: 'inProgress' },
  review: { status: 'In Review', category: 'inProgress' },
  done: { status: 'Done', category: 'done' }
}

export function productTicketStatus(state: ProductTicket['state']): { status: string; category: StatusCategory } {
  return STATE_STATUS[state]
}

/** The tickets assigned to the demo user: what Home shows as "in progress", and what briefs list as context. */
export const PRODUCT_ASSIGNED: readonly ProductTicket[] = [
  {
    key: 'NOTE-231',
    title: 'Add SAML sign-in for team workspaces',
    state: 'progress',
    type: 'Story',
    priority: 'High',
    sprint: true,
    description: 'Team admins want to sign in with their identity provider. Add SAML sign-in with the existing email link as a fallback.\n\nPull request: https://github.com/example/notes-web/pull/412',
    labels: ['platform', 'ms-sso'],
    comments: [
      { author: 'Priya Nair', body: 'The fallback needs copy from design before we can merge.', minutesAgo: 1500 },
      { author: 'Tom Becker', body: 'Copy draft is in the design file, section "SSO fallback".', minutesAgo: 420 }
    ]
  },
  {
    key: 'NOTE-250',
    title: 'Retry saving a note after a network timeout',
    state: 'progress',
    type: 'Bug',
    priority: 'High',
    sprint: true,
    description: 'Saves fail on slow connections and the editor shows an error. Retry once with a longer timeout and keep the unsaved text.',
    labels: ['editor', 'saving'],
    comments: [{ author: 'Mia Novak', body: 'Reproduced on a throttled connection. Attached the HAR file.', minutesAgo: 600 }]
  },
  {
    key: 'NOTE-253',
    title: 'Show a clear message when a workspace invite expires',
    state: 'review',
    type: 'Story',
    priority: 'Medium',
    sprint: true,
    description: 'Show a plain-language message with a resend button instead of a generic error.\n\nPull request: https://github.com/example/notes-web/pull/418',
    labels: ['activation', 'ms-activation'],
    comments: [{ author: 'Priya Nair', body: 'Ready for review.', minutesAgo: 90 }]
  },
  {
    key: 'OPS-31',
    title: 'Send invoice emails from the new billing provider',
    state: 'progress',
    type: 'Task',
    priority: 'Medium',
    sprint: true,
    description: 'Invoice emails still come from the old provider. Switch the template and track delivery.',
    labels: ['billing', 'ms-billing'],
    comments: []
  },
  {
    key: 'WEB-18',
    title: 'Draft the offline sync rules',
    state: 'todo',
    type: 'Task',
    priority: 'Low',
    description: 'Conflict handling, storage limits, retry policy. One page for the roadmap check-in.',
    labels: ['mobile', 'ms-offline'],
    comments: []
  },
  {
    key: 'NOTE-258',
    title: 'Document the workspace invite states',
    state: 'todo',
    type: 'Task',
    priority: 'Low',
    description: 'A short state diagram of an invite: created, sent, accepted, expired.',
    labels: ['docs'],
    comments: []
  }
]

const t = (key: string, title: string, state: ProductTicket['state'] = 'done'): TicketSummary => {
  const s = STATE_STATUS[state]
  return { key, title, status: s.status, category: s.category, url: `https://demo.example.com/browse/${key}` }
}

/** The milestone queries and the made-up tickets each one finds. */
export const PRODUCT_QUERIES = {
  sso: 'project = NOTE AND labels = ms-sso',
  activation: 'project = NOTE AND labels = ms-activation',
  billing: 'project = OPS AND labels = ms-billing',
  offline: 'project = WEB AND labels = ms-offline',
  docs: 'project = NOTE AND labels = ms-docs'
} as const

export const PRODUCT_QUERY_RESULTS: Readonly<Record<string, readonly TicketSummary[]>> = {
  // 5 of 10 done.
  [PRODUCT_QUERIES.sso]: [
    t('NOTE-201', 'SSO configuration screen for admins'),
    t('NOTE-204', 'SAML metadata import'),
    t('NOTE-208', 'Sign-in result screen'),
    t('NOTE-211', 'SSO audit log'),
    t('NOTE-215', 'SSO analytics events'),
    t('NOTE-219', 'SSO error states', 'progress'),
    t('NOTE-221', 'SSO copy review', 'progress'),
    t('NOTE-224', 'SSO load test', 'todo'),
    t('NOTE-227', 'SSO help center article', 'todo'),
    t('NOTE-230', 'SSO rollout plan', 'todo')
  ],
  // 3 of 12 done.
  [PRODUCT_QUERIES.activation]: [
    t('NOTE-232', 'Funnel instrumentation for every step'),
    t('NOTE-235', 'Save progress in workspace setup'),
    t('NOTE-238', 'Remove the duplicate name prompt'),
    t('NOTE-240', 'Template picker on the first screen', 'progress'),
    t('NOTE-253', 'Show a clear message when a workspace invite expires', 'review'),
    t('NOTE-246', 'Shorten the workspace setup form', 'progress'),
    t('NOTE-247', 'Empty-state copy for new workspaces', 'todo'),
    t('NOTE-248', 'Progress checklist on mobile', 'todo'),
    t('NOTE-249', 'Resume setup from the reminder email', 'todo'),
    t('NOTE-251', 'Editor toolbar redesign', 'todo'),
    t('NOTE-252', 'Experiment: invite prompt after the first note', 'todo'),
    t('NOTE-254', 'Setup flow accessibility pass', 'todo')
  ],
  // 6 of 8 done, and the period is over.
  [PRODUCT_QUERIES.billing]: [
    t('OPS-12', 'Map plans to the new provider'),
    t('OPS-15', 'Migrate customers in batches'),
    t('OPS-18', 'Webhook handlers for the new provider'),
    t('OPS-21', 'Payment settings page'),
    t('OPS-24', 'Billing dashboard'),
    t('OPS-27', 'Proration rules'),
    t('OPS-31', 'Send invoice emails from the new billing provider', 'progress'),
    t('OPS-33', 'Weekly reconciliation report', 'todo')
  ],
  // Nothing started.
  [PRODUCT_QUERIES.offline]: [
    t('WEB-18', 'Draft the offline sync rules', 'todo'),
    t('WEB-19', 'Local note storage on mobile', 'todo'),
    t('WEB-20', 'Conflict resolution for edits', 'todo'),
    t('WEB-21', 'Sync queue with retries', 'todo'),
    t('WEB-22', 'Offline banner', 'todo'),
    t('WEB-23', 'Offline analytics', 'todo')
  ],
  // All done.
  [PRODUCT_QUERIES.docs]: [
    t('NOTE-60', 'Choose the docs site generator'),
    t('NOTE-62', 'Move the guides to the new site'),
    t('NOTE-64', 'Redirect the old URLs'),
    t('NOTE-66', 'Search for the docs site'),
    t('NOTE-68', 'Rewrite the getting started guide'),
    t('NOTE-70', 'API reference page'),
    t('NOTE-72', 'Document the changelog process')
  ]
}

/** The tickets the scenario's inbox items were sent to (approved before the demo starts). */
export const PRODUCT_INBOX_TICKETS: readonly TicketSummary[] = [t('NOTE-255', 'Add the cancellation reason to the analytics events', 'progress'), t('WEB-34', 'Calendar integration drops recurring events', 'todo')]

/** A demo ticket by key, with the state the demo tracker starts with; undefined for a key it does not know. */
export function productTicket(key: string): TicketSummary | undefined {
  const assigned = PRODUCT_ASSIGNED.find((a) => a.key === key)
  if (assigned) return { key, title: assigned.title, ...productTicketStatus(assigned.state), url: `https://demo.example.com/browse/${key}` }
  return [...Object.values(PRODUCT_QUERY_RESULTS).flat(), ...PRODUCT_INBOX_TICKETS].find((s) => s.key === key)
}
