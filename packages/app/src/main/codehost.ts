import { createCliRunner, type CliRunner } from '@workhub/adapters/cli'
import { runGit } from '@workhub/adapters/git-review'
import { GitHubCodeHost, createDemoRunner } from '@workhub/adapters/codehost-github'
import { GitLabCodeHost } from '@workhub/adapters/codehost-gitlab'
import {
  appOptions,
  CodeHostError,
  filterPullRequests,
  githubRepoScopeBatches,
  githubScopeFromFilter,
  githubScopeFromRemotes,
  loadMyPullRequests,
  loadPullRequestView,
  mergeRefusal,
  loadReviewQueue,
  allowedRepos,
  normalizePullRequestFilter,
  closePullRequest,
  createPullRequest,
  MERGE_METHODS,
  mergePullRequest,
  postComment,
  submitReview,
  toItem,
  type CodeHost,
  type Connection,
  type MergedList,
  type MergedStore,
  type MergedPullRequest,
  type MergeMethod,
  type NewPullRequest,
  type Profile,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestFilterSettings,
  type PullRequestItem,
  type ReviewAction,
  type WorkhubConfig
} from '@workhub/core'
import { originUrl, type HostFolders, type HostTarget } from './hosts'
import type { IpcRegistrar } from './ipc-guard'
import { MERGED_ANSWER_CAP, MergedSyncer, mergedFailureOf, type MergedFailure, type MergedProfileRead, type MergedTarget } from './merged-sync'
import {
  isPullRequestWindowTab,
  type CodeHostActionResult,
  type CodeHostLists,
  type CreatePullRequestResult,
  type MergeMethodsResult,
  type MergeResult,
  type MergedPullRequestsResult,
  type MergedRequest,
  type MergedScope,
  type PullRequestDetailResult,
  type PullRequestDiffResult,
  type PullRequestViewResult,
  type PullRequestWindowTab
} from '../shared/codehost-api'

const LIST_TTL_MS = 30_000
/** How long a pull request read by URL for the session monitor is kept. */
const ITEM_TTL_MS = 180_000

/** How long a login read stays valid. */
const LOGIN_TTL_MS = 10 * 60_000
/** How long a detail read is served without asking the host again. */
const DETAIL_TTL_MS = 60_000
const DETAIL_MAX = 100
const AUTHORS_MAX = 5_000
/** How long a repository's allowed merge methods are kept. */
const METHODS_TTL_MS = 10 * 60_000
/** How long a merged read is kept per profile and request, and how many are kept. */
const MERGED_TTL_MS = 10 * 60_000
const MERGED_ENTRIES = 20
/** The most merged pull requests a read returns (the newest); more is `truncated`. */
const MERGED_CAP = 3000
/** Merged reads of one call in parallel (repository batches, GitLab projects). */
const MERGED_SCOPES_PARALLEL = 4
/** The longest scope a merged GitHub search takes: its other qualifiers (`is:pr is:merged archived:false merged:A..B author:@me`) use about 100 of the 256 characters. */
const MERGED_SCOPE_MAX = 150
/** The longest period (with the previous one) a merged read accepts. */
const MERGED_MAX_SPAN_MS = 800 * 86_400_000
/** The demo's owner, shown as the scope of its merged read. */
const DEMO_OWNER = 'acme-demo'

type MergedOk = Extract<MergedPullRequestsResult, { ok: true }>

/** A merged request from the renderer, or null when it is not one: finite times, `since < until`, at most 800 days, `mine` a boolean, `allProfiles` an optional boolean. */
export function validMergedRequest(value: unknown): MergedRequest | null {
  if (!value || typeof value !== 'object') return null
  const { since, until, mine, allProfiles, known } = value as Record<string, unknown>
  if (typeof since !== 'number' || typeof until !== 'number' || typeof mine !== 'boolean') return null
  if (allProfiles !== undefined && typeof allProfiles !== 'boolean') return null
  if (known !== undefined && (typeof known !== 'string' || known.length > 64)) return null
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || since >= until || until - since > MERGED_MAX_SPAN_MS) return null
  return { since, until, mine, ...(allProfiles === true ? { allProfiles: true } : {}), ...(typeof known === 'string' ? { known } : {}) }
}

/** A fingerprint of merged items (FNV-1a over what the view shows of each, and the count): equal items, equal version. */
export function mergedVersion(items: readonly MergedPullRequest[]): string {
  // Two 32-bit hashes with different seeds: a false "unchanged" would keep old items on screen.
  let h = 0x811c9dc5
  let g = 0x01234567
  const add = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      h = Math.imul(h ^ c, 0x01000193)
      g = Math.imul(g ^ c, 0x01000193)
    }
  }
  for (const p of items) add(`${p.url}\u0000${p.mergedAt}\u0000${p.title}\u0000${p.author}\u0000${p.base}\u0000${p.branch}\u0000${p.additions ?? ''}\u0000${p.deletions ?? ''}\u0000${p.changedFiles ?? ''}\u0000${p.createdAt ?? ''}\n`)
  return `${items.length}:${(h >>> 0).toString(36)}${(g >>> 0).toString(36)}`
}

/** Search qualifiers joined into queries of at most `max` characters. */
function chunkTokens(tokens: readonly string[], max: number): string[] {
  const out: string[] = []
  let current = ''
  for (const t of tokens) {
    if (current && current.length + 1 + t.length > max) {
      out.push(current)
      current = ''
    }
    current = current ? `${current} ${t}` : t
  }
  if (current) out.push(current)
  return out
}

interface Resolved {
  profileId: string
  host: CodeHost
  key: string
  /** The connection (host) the profile reads through: logins, details and merge methods are kept per host. */
  hostKey: string
  scope: string
  cli: string
  /** The profile's folders, on the host its profile runs on. */
  folders: string[]
  filter?: PullRequestFilterSettings
}

/** One pull request on one host, as a cache key. */
const prKey = (hostKey: string, ref: Pick<PullRequestRef, 'owner' | 'repo' | 'number'>): string => `${hostKey}\n${repoOf(ref)}#${ref.number}`.toLowerCase()
const repoOf = (ref: Pick<PullRequestRef, 'owner' | 'repo'>): string => (ref.repo.includes('/') ? ref.repo : `${ref.owner}/${ref.repo}`)

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** The error of a failed write for the renderer, with the host's reason when it gave one. */
const failureOf = (e: unknown) => ({ ok: false as const, error: messageOf(e), ...(e instanceof CodeHostError && e.kind !== 'failed' ? { kind: e.kind } : {}) })

