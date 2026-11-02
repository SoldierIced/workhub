import {
  PRODUCT_ASSIGNED,
  PRODUCT_QUERY_RESULTS,
  TrackerError,
  productTicket,
  isTicketKey,
  pullRequestUrlsIn,
  searchLimit,
  type ConnectionTest,
  type CreateIssueInput,
  type CreatedIssue,
  type SearchOptions,
  type TicketSummary,
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

/** The team-lead scenario's tickets (`WORKHUB_DEMO_SCENARIO=team-lead`): NOTE, WEB and OPS keys. */
const PRODUCT_SPRINT = { id: '41', name: 'Sprint 41', state: 'active' as const, startDate: '2026-10-19T09:00:00Z' }
const PRODUCT_SEEDS: Seed[] = PRODUCT_ASSIGNED.map((t) => ({
  key: t.key,
  title: t.title,
  state: t.state,
  ...(t.sprint ? { sprint: PRODUCT_SPRINT } : {}),
  type: t.type,
  priority: t.priority,
  description: t.description,
  labels: t.labels,
  comments: t.comments ?? []
}))

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

/** A small stable number from a string, so the same demo query always finds the same tickets. */
function hashOf(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/** Synthetic tickets for a query: between 4 and 15, a stable share of them done or in progress. */
export function demoSearch(query: string, limit: number): TicketSummary[] {
  const h = hashOf(query.trim().toLowerCase())
  const total = 4 + (h % 12)
  const done = Math.floor(total * (((h >> 4) % 70) / 100))
  const inProgress = Math.min(total - done, 1 + ((h >> 8) % 3))
  const prefix = 100 + (h % 800)
  return Array.from({ length: Math.min(total, limit) }, (_, i) => {
    const state = STATES[i < done ? 'done' : i < done + inProgress ? 'progress' : 'todo']!
    const key = `DEMO-${prefix + i}`
    return { key, title: `Demo work item ${i + 1} for "${query.trim().slice(0, 40)}"`, status: state.name, category: state.category, url: `https://demo.example.com/browse/${key}` }
  })
}

function minutesAgo(m: number): number {
  return Date.now() - m * 60_000
}

export class DemoTracker implements TicketTracker {
  readonly provider: string
  readonly capabilities: TrackerCapabilities = { sprints: true, transitions: true, comments: true, assign: true, search: true, create: true }
  private readonly seeds: Seed[]
  private readonly product: boolean
  private readonly state: Map<string, keyof typeof STATES>
  private readonly extraComments = new Map<string, TicketComment[]>()
  /** Issues created in this run (kept in memory only). */
  readonly created: (CreateIssueInput & CreatedIssue)[] = []

  /** `scenario: 'team-lead'` serves the team-lead scenario's tickets and milestone queries instead of the generic ones. */
  constructor(provider = 'jira', options: { scenario?: string } = {}) {
    this.provider = provider
    this.product = options.scenario === 'team-lead'
    this.seeds = this.product ? PRODUCT_SEEDS : SEEDS
    this.state = new Map(this.seeds.map((s) => [s.key, s.state]))
  }

  isTicketKey(text: string): boolean {
    return isTicketKey(text, { provider: this.provider })
  }

  async testConnection(): Promise<ConnectionTest> {
    return { ok: true, account: 'Demo User' }
  }

  async listAssigned(options: ListTicketsOptions = {}): Promise<Ticket[]> {
    const hidden = new Set((options.ignoredStatuses ?? []).map((s) => s.toLowerCase()))
    return this.seeds.map((s) => this.ticket(s)).filter((t) => t.category !== 'done' && !hidden.has(t.status.toLowerCase()))
  }

  async getTicket(key: string): Promise<TicketDetail | null> {
    const seed = this.seeds.find((s) => s.key === key)
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

  async searchByQuery(query: string, options?: SearchOptions): Promise<TicketSummary[]> {
    if (!query.trim()) throw new TrackerError('The query is empty')
    const known = this.product ? PRODUCT_QUERY_RESULTS[query.trim()] : undefined
    return known ? known.slice(0, searchLimit(options)) : demoSearch(query, searchLimit(options))
  }

  /** Tickets by key: the seeded ones with their current state, the scenario's query results, and the issues created in this run. */
  async readTickets(keys: readonly string[]): Promise<TicketSummary[]> {
    const out: TicketSummary[] = []
    for (const key of new Set(keys.map((k) => k.trim().toUpperCase()))) {
      const seed = this.seeds.find((s) => s.key === key)
      if (seed) {
        const t = this.ticket(seed)
        out.push({ key, title: t.title, status: t.status, category: t.category, ...(t.url ? { url: t.url } : {}) })
        continue
      }
      const known = this.product ? productTicket(key) : undefined
      if (known) {
        out.push(known)
        continue
      }
      const created = this.created.find((c) => c.key === key)
      if (created) out.push({ key, title: created.title, status: STATES.todo!.name, category: 'todo', ...(created.url ? { url: created.url } : {}) })
    }
    return out
  }

  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    if (!input.project.trim()) throw new TrackerError('No project is set')
    if (!input.title.trim()) throw new TrackerError('The title is empty')
    const key = `${input.project.trim().toUpperCase()}-${900 + this.created.length}`
    const issue = { key, url: `https://demo.example.com/browse/${key}` }
    this.created.push({ ...input, ...issue })
    return issue
  }

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
