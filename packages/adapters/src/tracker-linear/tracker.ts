import {
  TrackerError,
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
  type TicketDetail,
  type TicketRef,
  type TicketSprint,
  type TicketTracker,
  type TicketTransition,
  type TrackerCapabilities
} from '@workhub/core'
import { describeNetworkError, fetchClient, parseJson, type HttpClient } from '../shared/http'

export interface LinearOptions {
  /** Personal API key (Linear: Settings, Account, Security & access). */
  apiKey: string
  /** GraphQL endpoint; Linear's own by default. */
  endpoint?: string
  /** Team keys of the profile (`ENG` for `ENG-12`); make key recognition exact. */
  projectKeys?: string[]
  http?: HttpClient
  /** Clock for telling future cycles from past ones (tests). */
  now?: () => number
}

type Json = Record<string, any>

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql'

const ISSUE_FIELDS = `identifier title url priorityLabel state { name type } assignee { name } cycle { id name number startsAt endsAt isActive }`
const LIST_EXTRA = `description comments(first: 20) { nodes { body } }`

/** Linear's state types: backlog and unstarted are to-do, started is in progress, the rest is done. */
export function linearCategory(type: unknown): StatusCategory {
  return type === 'started' ? 'inProgress' : type === 'completed' || type === 'canceled' ? 'done' : 'todo'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a Linear search query names:
 * - `team:ENG label:Bug` (or `label:"Needs triage"`): the issues of a team with that label;
 * - `project:Checkout revamp`, or the bare project name or id: the issues of that project.
 */
export type LinearQuery = { kind: 'project'; project: string } | { kind: 'teamLabel'; team: string; label: string }

export function parseLinearQuery(query: string): LinearQuery | null {
  const q = query.trim()
  if (!q) return null
  const team = /(?:^|\s)team:\s*([A-Za-z0-9_-]+)/i.exec(q)?.[1]
  const label = /(?:^|\s)label:\s*(?:"([^"]+)"|(.+?))\s*(?=\s(?:team|project):|$)/i.exec(q)
  const labelName = (label?.[1] ?? label?.[2])?.trim()
  if (team && labelName) return { kind: 'teamLabel', team: team.toUpperCase(), label: labelName }
  if (team || label) return null
  const project = q.replace(/^project:\s*/i, '').replace(/^"(.*)"$/, '$1').trim()
  return project ? { kind: 'project', project } : null
}

/** The issue filter of a parsed query. */
function linearFilter(q: LinearQuery): Json {
  if (q.kind === 'teamLabel') return { team: { key: { eq: q.team } }, labels: { some: { name: { eqIgnoreCase: q.label } } } }
  return { project: UUID.test(q.project) ? { id: { eq: q.project } } : { name: { eqIgnoreCase: q.project } } }
}

/** Linear (GraphQL) behind the TicketTracker port. Cycles are the sprints. */
export class LinearTracker implements TicketTracker {
  readonly provider = 'linear'
  readonly capabilities: TrackerCapabilities = { sprints: true, transitions: true, comments: true, assign: true, search: true, create: true }
  private readonly endpoint: string
  private readonly http: HttpClient
  private readonly now: () => number
  private readonly issueIds = new Map<string, string>()

