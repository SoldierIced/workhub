import {
  TrackerError,
  isTicketKey,
  listedPullRequests,
  type ConnectionTest,
  type ListTicketsOptions,
  type StatusCategory,
  type Ticket,
  type TicketComment,
  type TicketDetail,
  type TicketRef,
  type TicketSprint,
  type TicketTracker,
  type TicketTransition,
  type TrackerCapabilities
} from '@workhub/core'
import { describeNetworkError, fetchClient, parseJson, type HttpClient } from '../shared/http'
import { adfToText, textToAdf } from './adf'

export interface JiraOptions {
  /** Site URL, e.g. `https://acme.atlassian.net`. */
  site: string
  email: string
  /** API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
  token: string
  /** Project keys of the profile; make key recognition exact and case-insensitive. */
  projectKeys?: string[]
  http?: HttpClient
}

const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint'
const LIST_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'description', 'comment']
const DETAIL_FIELDS = 'summary,status,issuetype,priority,assignee,reporter,created,updated,labels,description,comment,parent,subtasks'
const AGILE_CONCURRENCY = 5

type Json = Record<string, any>

/** `https://acme.atlassian.net/`, `acme.atlassian.net` -> `https://acme.atlassian.net`. Plain http only for localhost. */
export function normalizeJiraSite(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new TrackerError('The Jira site is empty')
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !local) throw new TrackerError('The Jira site must use https')
  return url.origin
}

export function statusCategoryOf(key: unknown): StatusCategory {
  return key === 'done' ? 'done' : key === 'new' ? 'todo' : 'inProgress'
}

/** Jira's JQL string literal. */
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Jira Cloud (REST v3 plus the Agile API for sprints) behind the TicketTracker port. */
export class JiraTracker implements TicketTracker {
  readonly provider = 'jira'
  readonly capabilities: TrackerCapabilities = { sprints: true, transitions: true, comments: true, assign: true }
  private readonly site: string
  private readonly auth: string
  private readonly http: HttpClient
  private sprintField: string | undefined
  private accountId: string | undefined