/** The web host of a connection endpoint (`https://git.example.com/` -> `git.example.com`); undefined for the public defaults. */
function hostOf(endpoint: string | undefined, publicHosts: string[]): string | undefined {
  if (!endpoint) return undefined
  try {
    const host = new URL(endpoint).hostname
    return publicHosts.includes(host) ? undefined : host
  } catch {
    return undefined
  }
}

/**
 * Pull requests for the renderer: picks the code host from the active profile's connection, keeps
 * a short cache of the lists and turns every failure into data the screens can show. Nothing here
 * stores a token: the hosts read through the user's own `gh` / `glab` login.
 */
export class CodeHostService {
  private readonly run: CliRunner
  private readonly hosts = new Map<string, CodeHost>()
  private readonly cache = new Map<string, { at: number; value: CodeHostLists }>()
  /** The signed-in login per host (connection), read on demand and re-checked after `LOGIN_TTL_MS`, a signed-out error or a connection change. */
  private readonly logins = new Map<string, { login: string; at: number }>()
  private readonly loginReads = new Map<string, Promise<string | undefined>>()
  private readonly demoHost: CodeHost | null
  /** Reads of the lists under way: the one running and, for forced callers, the one that follows it. */
  private readonly flights = new Map<string, { running: Promise<CodeHostLists>; queued?: Promise<CodeHostLists> }>()
  private readonly onListsChanged: (() => void) | undefined
  private readonly onChanged: ((url: string, profileId: string | null) => void) | undefined
  /** The host a profile's folders live on. */
  private readonly folderHost: (target: HostTarget) => Pick<HostFolders, 'git'>
  /** Detail reads by pull request (LRU, `DETAIL_MAX` entries). Never holds a value read before a write to that PR. */
  private readonly details = new Map<string, { at: number; value: PullRequestDetail }>()
  private readonly detailFlights = new Map<string, { gen: number; promise: Promise<PullRequestDetail> }>()
  /** The author of each pull request seen: it never changes, so "is it mine" needs no read once known. */
  private readonly authors = new Map<string, string>()
  private readonly methods = new Map<string, { at: number; value: MergeMethod[] }>()
  /** Merged reads kept per profile and request (LRU, `MERGED_ENTRIES`), and the ones under way. */
  private readonly mergedCache = new Map<string, { at: number; value: MergedOk }>()
  /** Profiles (resolved keys) with a write since their last merged read: the next one reads the newest merges even if it read moments ago. */
  private readonly mergedDirty = new Set<string>()
  /** The sync of merged pull requests against the store; null without a store. */
  private readonly mergedSyncer: MergedSyncer | null
  private readonly mergedFlights = new Map<string, { running: Promise<MergedPullRequestsResult>; queued?: Promise<MergedPullRequestsResult> }>()
  /** Per key, how many writes happened: a read that started under another number never stores its result. */
  private readonly generations = new Map<string, number>()

  constructor(
    private readonly loadConfig: () => Promise<WorkhubConfig>,
    options: {
      demo: boolean
      /** Called when a read stored lists that differ from the cached ones (the tray shows the cached lists and never reads). */
      onListsChanged?: () => void
      /** Demo only: the step the synthetic pull requests are at (see the GitHub demo). */
      demoStep?: () => number
      /** Called after a write on a pull request succeeded, so every window drops what it holds of it. */
      onChanged?: (url: string, profileId: string | null) => void
      /** The command runner of the real hosts (tests count the calls through it). */
      run?: CliRunner
      /** Merged pull requests kept between launches. Without one a merged read is kept in memory only. */
      mergedStore?: MergedStore
      /** The host a profile's folders live on; this computer when not given. */
      hostFor?: (target: HostTarget) => Pick<HostFolders, 'git'>
    }
  ) {
    this.folderHost = options.hostFor ?? (() => ({ git: runGit }))
    this.run = options.run ?? createCliRunner()
    this.mergedSyncer = options.mergedStore ? new MergedSyncer(options.mergedStore) : null
    this.onListsChanged = options.onListsChanged
    this.onChanged = options.onChanged
    this.demoHost = options.demo ? new GitHubCodeHost({ run: createDemoRunner(Date.now(), options.demoStep) }) : null
  }

  private hostFor(connection: Connection): { host: CodeHost; cli: string } | null {
    const key = `${connection.id}|${connection.provider}|${connection.endpoint ?? ''}`
    const existing = this.hosts.get(key)
    if (connection.provider === 'github') {
      const host = existing ?? new GitHubCodeHost({ run: this.run, host: hostOf(connection.endpoint, ['github.com', 'api.github.com']) })
      this.hosts.set(key, host)
      return { host, cli: 'gh' }
    }
    if (connection.provider === 'gitlab') {
      const host = existing ?? new GitLabCodeHost({ run: this.run, host: hostOf(connection.endpoint, ['gitlab.com']) })
      this.hosts.set(key, host)
      return { host, cli: 'glab' }
    }
    return null
  }

  /** The `origin` URLs of the folders, read where the profile's folders live; folders without one are skipped. */
  private async remotesOf(folders: string[], profileId: string | null): Promise<string[]> {
    const { git } = this.folderHost({ profileId })
    const out: string[] = []
    for (const folder of folders) {
      const url = await originUrl(git, folder)
      if (url !== null) out.push(url)
    }
    return out
  }

  private async resolve(profileId: string | null): Promise<Resolved | null> {
    if (this.demoHost) return { profileId: 'demo', host: this.demoHost, key: 'demo', hostKey: 'demo', scope: '', cli: 'gh', folders: [] }
    const config = await this.loadConfig()
    const profile: Profile | undefined = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    const connection = config.connections.find((c) => c.id === profile?.connections.codeHost)
    if (!profile || !connection) return null
    const made = this.hostFor(connection)
    if (!made) return null
    const configured = connection.settings['scope']?.trim() ?? ''
    const filter = normalizePullRequestFilter(profile.pullRequests)
    return {
      profileId: profile.id,
      host: made.host,
      key: `${profile.id}|${connection.id}|${connection.endpoint ?? ''}|${configured}|${(profile.folders ?? []).join(',')}|${JSON.stringify(filter)}`,
      hostKey: `${connection.id}|${connection.provider}|${connection.endpoint ?? ''}`,
      scope: configured,
      cli: made.cli,
      folders: profile.folders ?? [],
      filter
    }
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0
  }

