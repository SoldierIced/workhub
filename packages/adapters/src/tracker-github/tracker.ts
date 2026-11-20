import {
  TrackerError,
  isTicketKey,
  pullRequestUrlsIn,
  searchLimit,
  type ConnectionTest,
  type CreateIssueInput,
  type CreatedIssue,
  type ListTicketsOptions,
  type SearchOptions,
  type StatusCategory,
  type Ticket,
  type TicketDetail,
  type TicketSummary,
  type TicketTracker,
  type TicketTransition,
  type TrackerCapabilities
} from '@workhub/core'
import { CliNotFoundError, failureText, type CliResult, type CliRunner } from '../shared/cli'

export interface GitHubIssuesOptions {
  run: CliRunner
  /** Web host; set for GitHub Enterprise Server. Defaults to github.com. */
  host?: string
  /** `owner/repo` list the issues are read from. Empty: `fallbackRepositories`, else every repository. */
  repositories?: string[]
  /** Where the repositories come from when none is listed (the remotes of the profile's folders). */
  fallbackRepositories?: () => Promise<string[]>
}

type Json = Record<string, any>

/** At most this many assigned issues, read in at most `LIST_PAGES` pages of 100. */
const LIST_CAP = 500
const LIST_PAGES = 5
/** GitHub's search API never returns more than 1000 results (10 pages of 100). */
const SEARCH_PAGES = 10
const COMMENT_CAP = 100
/** GitHub limits the operators of a search query, so a long repository list is read in groups. */
const REPOS_PER_QUERY = 5
const ISSUES_PER_REQUEST = 40
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** An open issue is to-do; a closed one is done, whatever the reason (completed, not planned, duplicate). */
export function githubIssueCategory(state: unknown): StatusCategory {
  return String(state).toLowerCase() === 'closed' ? 'done' : 'todo'
}

/** `Open`, `Closed`, or `Closed (not planned)` / `Closed (duplicate)` from the close reason. */
export function githubIssueStatus(state: unknown, reason?: unknown): string {
  if (githubIssueCategory(state) !== 'done') return 'Open'
  const why = String(reason ?? '').toLowerCase().replace(/_/g, ' ')
  return why === 'not planned' || why === 'duplicate' ? `Closed (${why})` : 'Closed'
}

/** `owner/repo#12`, `#12` (in `fallbackRepo`) or an issue URL as a repository and a number. */
export function parseIssueKey(text: string, fallbackRepo?: string): { repo: string; number: number } | null {
  const t = text.trim()
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(t) ?? /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/i.exec(t)
  if (m) return { repo: m[1]!.toLowerCase(), number: Number(m[2]) }
  const bare = /^#(\d+)$/.exec(t)
  return bare && fallbackRepo ? { repo: fallbackRepo.toLowerCase(), number: Number(bare[1]) } : null
}