  constructor(private readonly options: LinearOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint)
    this.http = options.http ?? fetchClient
    this.now = options.now ?? Date.now
  }

  isTicketKey(text: string): boolean {
    return isTicketKey(text, { provider: 'linear', projectKeys: this.options.projectKeys })
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const data = await this.query('query { viewer { name email } }')
      return { ok: true, account: String(data['viewer']?.name ?? data['viewer']?.email ?? 'Linear') }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listAssigned(options: ListTicketsOptions = {}): Promise<Ticket[]> {
    const data = await this.query(
      `query { viewer { assignedIssues(first: 100, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} ${LIST_EXTRA} } } } }`
    )
    const hidden = new Set((options.ignoredStatuses ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))
    const nodes = (data['viewer']?.assignedIssues?.nodes as Json[] | undefined) ?? []
    return nodes.map((n) => this.toTicket(n)).filter((t) => !hidden.has(t.status.toLowerCase()))
  }

  async getTicket(key: string): Promise<TicketDetail | null> {
    let issue: Json | null
    try {
      const data = await this.query(
        `query($id: String!) { issue(id: $id) { id ${ISSUE_FIELDS} description createdAt updatedAt creator { name } labels { nodes { name } }
          parent { identifier title state { name type } } children { nodes { identifier title state { name type } } }
          comments(first: 50) { nodes { id body createdAt user { name } } } } }`,
        { id: key }
      )
      issue = (data['issue'] as Json | null) ?? null
    } catch (error) {
      if (error instanceof TrackerError && error.status === 404) return null
      throw error
    }
    if (!issue) return null
    this.issueIds.set(key, String(issue['id']))
    const comments = ((issue['comments']?.nodes as Json[] | undefined) ?? [])
      .map((c) => ({ id: String(c['id']), author: String(c['user']?.name ?? ''), createdAt: parseDate(c['createdAt']), body: String(c['body'] ?? '') }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    return {
      ...this.toTicket(issue),
      description: issue['description'] || undefined,
      reporter: issue['creator']?.name ?? undefined,
      labels: ((issue['labels']?.nodes as Json[] | undefined) ?? []).map((l) => String(l['name'])),
      createdAt: parseDate(issue['createdAt']),
      updatedAt: parseDate(issue['updatedAt']),
      comments,
      parent: issue['parent'] ? toRef(issue['parent']) : undefined,
      children: ((issue['children']?.nodes as Json[] | undefined) ?? []).map(toRef)
    }
  }

  async transitions(key: string): Promise<TicketTransition[]> {
    const data = await this.query(`query($id: String!) { issue(id: $id) { team { states { nodes { id name type } } } } }`, { id: key })
    return ((data['issue']?.team?.states?.nodes as Json[] | undefined) ?? []).map((s) => ({
      id: String(s['id']),
      name: String(s['name']),
      status: String(s['name']),
      category: linearCategory(s['type'])
    }))
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.update(key, { stateId: transitionId })
  }

  async addComment(key: string, text: string): Promise<void> {
    const body = text.trim()
    if (!body) throw new TrackerError('The comment is empty')
    const issueId = await this.issueId(key)
    const data = await this.query(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body } })
    if (!data['commentCreate']?.success) throw new TrackerError('Linear did not save the comment')
  }

  async assignToMe(key: string): Promise<void> {
    const data = await this.query('query { viewer { id } }')
    const assigneeId = data['viewer']?.id
    if (!assigneeId) throw new TrackerError('Could not read your Linear account')
    await this.update(key, { assigneeId })
  }

  /** The issues of a project, or of a team with a label (see `parseLinearQuery`), any status. */
  async searchByQuery(query: string, options?: SearchOptions): Promise<TicketSummary[]> {
    const parsed = parseLinearQuery(query)
    if (!parsed) throw new TrackerError('Use a project name or id, or "team:KEY label:Name"')
    const limit = searchLimit(options)
    const filter = linearFilter(parsed)
    const out: TicketSummary[] = []
    let after: string | null = null
    while (out.length < limit) {
      const data = await this.query(
        `query($filter: IssueFilter, $first: Int!, $after: String) { issues(filter: $filter, first: $first, after: $after) { nodes { identifier title url state { name type } } pageInfo { hasNextPage endCursor } } }`,
        { filter, first: Math.min(100, limit - out.length), after }
      )
      const nodes = (data['issues']?.nodes as Json[] | undefined) ?? []
      for (const n of nodes) {
        out.push({ key: String(n['identifier']), title: String(n['title'] ?? ''), status: String(n['state']?.name ?? ''), category: linearCategory(n['state']?.type), ...(typeof n['url'] === 'string' ? { url: n['url'] } : {}) })
      }
      const page = data['issues']?.pageInfo as Json | undefined
      after = page?.['hasNextPage'] && typeof page['endCursor'] === 'string' ? page['endCursor'] : null
      if (!after || nodes.length === 0) break
    }
    return out.slice(0, limit)
  }

  /** A new issue in the team with key `input.project`; labels are matched by name in that team, unknown ones skipped. */
  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const teamKey = input.project.trim().toUpperCase()
    const title = input.title.trim()
    if (!teamKey) throw new TrackerError('No Linear team is set')
    if (!title) throw new TrackerError('The title is empty')
    const teams = await this.query(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id labels(first: 250) { nodes { id name } } } } }`, { key: teamKey })
    const team = (teams['teams']?.nodes as Json[] | undefined)?.[0]
    if (!team?.['id']) throw new TrackerError(`Linear did not find the team ${teamKey}`, 404)
    const wanted = new Set((input.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    const labelIds = ((team['labels']?.nodes as Json[] | undefined) ?? []).filter((l) => wanted.has(String(l['name']).toLowerCase())).map((l) => String(l['id']))
    const description = input.description.trim()
    const data = await this.query(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`, {
      input: {
        teamId: String(team['id']),
        title,
        ...(description ? { description } : {}),
        // Linear's priorities: 1 urgent, 2 high, 3 medium, 4 low (0 none): the generic scale as is.
        ...(input.priority ? { priority: input.priority } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {})
      }
    })
    const issue = data['issueCreate']?.issue as Json | undefined
    if (!data['issueCreate']?.success || typeof issue?.['identifier'] !== 'string') throw new TrackerError('Linear did not create the issue')
    return { key: issue['identifier'], ...(typeof issue['url'] === 'string' ? { url: issue['url'] } : {}) }
  }

  private async update(key: string, input: Json): Promise<void> {
    const id = await this.issueId(key)
    const data = await this.query(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input })
    if (!data['issueUpdate']?.success) throw new TrackerError('Linear did not apply the change')
  }

  /** The UUID of an issue key, read once. */
  private async issueId(key: string): Promise<string> {
    const known = this.issueIds.get(key)
    if (known) return known
    const data = await this.query(`query($id: String!) { issue(id: $id) { id } }`, { id: key })
    const id = data['issue']?.id as string | undefined
    if (!id) throw new TrackerError(`Linear did not find ${key}`, 404)
    this.issueIds.set(key, id)
    return id
  }

  private toTicket(n: Json): Ticket {
    const text = [n['description'], ...((n['comments']?.nodes as Json[] | undefined) ?? []).map((c) => c['body'])].filter((x) => typeof x === 'string').join('\n')
    const pullRequestUrls = pullRequestUrlsIn(text)
    return {
      key: String(n['identifier']),
      provider: 'linear',
      title: String(n['title'] ?? ''),
      status: String(n['state']?.name ?? ''),
      category: linearCategory(n['state']?.type),
      sprint: this.toSprint(n['cycle']),
      assignee: n['assignee']?.name ?? undefined,
      priority: n['priorityLabel'] && n['priorityLabel'] !== 'No priority' ? n['priorityLabel'] : undefined,
      url: typeof n['url'] === 'string' ? n['url'] : undefined,
      pullRequestUrls: pullRequestUrls.length > 0 ? pullRequestUrls : undefined
    }
  }

  /** A cycle that is running is active, one that has not started is future, a finished one is no sprint. */
  private toSprint(cycle: Json | null | undefined): TicketSprint | undefined {
    if (!cycle) return undefined
    const starts = parseDate(cycle['startsAt'])
    const ends = parseDate(cycle['endsAt'])
    const now = this.now()
    const state = cycle['isActive'] ? 'active' : starts !== undefined && starts > now ? 'future' : ends !== undefined && ends < now ? 'closed' : 'future'
    if (state === 'closed') return undefined
    const name = cycle['name'] || `Cycle ${cycle['number'] ?? ''}`.trim()
    return { id: String(cycle['id']), name: String(name), state, startDate: typeof cycle['startsAt'] === 'string' ? cycle['startsAt'] : undefined }
  }

  private async query(query: string, variables?: Json): Promise<Json> {
    let response
    try {
      response = await this.http({
        method: 'POST',
        url: this.endpoint,
        headers: { Authorization: this.options.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables })
      })
    } catch (error) {
      throw new TrackerError(describeNetworkError(error, new URL(this.endpoint).host))
    }
    const json = parseJson(response.text) as Json | undefined
    const graphqlError = (json?.['errors'] as Json[] | undefined)?.[0]
    if (response.status === 401 || graphqlError?.['extensions']?.type === 'authentication error') throw new TrackerError('Linear rejected the API key', 401)
    if (response.status < 200 || response.status >= 300 || graphqlError) {
      const message = String(graphqlError?.['message'] ?? `Linear answered ${response.status}`)
      throw new TrackerError(/not found/i.test(message) ? `Linear did not find the ticket (${message})` : message, /not found/i.test(message) ? 404 : response.status)
    }
    return (json?.['data'] as Json | undefined) ?? {}
  }
}

function normalizeEndpoint(input: string | undefined): string {
  const raw = (input ?? '').trim().replace(/\/+$/, '')
  if (!raw) return DEFAULT_ENDPOINT
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !local) throw new TrackerError('The Linear endpoint must use https')
  return url.pathname === '/' || url.pathname === '' ? `${url.origin}/graphql` : url.toString()
}

function parseDate(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

function toRef(n: Json): TicketRef {
  return { key: String(n['identifier']), title: String(n['title'] ?? ''), status: String(n['state']?.name ?? ''), category: linearCategory(n['state']?.type) }
}