  private bump(key: string): void {
    this.generations.set(key, this.generation(key) + 1)
  }

  /**
   * The search queries, one per scope: the profile's repositories (GitHub: `repo:` qualifiers, split
   * into batches the search accepts; none left means nothing to read), else its owners, else the
   * connection's `scope` setting, else (GitHub) the repos behind the profile's folders, else
   * everything. The profile's filter is also applied to the results (`filterPullRequests`), which is
   * all it does on GitLab.
   */
  private async scopesOf(r: Resolved): Promise<string[]> {
    if (r.host.provider === 'github' && r.filter?.repos?.length) return githubRepoScopeBatches(r.filter)
    if (r.host.provider === 'github' && r.filter?.owners?.length) return [githubScopeFromFilter(r.filter)]
    if (r.scope || r.host.provider !== 'github' || r.folders.length === 0) return [r.scope]
    return [githubScopeFromRemotes(await this.remotesOf(r.folders, r.profileId))]
  }

  /**
   * The searches of a merged read and what they were narrowed to. Like `scopesOf`, but sized for the
   * merged query's longer prefix, and on GitLab one project (or group) path per search. `none`: the
   * profile limits nothing, so only the user's own merges may be read.
   */
  private async mergedScopesOf(r: Resolved): Promise<{ scopes: string[]; scope: MergedScope }> {
    if (this.demoHost) return { scopes: [''], scope: { kind: 'owners', values: [DEMO_OWNER] } }
    const github = r.host.provider === 'github'
    const f = r.filter
    if (f?.repos?.length) {
      const repos = allowedRepos(f)
      return { scopes: github ? githubRepoScopeBatches(f, MERGED_SCOPE_MAX) : repos.map((p) => `project:${p}`), scope: { kind: 'repos', values: repos } }
    }
    if (f?.owners?.length) {
      // Owners only: excluded repositories are left to the profile filter afterwards, so no search is ever left
      // with exclusions alone (that would read every merge on the host).
      const users = f.owners.filter((o) => !o.includes('/')).map((o) => `user:${o}`)
      if (github && users.length === 0) return { scopes: [''], scope: { kind: 'none', values: [] } }
      const scopes = github ? chunkTokens(users, MERGED_SCOPE_MAX) : f.owners.map((o) => `group:${o}`)
      return { scopes, scope: { kind: 'owners', values: [...f.owners] } }
    }
    if (r.scope) return { scopes: [r.scope], scope: { kind: 'connection', values: [r.scope] } }
    if (github && r.folders.length > 0) {
      const tokens = githubScopeFromRemotes(await this.remotesOf(r.folders, r.profileId)).split(' ').filter(Boolean)
      if (tokens.length > 0) return { scopes: chunkTokens(tokens, MERGED_SCOPE_MAX), scope: { kind: 'folders', values: tokens.map((t) => t.replace(/^repo:/, '')) } }
    }
    return { scopes: [''], scope: { kind: 'none', values: [] } }
  }

  /**
   * The signed-in login of the resolved host: kept for `LOGIN_TTL_MS`, read once when several callers ask together.
   * `fresh` asks the host again (a write that depends on whose PR it is: after `gh auth switch` the kept login is
   * another account's; the GitHub host answers from a local `gh auth token` while the token is the same). Undefined
   * when it cannot be known.
   */
  private async loginOf(r: Resolved, fresh = false): Promise<string | undefined> {
    const hit = this.logins.get(r.hostKey)
    if (hit && !fresh && Date.now() - hit.at < LOGIN_TTL_MS) return hit.login
    const running = this.loginReads.get(r.hostKey)
    if (running) return running
    const read = r.host
      .status()
      .then((status) => {
        if (status.state === 'ready') {
          this.logins.set(r.hostKey, { login: status.login, at: Date.now() })
          return status.login
        }
        this.logins.delete(r.hostKey)
        return undefined
      })
      .catch(() => undefined)
      .finally(() => this.loginReads.delete(r.hostKey))
    this.loginReads.set(r.hostKey, read)
    return read
  }

  /** A failure that says the login is gone makes the next read ask the host who is signed in. */
  private noteFailure(r: Resolved, e: unknown): void {
    if (e instanceof CodeHostError && e.kind === 'signedOut') this.logins.delete(r.hostKey)
  }