const keyOf = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`

/** The repository of a search or REST issue (`repository_url` ends in `/repos/owner/repo`). */
function repoOfItem(n: Json): string {
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(String(n['repository_url'] ?? ''))
  return m ? m[1]! : /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\//.exec(String(n['html_url'] ?? ''))?.[1] ?? ''
}

function parseDate(value: unknown): number | undefined {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** GitHub Issues through the `gh` CLI and the user's own `gh auth login`: no token is stored by Workhub. */
export class GitHubIssuesTracker implements TicketTracker {
  readonly provider = 'github-issues'
  readonly capabilities: TrackerCapabilities = { sprints: false, transitions: true, comments: true, assign: true, search: true, create: true }
  private readonly run: CliRunner
  private readonly host: string
  private login: string | null = null

  constructor(private readonly options: GitHubIssuesOptions) {
    this.run = options.run
    this.host = options.host ?? 'github.com'
  }

  isTicketKey(text: string): boolean {
    return isTicketKey(text, { provider: 'github-issues' })
  }

  private get hostArgs(): string[] {
    return this.host === 'github.com' ? [] : ['--hostname', this.host]
  }

  private async gh(args: string[], fallback: string): Promise<CliResult> {
    let result: CliResult
    try {
      result = await this.run('gh', args)
    } catch (e) {
      if (e instanceof CliNotFoundError) throw new TrackerError('The GitHub CLI (gh) is not installed')
      throw e
    }
    if (result.code !== 0) {
      const status = /\(HTTP (\d{3})\)/.exec(result.stderr)?.[1]
      throw new TrackerError(failureText(result, fallback), status ? Number(status) : undefined)
    }
    return result
  }

  /** A REST call; `fields` are sent as-is (never read from files), as the query string for GET. */
  private async api(method: 'GET' | 'POST' | 'PATCH', path: string, fields: string[] = [], fallback = 'GitHub request failed'): Promise<any> {
    const args = ['api', ...this.hostArgs, '-X', method, path]
    for (const f of fields) args.push('-f', f)
    const result = await this.gh(args, fallback)
    try {
      return result.stdout.trim() ? JSON.parse(result.stdout) : {}
    } catch {
      throw new TrackerError('GitHub returned an answer Workhub could not read')
    }
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      // `auth token` is read locally: being offline does not look like being signed out.
      const token = await this.run('gh', ['auth', 'token', ...this.hostArgs])
      if (token.code !== 0) return { ok: false, error: 'Not signed in to GitHub: run "gh auth login"' }
      return { ok: true, account: await this.me() }
    } catch (e) {
      if (e instanceof CliNotFoundError) return { ok: false, error: 'The GitHub CLI (gh) is not installed' }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async me(): Promise<string> {
    if (this.login) return this.login
    const result = await this.gh(['api', ...this.hostArgs, 'user', '--jq', '.login'], 'Could not read the GitHub login')
    this.login = result.stdout.trim()
    if (!this.login) throw new TrackerError('Could not read the GitHub login')
    return this.login
  }

  /** The repositories in scope: the listed ones, else the fallback's (folders' remotes), else none (all of GitHub). */
  private async scope(strict = false): Promise<string[]> {
    const listed = (this.options.repositories ?? []).map((r) => r.trim()).filter((r) => REPO.test(r))
    // `strict`: a failure reading the fallback is thrown, not taken for "no repository in scope".
    const fallback = this.options.fallbackRepositories
    const repos = listed.length > 0 ? listed : fallback ? await (strict ? fallback() : fallback().catch(() => [])) : []
    return [...new Set(repos.map((r) => r.toLowerCase()))]
  }

  /** Where a bare `#12` belongs: the only repository in scope. */
  private async defaultRepo(): Promise<string | undefined> {
    const repos = await this.scope()
    return repos.length === 1 ? repos[0] : undefined
  }

  private async target(key: string): Promise<{ repo: string; number: number }> {
    const ref = parseIssueKey(key, await this.defaultRepo())
    if (!ref) throw new TrackerError(`${key} is not a GitHub issue: use owner/repo#123`, 404)
    return ref
  }

  /** Issues matching a search `q`, newest update first, at most `limit`; read per group of repositories. */
  private async searchRaw(q: string, repos: readonly string[], limit: number, pages: number): Promise<Json[]> {
    const groups = repos.length > 0 ? chunks(repos, REPOS_PER_QUERY).map((g) => g.map((r) => `repo:${r}`).join(' ')) : ['']
    const byUrl = new Map<string, Json>()
    for (const group of groups) {
      let got = 0
      for (let page = 1; page <= pages && got < limit; page++) {
        const body = await this.api(
          'GET',
          'search/issues',
          [`q=${`${q} ${group}`.trim()}`, 'sort=updated', 'order=desc', 'per_page=100', `page=${page}`],
          'GitHub search failed'
        )
        const items = Array.isArray(body['items']) ? (body['items'] as Json[]) : []
        for (const n of items) {
          got += 1
          if (n['pull_request'] || typeof n['html_url'] !== 'string') continue
          byUrl.set(n['html_url'], n)
        }
        if (items.length < 100) break
      }
    }
    return [...byUrl.values()].sort((a, b) => (parseDate(b['updated_at']) ?? 0) - (parseDate(a['updated_at']) ?? 0)).slice(0, limit)
  }

  async listAssigned(options: ListTicketsOptions = {}): Promise<Ticket[]> {
    const items = await this.searchRaw('is:issue is:open assignee:@me', await this.scope(), LIST_CAP, LIST_PAGES)
    const hidden = new Set((options.ignoredStatuses ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))
    return items.map((n) => this.toTicket(n)).filter((t) => !hidden.has(t.status.toLowerCase()))
  }

  async getTicket(key: string): Promise<TicketDetail | null> {
    const ref = await this.target(key)
    let issue: Json
    try {
      issue = await this.api('GET', `repos/${ref.repo}/issues/${ref.number}`, [], 'Could not read the issue')
    } catch (error) {
      if (error instanceof TrackerError && error.status === 404) return null
      throw error
    }
    const raw = await this.api('GET', `repos/${ref.repo}/issues/${ref.number}/comments`, [`per_page=${COMMENT_CAP}`], 'Could not read the comments')
    const comments = (Array.isArray(raw) ? (raw as Json[]) : []).map((c) => ({
      id: String(c['id']),
      author: String(c['user']?.login ?? ''),
      createdAt: parseDate(c['created_at']),
      body: String(c['body'] ?? '')
    }))
    const description = typeof issue['body'] === 'string' && issue['body'] ? issue['body'] : undefined
    const urls = pullRequestUrlsIn([description ?? '', ...comments.map((c) => c.body)].join('\n'))
    return {
      ...this.toTicket({ ...issue, repository_url: `https://api.github.com/repos/${ref.repo}` }),
      pullRequestUrls: urls.length > 0 ? urls : undefined,
      description,
      reporter: issue['user']?.login ?? undefined,
      labels: ((issue['labels'] as Json[] | undefined) ?? []).map((l) => String(typeof l === 'string' ? l : l['name'])),
      createdAt: parseDate(issue['created_at']),
      updatedAt: parseDate(issue['updated_at']),
      comments,
      children: []
    }
  }

  /** Open issues can be closed (as completed or as not planned); closed ones reopened. */
  async transitions(key: string): Promise<TicketTransition[]> {
    const ref = await this.target(key)
    const issue = await this.api('GET', `repos/${ref.repo}/issues/${ref.number}`, [], 'Could not read the issue')
    if (githubIssueCategory(issue['state']) === 'done') return [{ id: 'reopen', name: 'Reopen', status: 'Open', category: 'todo' }]
    return [
      { id: 'close', name: 'Close as completed', status: 'Closed', category: 'done' },
      { id: 'close-not-planned', name: 'Close as not planned', status: 'Closed (not planned)', category: 'done' }
    ]
  }

  async transition(key: string, transitionId: string): Promise<void> {
    const ref = await this.target(key)
    const change: Record<string, string[]> = {
      close: ['state=closed', 'state_reason=completed'],
      'close-not-planned': ['state=closed', 'state_reason=not_planned'],
      reopen: ['state=open', 'state_reason=reopened']
    }
    const fields = change[transitionId]
    if (!fields) throw new TrackerError(`Unknown transition ${transitionId}`)
    await this.api('PATCH', `repos/${ref.repo}/issues/${ref.number}`, fields, 'GitHub did not apply the change')
  }

  async addComment(key: string, text: string): Promise<void> {
    const body = text.trim()
    if (!body) throw new TrackerError('The comment is empty')
    const ref = await this.target(key)
    await this.api('POST', `repos/${ref.repo}/issues/${ref.number}/comments`, [`body=${body}`], 'GitHub did not save the comment')
  }

  async assignToMe(key: string): Promise<void> {
    const ref = await this.target(key)
    await this.api('POST', `repos/${ref.repo}/issues/${ref.number}/assignees`, [`assignees[]=${await this.me()}`], 'GitHub did not assign the issue')
  }

  /**
   * Issues matching GitHub's search syntax (`milestone:"v1.2" label:bug`), any status. Without a
   * `repo:`, `org:` or `user:` qualifier the query is limited to the repositories in scope.
   */
  async searchByQuery(query: string, options?: SearchOptions): Promise<TicketSummary[]> {
    const q = query.trim()
    if (!q) throw new TrackerError('Write a GitHub issue search, e.g. repo:owner/name milestone:"v1.0"')
    const limit = searchLimit(options)
    const scoped = /(?:^|\s)-?(?:repo|org|user):/i.test(q)
    const items = await this.searchRaw(`is:issue ${q}`, scoped ? [] : await this.scope(), limit, SEARCH_PAGES)
    return items.map((n) => this.toSummary(n))
  }

  /**
   * The issue search of the web site for the query, limited to the repositories in scope like
   * `searchByQuery`. Undefined for an empty query, or when more repositories are in scope than one
   * search takes, or when reading them fails (a link that shows other results would be worse than none).
   */
  async queryUrl(query: string): Promise<string | undefined> {
    const q = query.trim()
    if (!q) return undefined
    const scoped = /(?:^|\s)-?(?:repo|org|user):/i.test(q)
    let repos: string[] = []
    if (!scoped) {
      try {
        repos = await this.scope(true)
      } catch {
        return undefined
      }
    }
    if (repos.length > REPOS_PER_QUERY) return undefined
    const text = [`is:issue ${q}`, ...repos.map((r) => `repo:${r}`)].join(' ')
    return `https://${this.host}/search?q=${encodeURIComponent(text)}&type=issues`
  }

  /** Issues by key in as few requests as possible: one GraphQL query per group of 40. Unknown keys are left out. */
  async readTickets(keys: readonly string[]): Promise<TicketSummary[]> {
    const fallback = await this.defaultRepo()
    const wanted = new Map<string, { repo: string; number: number }>()
    for (const raw of keys) {
      const ref = parseIssueKey(raw, fallback)
      if (ref) wanted.set(keyOf(ref.repo, ref.number), ref)
    }
    const out: TicketSummary[] = []
    for (const group of chunks([...wanted], ISSUES_PER_REQUEST)) {
      const body = group
        .map(([, ref], i) => {
          const [owner, name] = ref.repo.split('/')
          return `i${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issue(number: ${ref.number}) { title url state stateReason createdAt updatedAt assignees(first: 1) { nodes { login } } } }`
        })
        .join(' ')
      const result = await this.run('gh', ['api', ...this.hostArgs, 'graphql', '-f', `query=query { ${body} }`]).catch((e) => {
        if (e instanceof CliNotFoundError) throw new TrackerError('The GitHub CLI (gh) is not installed')
        throw e
      })
      let data: Json | undefined
      try {
        data = (JSON.parse(result.stdout) as Json)['data']
      } catch {
        data = undefined
      }
      // A missing issue makes `gh` exit non-zero but still answers with the others.
      if (!data) throw new TrackerError(failureText(result, 'GitHub returned an answer Workhub could not read'))
      group.forEach(([key], i) => {
        const issue = data![`i${i}`]?.issue as Json | undefined
        if (!issue) return
        const login = (issue['assignees']?.nodes as Json[] | undefined)?.[0]?.['login']
        const createdAt = parseDate(issue['createdAt'])
        const updatedAt = parseDate(issue['updatedAt'])
        out.push({
          key,
          title: String(issue['title'] ?? ''),
          status: githubIssueStatus(issue['state'], issue['stateReason']),
          category: githubIssueCategory(issue['state']),
          ...(typeof issue['url'] === 'string' ? { url: issue['url'] } : {}),
          assignee: typeof login === 'string' ? login : null,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {})
        })
      })
    }
    return out
  }

  /** A new issue in the repository `input.project` (`owner/repo`), or the only one in scope. GitHub has no priority: it is ignored. */
  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const repo = (input.project.trim() || (await this.defaultRepo()) || '').toLowerCase()
    const title = input.title.trim()
    if (!REPO.test(repo)) throw new TrackerError('No GitHub repository is set: use owner/repo')
    if (!title) throw new TrackerError('The title is empty')
    const description = input.description.trim()
    const fields = [`title=${title}`, ...(description ? [`body=${description}`] : []), ...(input.labels ?? []).map((l) => l.trim()).filter(Boolean).map((l) => `labels[]=${l}`)]
    const issue = await this.api('POST', `repos/${repo}/issues`, fields, 'GitHub did not create the issue')
    if (typeof issue['number'] !== 'number') throw new TrackerError('GitHub did not create the issue')
    return { key: keyOf(repo, issue['number']), ...(typeof issue['html_url'] === 'string' ? { url: issue['html_url'] } : {}) }
  }

  private toSummary(n: Json): TicketSummary {
    // The first assignee (a REST issue has `assignee` and `assignees`); GitHub gives a login, not a display name.
    const login = n['assignee']?.login ?? (n['assignees'] as Json[] | undefined)?.[0]?.['login']
    const createdAt = parseDate(n['created_at'])
    const updatedAt = parseDate(n['updated_at'])
    return {
      key: keyOf(repoOfItem(n), Number(n['number'])),
      title: String(n['title'] ?? ''),
      status: githubIssueStatus(n['state'], n['state_reason']),
      category: githubIssueCategory(n['state']),
      ...(typeof n['html_url'] === 'string' ? { url: n['html_url'] } : {}),
      assignee: typeof login === 'string' ? login : null,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {})
    }
  }

  private toTicket(n: Json): Ticket {
    const urls = typeof n['body'] === 'string' ? pullRequestUrlsIn(n['body']) : []
    return {
      ...this.toSummary(n),
      provider: 'github-issues',
      assignee: n['assignee']?.login ?? undefined,
      pullRequestUrls: urls.length > 0 ? urls : undefined
    }
  }
}
