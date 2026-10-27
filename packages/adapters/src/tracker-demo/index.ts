import {
  TrackerError,
  isTicketKey,
  pullRequestUrlsIn,
  type ConnectionTest,
  type ListTicketsOptions,
  type StatusCategory,
  type Ticket,
  type TicketComment,
  type TicketDetail,
  type TicketSprint,
  type TicketTracker,
  type TicketTransition,
  type TrackerCapabilities
} from '@workhub/core'

/**
 * A tracker with synthetic tickets, kept in memory, so the UI can be shown (and tested) without
 * credentials. Turned on by `WORKHUB_DEMO_TICKETS=1`. Nothing here is real data.
 */
const SPRINT = { id: '41', name: 'Sprint 41', state: 'active' as const, startDate: '2026-10-19T09:00:00Z' }
const NEXT = { id: '42', name: 'Sprint 42', state: 'future' as const, startDate: '2026-11-02T09:00:00Z' }

const STATES: Record<string, { name: string; category: StatusCategory }> = {
  todo: { name: 'To Do', category: 'todo' },
  progress: { name: 'In Progress', category: 'inProgress' },
  review: { name: 'In Review', category: 'inProgress' },
  done: { name: 'Done', category: 'done' }
}

interface Seed {
  key: string
  title: string
  state: keyof typeof STATES
  sprint?: TicketSprint
  type: string
  priority: string
  description: string
  labels: string[]
  comments: { author: string; body: string; minutesAgo: number }[]
}

const SEEDS: Seed[] = [
  {
    key: 'DEMO-101',
    title: 'Retry failed webhook deliveries with backoff',
    state: 'progress',
    sprint: SPRINT,
    type: 'Story',
    priority: 'High',
    description: 'Failed deliveries are dropped today.\n\nRetry up to 5 times with exponential backoff and record the last error.\n\nPull request: https://github.com/example/webhooks/pull/128',
    labels: ['backend', 'reliability'],
    comments: [
      { author: 'Sam Rivera', body: 'Should the retries survive a restart?', minutesAgo: 1900 },
      { author: 'Ana Costa', body: 'Yes, persist the attempt count. Opened https://github.com/example/webhooks/pull/128 as a first cut.', minutesAgo: 340 }
    ]
  },
  {
    key: 'DEMO-98',
    title: 'Paginate the audit log endpoint',
    state: 'review',
    sprint: SPRINT,
    type: 'Task',
    priority: 'Medium',
    description: 'The audit log returns every row. Add cursor pagination and a page size limit.',
    labels: ['api'],
    comments: [{ author: 'Ana Costa', body: 'Ready for review.', minutesAgo: 95 }]
  },
  {
    key: 'DEMO-104',
    title: 'Document the export format',
    state: 'todo',
    sprint: SPRINT,
    type: 'Task',
    priority: 'Low',
    description: 'Describe the CSV and JSON exports, with one example each.',
    labels: ['docs'],
    comments: []
  },
  {
    key: 'DEMO-110',
    title: 'Add dark mode to the settings page',
    state: 'todo',
    sprint: NEXT,
    type: 'Story',
    priority: 'Medium',
    description: 'Follow the system theme and allow an override.',
    labels: ['frontend'],
    comments: []
  },
  {
    key: 'DEMO-87',
    title: 'Investigate slow startup on low-end devices',
    state: 'progress',
    type: 'Bug',
    priority: 'High',
    description: 'Startup takes over 8 seconds on devices with 2 GB of memory. Profile and list the top three causes.',
    labels: ['performance'],
    comments: []
  },
  {
    key: 'DEMO-75',
    title: 'Clean up unused feature flags',
    state: 'todo',
    type: 'Task',
    priority: 'Low',
    description: 'Remove the flags that have been on for more than two releases.',
    labels: [],
    comments: []
  }
]

function minutesAgo(m: number): number {
  return Date.now() - m * 60_000
}

export class DemoTracker implements TicketTracker {
  readonly provider: string
  readonly capabilities: TrackerCapabilities = { sprints: true, transitions: true, comments: true, assign: true }
  private readonly state = new Map<string, keyof typeof STATES>(SEEDS.map((s) => [s.key, s.state]))
  private readonly extraComments = new Map<string, TicketComment[]>()

  constructor(provider = 'jira') {
    this.provider = provider
  }

  isTicketKey(text: string): boolean {
    return isTicketKey(text, { provider: this.provider })
  }

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, account: 'Demo User' }
  }

  async listAssigned(options: ListTicketsOptions = {}): Promise<Ticket[]> {
    const hidden = new Set((options.ignoredStatuses ?? []).map((s) => s.toLowerCase()))
    return SEEDS.map((s) => this.ticket(s)).filter((t) => t.category !== 'done' && !hidden.has(t.status.toLowerCase()))
  }

  async getTicket(key: string): Promise<TicketDetail | null> {
    const seed = SEEDS.find((s) => s.key === key)
    if (!seed) return null
    const comments: TicketComment[] = [
      ...seed.comments.map((c, i) => ({ id: `${key}-c${i}`, author: c.author, body: c.body, createdAt: minutesAgo(c.minutesAgo) })),
      ...(this.extraComments.get(key) ?? [])
    ]
    return {
      ...this.ticket(seed),
      description: seed.description,
      reporter: 'Sam Rivera',
      labels: seed.labels,
      createdAt: minutesAgo(9000),
      updatedAt: minutesAgo(95),
      comments,
      children: []
    }
  }

  async transitions(key: string): Promise<TicketTransition[]> {
    if (!this.state.has(key)) return []
    const current = this.state.get(key)
    return Object.entries(STATES)
      .filter(([id]) => id !== current)
      .map(([id, s]) => ({ id, name: s.name, status: s.name, category: s.category }))
  }

  async transition(key: string, transitionId: string): Promise<void> {
    if (!this.state.has(key) || !(transitionId in STATES)) throw new TrackerError('Unknown ticket or status', 404)
    this.state.set(key, transitionId)
  }

  async addComment(key: string, text: string): Promise<void> {
    if (!text.trim()) throw new TrackerError('The comment is empty')
    const list = this.extraComments.get(key) ?? []
    list.push({ id: `${key}-new${list.length}`, author: 'Demo User', body: text.trim(), createdAt: Date.now() })
    this.extraComments.set(key, list)
  }

  async assignToMe(): Promise<void> {}

  private ticket(seed: Seed): Ticket {
    const s = STATES[this.state.get(seed.key) ?? seed.state]!
    const prs = pullRequestUrlsIn([seed.description, ...seed.comments.map((c) => c.body)].join('\n'))
    return {
      pullRequestUrls: prs.length > 0 ? prs : undefined,
      key: seed.key,
      provider: this.provider,
      title: seed.title,
      status: s.name,
      category: s.category,
      sprint: seed.sprint,
      assignee: 'Demo User',
      type: seed.type,
      priority: seed.priority,
      url: `https://demo.example.com/browse/${seed.key}`
    }
  }
}