  async lists(profileId: string | null, force = false): Promise<CodeHostLists> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { state: 'notConnected', mine: [], toReview: [] }
    const cached = this.cache.get(resolved.key)
    if (cached && !force && Date.now() - cached.at < LIST_TTL_MS) return cached.value
    const flight = this.flights.get(resolved.key)
    if (flight) {
      // A caller that does not insist shares the read under way; a forced one gets a read that starts after it, so it sees what changed meanwhile.
      if (!force) return flight.running
      flight.queued ??= flight.running.then(
        () => undefined,
        () => undefined
      ).then(() => this.launch(resolved, true))
      return flight.queued
    }
    return this.launch(resolved, force)
  }

  private launch(resolved: Resolved, force: boolean): Promise<CodeHostLists> {
    const key = resolved.key
    const flight: { running: Promise<CodeHostLists>; queued?: Promise<CodeHostLists> } = { running: undefined as never }
    const read = this.read(resolved, this.cache.get(key)?.value, force)
    flight.running = read
    this.flights.set(key, flight)
    const done = () => {
      // With a read queued behind this one, its `launch` replaces the entry.
      if (this.flights.get(key) === flight && !flight.queued) this.flights.delete(key)
    }
    read.then(done, done)
    return read
  }

  /** The lists this service already holds for the profile, whatever their age; null when none. Never reads the host. */
  async cachedLists(profileId: string | null): Promise<CodeHostLists | null> {
    const resolved = await this.resolve(profileId)
    return (resolved && this.cache.get(resolved.key)?.value) || null
  }

  private async read(resolved: Resolved, previous: CodeHostLists | undefined, force: boolean): Promise<CodeHostLists> {
    const empty = { mine: [], toReview: [] }
    const { host, cli } = resolved
    const demo = this.demoHost !== null
    const generation = this.generation(`list|${resolved.key}`)
    // The sign-in check is skipped while the login is known; a forced read asks again (the host answers from its own cache unless the token changed).
    const known = this.logins.get(resolved.hostKey)
    let login = !force && known && Date.now() - known.at < LOGIN_TTL_MS ? known.login : undefined
    if (!login) {
      const status = await host.status()
      if (status.state !== 'ready') {
        this.logins.delete(resolved.hostKey)
        const base = { provider: host.provider, cli, ...empty, demo }
        if (status.state === 'error') {
          // A transient failure (right after wake, a VPN drop) keeps the last good lists, so the screen keeps its content and shows the error line. Not cached: the next call asks again.
          const last = previous
          return { ...base, mine: last?.mine ?? [], toReview: last?.toReview ?? [], login: last?.login, updatedAt: last?.updatedAt, state: 'error', message: status.message }
        }
        return { ...base, state: status.state }
      }
      login = status.login
      this.logins.set(resolved.hostKey, { login, at: Date.now() })
    }
    const scopes = await this.scopesOf(resolved)
    const [mine, toReview] = await Promise.allSettled([this.loadAll(scopes, (query) => loadMyPullRequests(host, query)), this.loadAll(scopes, (query) => loadReviewQueue(host, query))])
    const signedOut = [mine, toReview].find((r) => r.status === 'rejected' && r.reason instanceof CodeHostError && r.reason.kind === 'signedOut')
    if (signedOut) {
      this.logins.delete(resolved.hostKey)
      return { state: 'signedOut', provider: host.provider, cli, ...empty, demo }
    }
    const failures = [mine, toReview].flatMap((r) => (r.status === 'rejected' ? [messageOf(r.reason)] : []))
    const value: CodeHostLists = {
      state: mine.status === 'rejected' && toReview.status === 'rejected' ? 'error' : 'ready',
      provider: host.provider,
      cli,
      login,
      // A list that failed keeps what the last read found, like Workhub 1.
      mine: mine.status === 'fulfilled' ? filterPullRequests(mine.value, resolved.filter) : (previous?.mine ?? []),
      toReview: toReview.status === 'fulfilled' ? filterPullRequests(toReview.value, resolved.filter) : (previous?.toReview ?? []),
      message: failures[0],
      updatedAt: failures.length < 2 ? Date.now() : previous?.updatedAt,
      demo
    }
    for (const i of [...value.mine, ...value.toReview]) this.authors.set(prKey(resolved.hostKey, i.pr), i.pr.author)
    if (this.authors.size > AUTHORS_MAX) this.authors.clear()
    // A write finished while this read ran: what it found may predate it, so it is handed out but not kept.
    if (generation !== this.generation(`list|${resolved.key}`)) return value
    this.cache.set(resolved.key, { at: Date.now(), value })
    if (!previous || JSON.stringify({ ...previous, updatedAt: 0 }) !== JSON.stringify({ ...value, updatedAt: 0 })) this.onListsChanged?.()
    return value
  }

  /** One list read per scope, in parallel, merged without duplicates and newest first. */
  private async loadAll(scopes: string[], load: (query: { scope: string }) => Promise<PullRequestItem[]>): Promise<PullRequestItem[]> {
    if (scopes.length === 0) return []
    if (scopes.length === 1) return load({ scope: scopes[0]! })
    const seen = new Set<string>()
    const merged = (await Promise.all(scopes.map((scope) => load({ scope })))).flat().filter((i) => !seen.has(i.pr.url) && Boolean(seen.add(i.pr.url)))
    return merged.sort((a, b) => (b.pr.updatedAt ?? 0) - (a.pr.updatedAt ?? 0))
  }

  /**
   * The pull requests merged in a period, in the profile's scope. Kept per profile and request for
   * `MERGED_TTL_MS`; callers that ask together share one read; `force` reads again (after the one
   * under way, like a forced list). Failures come back as data, never kept.
   */
  async merged(profileId: string | null, request: MergedRequest, force = false): Promise<MergedPullRequestsResult> {
    const { known, ...read } = request
    const result = await this.mergedRead(profileId, read, force)
    if (!result.ok) return result
    const version = result.version ?? mergedVersion(result.items)
    // The view holds these very items: they do not travel again (an answer can be megabytes).
    if (known !== undefined && known === version) return { ...result, items: [], version, unchanged: true }
    return result.version ? result : { ...result, version }
  }

  private async mergedRead(profileId: string | null, request: MergedRequest, force: boolean): Promise<MergedPullRequestsResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, state: 'notConnected', error: 'No code host is connected to this profile' }
    if (!resolved.host.listMerged) return { ok: false, state: 'unsupported', error: `${resolved.host.provider} cannot list merged pull requests` }
    // A write since the last read (a merge made in Workhub): the newest merges are read again, even moments after a read.
    if (this.mergedDirty.delete(resolved.key)) force = true
    const key = `${resolved.key}\n${request.since}|${request.until}|${request.mine}|${request.allProfiles === true}`
    const hit = this.mergedCache.get(key)
    if (hit && !force && Date.now() - hit.at < MERGED_TTL_MS) {
      this.mergedCache.delete(key)
      this.mergedCache.set(key, hit)
      return hit.value
    }
    const flight = this.mergedFlights.get(key)
    if (flight) {
      if (!force) return flight.running
      flight.queued ??= flight.running.then(() => undefined, () => undefined).then(() => this.launchMerged(resolved, request, key, true))
      return flight.queued
    }
    return this.launchMerged(resolved, request, key, force)
  }

  private launchMerged(resolved: Resolved, request: MergedRequest, key: string, force: boolean): Promise<MergedPullRequestsResult> {
    const flight: { running: Promise<MergedPullRequestsResult>; queued?: Promise<MergedPullRequestsResult> } = { running: undefined as never }
    const read = this.mergedSyncer && !this.demoHost ? this.readMergedStored(resolved, request, key, force) : this.readMerged(resolved, request, key)
    flight.running = read
    this.mergedFlights.set(key, flight)
    const done = () => {
      if (this.mergedFlights.get(key) === flight && !flight.queued) this.mergedFlights.delete(key)
    }
    read.then(done, done)
    return read
  }

  private async readMerged(resolved: Resolved, request: MergedRequest, key: string): Promise<MergedPullRequestsResult> {
    const { host } = resolved
    const listMerged = host.listMerged!.bind(host)
    const generation = this.generation(`merged|${resolved.key}`)
    try {
      const { scopes, scope } = await this.mergedScopesOf(resolved)
      // Reading everyone's merges of a whole host is never what the profile meant.
      if (scope.kind === 'none' && !request.mine) return { ok: false, state: 'noScope', error: 'Choose repositories or organizations for this profile first' }
      const known = this.logins.get(resolved.hostKey)
      if (!(known && Date.now() - known.at < LOGIN_TTL_MS)) {
        const status = await host.status()
        if (status.state !== 'ready') {
          this.logins.delete(resolved.hostKey)
          if (status.state === 'error') return { ok: false, state: 'error', error: status.message }
          return {
            ok: false,
            state: status.state,
            error: status.state === 'missingCli' ? `The ${status.cli} CLI is not installed` : `Not signed in: run ${status.cli} auth login`
          }
        }
        this.logins.set(resolved.hostKey, { login: status.login, at: Date.now() })
      }
      const lists = await this.inPool(scopes, MERGED_SCOPES_PARALLEL, (s) => listMerged({ scope: s, since: request.since, until: request.until, mine: request.mine }))
      const seen = new Set<string>()
      const all: MergedPullRequest[] = lists.flatMap((l: MergedList) => l.items).filter((p) => !seen.has(p.url) && Boolean(seen.add(p.url)))
      all.sort((a, b) => b.mergedAt - a.mergedAt || b.number - a.number)
      // The profile's filter (hidden repositories win) applies to what was read.
      const visible = filterPullRequests(all.map((m) => ({ pr: m, m })), resolved.filter).map((x) => x.m)
      const value: MergedOk = {
        ok: true,
        items: visible.slice(0, MERGED_CAP),
        truncated: lists.some((l: MergedList) => l.truncated) || visible.length > MERGED_CAP,
        provider: host.provider,
        fetchedAt: Date.now(),
        scope,
        sync: { state: 'synced' },
        partial: false,
        version: mergedVersion(visible.slice(0, MERGED_CAP)),
        ...(this.logins.get(resolved.hostKey) ? { logins: [this.logins.get(resolved.hostKey)!.login.toLowerCase()] } : {}),
        ...(this.demoHost ? { demo: true } : {})
      }
      // A write finished while this read ran: it is handed out but not kept.
      if (generation === this.generation(`merged|${resolved.key}`)) {
        this.mergedCache.delete(key)
        this.mergedCache.set(key, { at: Date.now(), value })
        while (this.mergedCache.size > MERGED_ENTRIES) this.mergedCache.delete(this.mergedCache.keys().next().value!)
      }
      return value
    } catch (e) {
      this.noteFailure(resolved, e)
      if (e instanceof CodeHostError && (e.kind === 'signedOut' || e.kind === 'missingCli')) return { ok: false, state: e.kind, error: e.message }
      return { ok: false, state: 'error', error: messageOf(e) }
    }
  }

  /**
   * The login of the host as a merged read needs it, asked of the host every time: it is part of every search key, and
   * after `gh auth switch` a kept login would file another account's merges under it (the GitHub host answers from the
   * local token, and reads the login again only when the token changed).
   */
  private async mergedLogin(r: Resolved): Promise<{ login: string } | { failure: MergedFailure; savedLogin?: string }> {
    // The host could not be asked (offline, a rate limit): the last login known still names what was saved, shown without a read.
    const lastKnown = (): { savedLogin?: string } => {
      const known = this.logins.get(r.hostKey)
      return known ? { savedLogin: known.login } : {}
    }
    try {
      const status = await r.host.status()
      if (status.state === 'ready') {
        this.logins.set(r.hostKey, { login: status.login, at: Date.now() })
        return { login: status.login }
      }
      if (status.state === 'error') return { failure: { state: 'error', error: status.message }, ...lastKnown() }
      this.logins.delete(r.hostKey)
      return { failure: { state: status.state, error: status.state === 'missingCli' ? `The ${status.cli} CLI is not installed` : `Not signed in: run ${status.cli} auth login` } }
    } catch (e) {
      const failure = mergedFailureOf(e)
      return { failure, ...(failure.state === 'error' || failure.state === 'rateLimited' ? lastKnown() : {}) }
    }
  }

  /** What a merged read of one profile needs, or null when its Everyone read has no scope (only Mine may be read then). */
  private async mergedTarget(r: Resolved, mine: boolean): Promise<{ target: MergedTarget; scope: MergedScope } | null> {
    const { scopes, scope } = await this.mergedScopesOf(r)
    if (scope.kind === 'none' && !mine) return null
    const host = r.host
    const target: MergedTarget = {
      profileId: r.profileId,
      hostKey: r.hostKey,
      scopes,
      list: (query) => host.listMerged!(query),
      login: () => this.mergedLogin(r),
      filter: (items) => filterPullRequests(items.map((m) => ({ pr: m, m })), r.filter).map((x) => x.m)
    }
    return { target, scope }
  }

  /** The profiles an `allProfiles` read covers: the active one (`first`) and then every other one whose connection can list merges. */
  private async otherMergedProfiles(first: Resolved): Promise<Resolved[]> {
    const config = await this.loadConfig()
    const out: Resolved[] = []
    for (const p of config.profiles) {
      if (p.id === first.profileId) continue
      const r = await this.resolve(p.id)
      if (r && r.profileId === p.id && r.host.listMerged) out.push(r)
    }
    return out
  }

  /**
   * A merged read through the store: reads from the host only what is not saved yet (`MergedSyncer`), and
   * answers from what is saved. A host failure with something saved is an answer with `sync.failed`.
   */
  private async readMergedStored(resolved: Resolved, request: MergedRequest, key: string, force: boolean): Promise<MergedPullRequestsResult> {
    const syncer = this.mergedSyncer!
    const generation = this.generation(`merged|${resolved.key}`)
    try {
      const wanted = request.allProfiles === true
      const reads: { read: MergedProfileRead; resolved: Resolved }[] = []
      let activeScope: MergedScope = { kind: 'none', values: [] }
      const active = await this.mergedTarget(resolved, request.mine)
      if (active) activeScope = active.scope
      else if (!wanted) return { ok: false, state: 'noScope', error: 'Choose repositories or organizations for this profile first' }
      const profiles = [{ r: resolved, t: active?.target ?? null }]
      if (wanted) {
        for (const r of await this.otherMergedProfiles(resolved)) {
          try {
            profiles.push({ r, t: (await this.mergedTarget(r, request.mine))?.target ?? null })
          } catch {
            // A profile whose scope cannot be worked out contributes nothing.
          }
        }
      }
      for (const [i, { r, t }] of profiles.entries()) {
        if (!t) continue
        try {
          const read = await syncer.read(t, { since: request.since, until: request.until, mine: request.mine }, force)
          if (read.failure?.state === 'signedOut') this.logins.delete(r.hostKey)
          reads.push({ read, resolved: r })
        } catch (e) {
          // The active profile's failure is the answer's; another profile's contributes nothing.
          if (i === 0) throw e
        }
      }
      const first = reads[0] && reads[0].resolved === resolved ? reads[0].read : undefined
      const seen = new Set<string>()
      const union = reads
        .flatMap((x) => x.read.items)
        .filter((p) => !seen.has(p.url) && Boolean(seen.add(p.url)))
        .sort((a, b) => b.mergedAt - a.mergedAt || b.number - a.number)
      if (first?.failure && !first.covered && union.length === 0) {
        return { ok: false, state: first.failure.state, error: first.failure.error, ...(first.failure.retryAt !== undefined ? { retryAt: first.failure.retryAt } : {}) }
      }
      if (!first && union.length === 0) return { ok: false, state: 'noScope', error: 'Choose repositories or organizations for this profile first' }
      const value: MergedOk = {
        ok: true,
        items: union.slice(0, MERGED_ANSWER_CAP),
        version: mergedVersion(union.slice(0, MERGED_ANSWER_CAP)),
        truncated: reads.some((x) => x.read.truncated) || union.length > MERGED_ANSWER_CAP,
        provider: resolved.host.provider,
        fetchedAt: first?.fetchedAt ?? Date.now(),
        scope: activeScope,
        sync: first?.sync ?? { state: 'saved' },
        partial: reads.some((x) => x.read.partial),
        ...(wanted ? { profiles: reads.filter((x) => x.read.items.length > 0).length } : {}),
        logins: [...new Set(reads.flatMap((x) => (x.read.login ? [x.read.login] : [])))]
      }
      // Only an answer that no complete read backs (a cut GitLab list) is kept in memory; a write that finished meanwhile keeps even that out.
      if (!reads.some((x) => x.read.covered) && !first?.failure && generation === this.generation(`merged|${resolved.key}`)) {
        this.mergedCache.delete(key)
        this.mergedCache.set(key, { at: Date.now(), value })
        while (this.mergedCache.size > MERGED_ENTRIES) this.mergedCache.delete(this.mergedCache.keys().next().value!)
      }
      return value
    } catch (e) {
      this.noteFailure(resolved, e)
      const failure = mergedFailureOf(e)
      return { ok: false, state: failure.state, error: failure.error, ...(failure.retryAt !== undefined ? { retryAt: failure.retryAt } : {}) }
    }
  }

  /** `fn` over `items`, at most `limit` at a time; the first failure rejects. */
  private async inPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array<R>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
  }

  /**
   * A pull request's detail (no diff), kept per PR for `DETAIL_TTL_MS`; `fresh` skips the kept one.
   * Readers that ask together share one read. A read that started before a write to the PR is
   * handed to its callers but never kept.
   */
  private readDetail(r: Resolved, ref: PullRequestRef, fresh = false): Promise<PullRequestDetail> {
    const key = prKey(r.hostKey, ref)
    const hit = this.details.get(key)
    if (hit && !fresh && Date.now() - hit.at < DETAIL_TTL_MS) {
      this.details.delete(key)
      this.details.set(key, hit)
      return Promise.resolve(hit.value)
    }
    const generation = this.generation(`detail|${key}`)
    const running = this.detailFlights.get(key)
    if (running && running.gen === generation) return running.promise
    const promise = r.host.detail(ref).then(
      (value) => {
        this.authors.set(key, value.author)
        if (generation === this.generation(`detail|${key}`)) {
          this.details.delete(key)
          this.details.set(key, { at: Date.now(), value })
          while (this.details.size > DETAIL_MAX) this.details.delete(this.details.keys().next().value!)
        }
        return value
      },
      (e) => {
        this.noteFailure(r, e)
        throw e
      }
    )
    const flight = { gen: generation, promise }
    this.detailFlights.set(key, flight)
    const done = () => {
      if (this.detailFlights.get(key) === flight) this.detailFlights.delete(key)
    }
    promise.then(done, done)
    return promise
  }

  /** The kept detail of a PR that is fresh enough, without reading. */
  private peekDetail(r: Resolved, ref: PullRequestRef): PullRequestDetail | undefined {
    const hit = this.details.get(prKey(r.hostKey, ref))
    return hit && Date.now() - hit.at < DETAIL_TTL_MS ? hit.value : undefined
  }

  /** Whether the signed-in user wrote the PR: 'unknown' when the author or the login cannot be told, which is never taken as "not mine". */
  private async ownership(r: Resolved, ref: PullRequestRef): Promise<'mine' | 'notMine' | 'unknown'> {
    const key = prKey(r.hostKey, ref)
    const [author, login] = await Promise.all([this.authors.get(key) ?? this.readDetail(r, ref).then((d) => d.author), this.loginOf(r, true)])
    if (!login || !author) return 'unknown'
    return login.toLowerCase() === author.toLowerCase() ? 'mine' : 'notMine'
  }

  async view(profileId: string | null, url: string): Promise<PullRequestViewResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      const [view, login] = await Promise.all([loadPullRequestView(resolved.host, ref), this.loginOf(resolved)])
      const isMine = Boolean(login) && login!.toLowerCase() === view.detail.author.toLowerCase()
      return { ok: true, view, capabilities: resolved.host.capabilities, provider: resolved.host.provider, isMine }
    } catch (e) {
      this.noteFailure(resolved, e)
      return { ok: false, error: messageOf(e) }
    }
  }

  /** The PR without its diff: one `pr view`, kept for a minute; `fresh` (Refresh) reads the host even when a copy is kept. */
  async detail(profileId: string | null, url: string, fresh = false): Promise<PullRequestDetailResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      const [detail, login] = await Promise.all([this.readDetail(resolved, ref, fresh), this.loginOf(resolved)])
      const isMine = Boolean(login) && login!.toLowerCase() === detail.author.toLowerCase()
      return { ok: true, detail, capabilities: resolved.host.capabilities, provider: resolved.host.provider, isMine }
    } catch (e) {
      return { ok: false, error: messageOf(e) }
    }
  }

  /** The PR's changed files on their own. */
  async diff(profileId: string | null, url: string): Promise<PullRequestDiffResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      return { ok: true, files: await resolved.host.diff(ref) }
    } catch (e) {
      this.noteFailure(resolved, e)
      return { ok: false, error: messageOf(e) }
    }
  }

  /** The state of a PR by URL on the light detail read (kept for a minute); undefined when it cannot be read. */
  async prState(profileId: string | null, url: string): Promise<PullRequest['state'] | undefined> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return undefined
    try {
      return (await this.readDetail(resolved, ref)).state
    } catch {
      return undefined
    }
  }

  private readonly items = new Map<string, { at: number; value: Promise<PullRequestItem | null> }>()

  /**
   * One pull request by URL as a list item (the session monitor's PRs that are in neither list):
   * read once and kept for a few minutes, so every open monitor does not ask the host again. Null
   * when no connected host recognizes or can read it.
   */
  async pullRequest(profileId: string | null, url: string): Promise<PullRequestItem | null> {
    if (typeof url !== 'string' || !url) return null
    const key = `${profileId ?? ''}\n${url}`
    const hit = this.items.get(key)
    if (hit && Date.now() - hit.at < ITEM_TTL_MS) return hit.value
    const value = this.stateOf(profileId, url).then((pr) => (pr ? toItem(pr, Date.now(), { markStale: false }) : null))
    if (this.items.size > 500) this.items.clear()
    this.items.set(key, { at: Date.now(), value })
    return value
  }

  /** A pull request read again by URL (merged, closed or still open); null when it cannot be read. For the pull request event sync. */
  async stateOf(profileId: string | null, url: string): Promise<PullRequest | null> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return null
    try {
      return await resolved.host.detail(ref)
    } catch {
      return null
    }
  }

  private async act(profileId: string | null, url: string, fn: (resolved: Resolved, ref: PullRequestRef) => Promise<void>): Promise<CodeHostActionResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      await fn(resolved, ref)
      this.forget(resolved, ref)
      this.onChanged?.(ref.url, profileId)
      return { ok: true }
    } catch (e) {
      this.noteFailure(resolved, e)
      return failureOf(e)
    }
  }

  /** Forgets what is known of one PR (its lists, detail and its repository's merge methods), so every read after a write asks the host again; reads still running never store. */
  private forget(r: Resolved, ref: PullRequestRef): void {
    const key = prKey(r.hostKey, ref)
    const methodsKey = `${r.hostKey}\n${repoOf(ref)}`
    this.bump(`list|${r.key}`)
    this.bump(`detail|${key}`)
    this.bump(`methods|${methodsKey}`)
    // The lists are kept as expired, not dropped: the next read asks the host, and if it fails the last good lists stay.
    const lists = this.cache.get(r.key)
    if (lists) this.cache.set(r.key, { at: 0, value: lists.value })
    this.details.delete(key)
    this.methods.delete(methodsKey)
    // Every merged read of the profile is stale after a write: drop them, and let the next caller start a read of its own.
    this.bump(`merged|${r.key}`)
    this.mergedDirty.add(r.key)
    for (const k of [...this.mergedCache.keys()]) if (k.startsWith(`${r.key}\n`)) this.mergedCache.delete(k)
    for (const k of [...this.mergedFlights.keys()]) if (k.startsWith(`${r.key}\n`)) this.mergedFlights.delete(k)
    for (const k of this.items.keys()) if (k.endsWith(`\n${ref.url}`)) this.items.delete(k)
  }

  /** Whether the profile has a code host Workhub can use. */
  async connected(profileId: string | null): Promise<boolean> {
    return (await this.resolve(profileId)) !== null
  }

  /** Opens a PR on the profile's code host; the caller made sure the branch is pushed. */
  async create(profileId: string | null, input: NewPullRequest): Promise<CreatePullRequestResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    try {
      const ref = await createPullRequest(resolved.host, input)
      this.forget(resolved, ref)
      return { ok: true, url: ref.url }
    } catch (e) {
      this.noteFailure(resolved, e)
      return failureOf(e)
    }
  }

  /** The merge methods a repository allows, kept for `METHODS_TTL_MS`. */
  private methodsOf(r: Resolved, ref: PullRequestRef): Promise<MergeMethod[]> {
    const key = `${r.hostKey}\n${repoOf(ref)}`
    const hit = this.methods.get(key)
    if (hit && Date.now() - hit.at < METHODS_TTL_MS) return Promise.resolve(hit.value)
    const generation = this.generation(`methods|${key}`)
    return r.host.mergeMethods(ref).then((value) => {
      if (generation === this.generation(`methods|${key}`)) this.methods.set(key, { at: Date.now(), value })
      return value
    })
  }

  async mergeMethods(profileId: string | null, url: string): Promise<MergeMethodsResult> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      return { ok: true, methods: await this.methodsOf(resolved, ref) }
    } catch (e) {
      this.noteFailure(resolved, e)
      return { ok: false, error: messageOf(e) }
    }
  }

  /** Merges now with an allowed method; a protected head branch is kept whatever was asked. */
  async merge(profileId: string | null, url: string, method: MergeMethod, deleteBranch: boolean): Promise<MergeResult> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    const { host } = resolved
    let merged = false
    try {
      // The kept detail is used only when it says the PR can be merged; any other answer is read again.
      const kept = this.peekDetail(resolved, ref)
      const usable = kept && mergeRefusal(kept) === null ? kept : undefined
      const [pr, allowed] = await Promise.all([usable ?? this.readDetail(resolved, ref, true), this.methodsOf(resolved, ref)])
      const protectedBranches = appOptions(await this.loadConfig()).protectedBranches
      const { branchDeleted } = await mergePullRequest(host, ref, pr, { method, deleteBranch, allowed, protectedBranches })
      merged = true
      return { ok: true, branchDeleted }
    } catch (e) {
      this.noteFailure(resolved, e)
      // A failure after the merge itself (deleting the branch) still leaves a merged PR.
      const after = await host.detail(ref).catch(() => null)
      if (after?.state === 'merged') {
        merged = true
        return { ok: true, branchDeleted: false, warning: messageOf(e) }
      }
      return failureOf(e)
    } finally {
      this.forget(resolved, ref)
      if (merged) this.onChanged?.(ref.url, profileId)
    }
  }

  async review(profileId: string | null, url: string, action: ReviewAction, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (r, ref) => {
      // A plain comment review is allowed on one's own PR, so it needs no author; the others are refused when it is not known whose PR this is.
      const owner = action === 'comment' ? 'notMine' : await this.ownership(r, ref)
      if (owner === 'unknown') throw new CodeHostError('Could not tell whether this is your own pull request', 'failed')
      await submitReview(r.host, ref, action, body, owner === 'mine')
    })
  }

  comment(profileId: string | null, url: string, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, (r, ref) => postComment(r.host, ref, body))
  }

  /** Closes the user's own open PR without merging; the head branch is deleted only when asked and not long-lived. */
  close(profileId: string | null, url: string, comment: string, deleteBranch: boolean): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (r, ref) => {
      const [pr, owner] = await Promise.all([this.readDetail(r, ref, true), this.ownership(r, ref)])
      if (owner === 'unknown') throw new CodeHostError('Could not tell whether this is your own pull request', 'failed')
      const protectedBranches = appOptions(await this.loadConfig()).protectedBranches
      await closePullRequest(r.host, ref, pr, owner === 'mine', { comment, deleteBranch, protectedBranches })
    })
  }

  reply(profileId: string | null, url: string, threadId: string, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (r, ref) => {
      if (body.trim() === '') throw new CodeHostError('reply refused: bodyRequired', 'unsupported')
      await r.host.replyToThread(ref, threadId, body.trim())
    })
  }

  /** Whether some connected host recognizes the URL: the guard before opening it in the browser or a window. */
  async recognizes(profileId: string | null, url: string): Promise<boolean> {
    const resolved = await this.resolve(profileId)
    return Boolean(resolved?.host.parseUrl(url))
  }
}