  constructor(private readonly options: JiraOptions) {
    this.site = normalizeJiraSite(options.site)
    this.auth = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`
    this.http = options.http ?? fetchClient
  }

  isTicketKey(text: string): boolean {
    return isTicketKey(text, { provider: 'jira', projectKeys: this.options.projectKeys })
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const me = (await this.request('GET', '/rest/api/3/myself')) as Json
      return { ok: true, account: String(me['displayName'] ?? me['emailAddress'] ?? 'Jira') }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listAssigned(options: ListTicketsOptions = {}): Promise<Ticket[]> {
    const sprintField = await this.findSprintField()
    let jql = 'assignee = currentUser() AND statusCategory != Done'
    const ignored = (options.ignoredStatuses ?? []).map((s) => s.trim()).filter(Boolean)
    if (ignored.length > 0) jql += ` AND status NOT IN (${ignored.map(quote).join(', ')})`
    const fields = sprintField ? [...LIST_FIELDS, sprintField] : LIST_FIELDS
    const result = (await this.request('GET', '/rest/api/3/search/jql', {
      jql: `${jql} ORDER BY updated DESC`,
      fields: fields.join(','),
      maxResults: '100'
    })) as Json
    const tickets = ((result['issues'] as Json[] | undefined) ?? []).flatMap((issue) => {
      const ticket = this.toTicket(issue, sprintField)
      return ticket ? [ticket] : []
    })
    if (!sprintField) await this.fillSprintsFromAgile(tickets)
    return tickets
  }

  async getTicket(key: string): Promise<TicketDetail | null> {
    let issue: Json
    try {
      issue = (await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: DETAIL_FIELDS })) as Json
    } catch (error) {
      if (error instanceof TrackerError && error.status === 404) return null
      throw error
    }
    const base = this.toTicket(issue, undefined)
    if (!base) return null
    const f = (issue['fields'] ?? {}) as Json
    const comments: TicketComment[] = ((f['comment']?.comments as Json[] | undefined) ?? []).map((c) => ({
      id: String(c['id']),
      author: String(c['author']?.displayName ?? ''),
      createdAt: parseDate(c['created']),
      body: adfToText(c['body'])
    }))
    return {
      ...base,
      description: adfToText(f['description']) || undefined,
      reporter: f['reporter']?.displayName,
      labels: (f['labels'] as string[] | undefined) ?? [],
      createdAt: parseDate(f['created']),
      updatedAt: parseDate(f['updated']),
      comments,
      parent: f['parent'] ? toRef(f['parent']) : undefined,
      children: ((f['subtasks'] as Json[] | undefined) ?? []).map(toRef)
    }
  }

  async transitions(key: string): Promise<TicketTransition[]> {
    const result = (await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)) as Json
    return ((result['transitions'] as Json[] | undefined) ?? []).flatMap((t) =>
      t['id'] && t['to']
        ? [{ id: String(t['id']), name: String(t['name'] ?? ''), status: String(t['to'].name ?? ''), category: statusCategoryOf(t['to'].statusCategory?.key) }]
        : []
    )
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, undefined, { transition: { id: transitionId } })
  }

  async addComment(key: string, text: string): Promise<void> {
    const body = textToAdf(text)
    if (body.content.length === 0) throw new TrackerError('The comment is empty')
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, undefined, { body })
  }

  async assignToMe(key: string): Promise<void> {
    if (!this.accountId) {
      const me = (await this.request('GET', '/rest/api/3/myself')) as Json
      this.accountId = me['accountId'] as string | undefined
    }
    if (!this.accountId) throw new TrackerError('Could not read your Jira account')
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, undefined, { accountId: this.accountId })
  }

  /** The id of the Sprint custom field (it differs between sites), found once. */
  private async findSprintField(): Promise<string | undefined> {
    if (this.sprintField !== undefined) return this.sprintField || undefined
    try {
      const fields = (await this.request('GET', '/rest/api/3/field')) as Json[]
      this.sprintField = fields.find((f) => f['schema']?.custom === SPRINT_SCHEMA)?.['id'] ?? ''
    } catch {
      this.sprintField = ''
    }
    return this.sprintField || undefined
  }

  /** Without the Sprint field (no permission to list fields), ask the Agile API per issue. */
  private async fillSprintsFromAgile(tickets: Ticket[]): Promise<void> {
    const queue = [...tickets]
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          const issue = (await this.request('GET', `/rest/agile/1.0/issue/${encodeURIComponent(t.key)}`, { fields: 'sprint' })) as Json
          const sprint = parseSprint(issue['fields']?.sprint)
          if (sprint && sprint.state !== 'closed') t.sprint = sprint
        } catch {
          // A project without boards answers 400/404: the ticket stays in the backlog group.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(AGILE_CONCURRENCY, queue.length) }, worker))
  }

  private toTicket(issue: Json, sprintField: string | undefined): Ticket | null {
    const key = issue['key']
    const f = issue['fields'] as Json | undefined
    if (typeof key !== 'string' || !f?.status) return null
    const sprints = sprintField ? ((f[sprintField] as Json[] | null) ?? []) : []
    const pullRequestUrls = listedPullRequests({ description: adfToText(f['description']), comments: commentsOf(f).map((c) => ({ id: '', author: '', body: c })) })
    return {
      key,
      provider: 'jira',
      title: String(f['summary'] ?? ''),
      status: String(f.status.name ?? ''),
      category: statusCategoryOf(f.status.statusCategory?.key),
      sprint: openSprint(sprints),
      assignee: f['assignee']?.displayName ?? undefined,
      type: f['issuetype']?.name ?? undefined,
      priority: f['priority']?.name ?? undefined,
      url: `${this.site}/browse/${key}`,
      pullRequestUrls: pullRequestUrls.length > 0 ? pullRequestUrls : undefined
    }
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.site)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    let response
    try {
      response = await this.http({
        method,
        url: url.toString(),
        headers: { Authorization: this.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (error) {
      throw new TrackerError(describeNetworkError(error, url.host))
    }
    if (response.status < 200 || response.status >= 300) throw new TrackerError(failureMessage(response.status, response.text), response.status)
    return parseJson(response.text) ?? {}
  }
}

function failureMessage(status: number, text: string): string {
  if (status === 401) return 'Jira rejected the email or API token'
  if (status === 403) return 'Jira denied access to this resource'
  if (status === 404) return 'Jira did not find the site or the ticket'
  const json = parseJson(text) as Json | undefined
  const messages = [...((json?.['errorMessages'] as string[] | undefined) ?? []), ...Object.values((json?.['errors'] as Record<string, string> | undefined) ?? {})]
  return messages.length > 0 ? messages.join(' ') : `Jira answered ${status}`
}

/** Plain text of every comment of an issue's fields. */
function commentsOf(fields: Json): string[] {
  return ((fields['comment']?.comments as Json[] | undefined) ?? []).map((c) => adfToText(c['body']))
}

function parseDate(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

function toRef(issue: Json): TicketRef {
  return {
    key: String(issue['key']),
    title: String(issue['fields']?.summary ?? ''),
    status: String(issue['fields']?.status?.name ?? ''),
    category: statusCategoryOf(issue['fields']?.status?.statusCategory?.key)
  }
}

function parseSprint(value: unknown): TicketSprint | undefined {
  const s = value as Json | null | undefined
  if (!s || s['id'] === undefined || typeof s['name'] !== 'string') return undefined
  const state = s['state'] === 'active' ? 'active' : s['state'] === 'closed' ? 'closed' : 'future'
  return { id: String(s['id']), name: s['name'], state, startDate: typeof s['startDate'] === 'string' ? s['startDate'] : undefined }
}

/** The active sprint of a ticket, else its earliest future one; closed sprints do not count. */
export function openSprint(values: unknown[]): TicketSprint | undefined {
  const open = values.map(parseSprint).filter((s): s is TicketSprint => s !== undefined && s.state !== 'closed')
  return open.find((s) => s.state === 'active') ?? open.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || Number(a.id) - Number(b.id))[0]
}