export interface CodeHostIpcOptions {
  service: CodeHostService
  openWindow: (profileId: string | null, url: string, tab?: PullRequestWindowTab) => void
  /** Brings the main window up on Pull requests with this PR selected. */
  showInWorkhub: (url: string, profileId: string | null) => void
  openExternal: (url: string, profileId: string | null) => Promise<void>
}

export function registerCodeHostIpc(ipc: IpcRegistrar, { service, openWindow, showInWorkhub, openExternal }: CodeHostIpcOptions): void {
  ipc.handle('codeHost:lists', (_e, profileId: string | null, force?: boolean) => service.lists(profileId, force === true))
  ipc.handle('codeHost:merged', (_e, profileId: string | null, request: unknown, force?: boolean) => {
    const valid = validMergedRequest(request)
    return valid ? service.merged(profileId, valid, force === true) : { ok: false, state: 'error', error: 'Invalid request' }
  })
  ipc.handle('codeHost:view', (_e, profileId: string | null, url: string) => service.view(profileId, url))
  ipc.handle('codeHost:detail', (_e, profileId: string | null, url: string, fresh?: boolean) => service.detail(profileId, url, fresh === true))
  ipc.handle('codeHost:diff', (_e, profileId: string | null, url: string) => service.diff(profileId, url))
  ipc.handle('codeHost:pullRequest', (_e, profileId: string | null, url: string) => service.pullRequest(profileId, url))
  ipc.handle('codeHost:review', (_e, profileId: string | null, url: string, action: ReviewAction, body: string) =>
    service.review(profileId, url, action, body)
  )
  ipc.handle('codeHost:comment', (_e, profileId: string | null, url: string, body: string) => service.comment(profileId, url, body))
  ipc.handle('codeHost:reply', (_e, profileId: string | null, url: string, threadId: string, body: string) =>
    service.reply(profileId, url, threadId, body)
  )
  ipc.handle('codeHost:close', (_e, profileId: string | null, url: string, comment: unknown, deleteBranch: unknown) =>
    service.close(profileId, url, typeof comment === 'string' ? comment : '', deleteBranch === true)
  )
  ipc.handle('codeHost:mergeMethods', (_e, profileId: string | null, url: string) => service.mergeMethods(profileId, url))
  ipc.handle('codeHost:merge', (_e, profileId: string | null, url: string, method: unknown, deleteBranch: unknown) =>
    MERGE_METHODS.includes(method as MergeMethod)
      ? service.merge(profileId, url, method as MergeMethod, deleteBranch === true)
      : { ok: false, error: 'Unknown merge method' }
  )
  ipc.handle('codeHost:openWindow', async (_e, profileId: string | null, url: string, tab?: unknown) => {
    if (await service.recognizes(profileId, url)) openWindow(profileId, url, isPullRequestWindowTab(tab) ? tab : undefined)
  })
  ipc.handle('codeHost:showInWorkhub', async (_e, profileId: string | null, url: string) => {
    if (await service.recognizes(profileId, url)) showInWorkhub(url, profileId)
  })
  ipc.handle('codeHost:openExternal', async (_e, profileId: string | null, url: string) => {
    // Only pull request URLs of the connected host; the renderer never opens arbitrary links.
    if (await service.recognizes(profileId, url)) await openExternal(url, profileId)
  })
}
