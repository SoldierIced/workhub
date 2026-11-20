import { createCliRunner, type CliRunner } from '@workhub/adapters/cli'
import { runGit } from '@workhub/adapters/git-review'
import { GitHubCodeHost, createDemoRunner } from '@workhub/adapters/codehost-github'
import { GitLabCodeHost } from '@workhub/adapters/codehost-gitlab'
import {
  appOptions,
  CodeHostError,
  filterPullRequests,
  githubScopeFromFilter,
  githubScopeFromRemotes,
  loadMyPullRequests,
  loadPullRequestView,
  loadReviewQueue,
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
  type MergeMethod,
  type NewPullRequest,
  type Profile,
  type PullRequest,
  type PullRequestFilterSettings,
  type PullRequestItem,
  type ReviewAction,
  type WorkhubConfig
} from '@workhub/core'
import { originUrl, type HostFolders, type HostTarget } from './hosts'
import type { IpcRegistrar } from './ipc-guard'
import {
  isPullRequestWindowTab,
  type CodeHostActionResult,
  type CodeHostLists,
  type CreatePullRequestResult,
  type MergeMethodsResult,
  type MergeResult,
  type PullRequestViewResult,
  type PullRequestWindowTab
} from '../shared/codehost-api'

const LIST_TTL_MS = 30_000
/** How long a pull request read by URL for the session monitor is kept. */
const ITEM_TTL_MS = 180_000

interface Resolved {
  host: CodeHost
  key: string
  scope: string
  cli: string
  /** The profile's folders, on the host its profile runs on. */
  folders: string[]
  profileId: string | null
  filter?: PullRequestFilterSettings
}

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
  private readonly logins = new Map<string, string>()
  private readonly demoHost: CodeHost | null
  /** Reads under way, so concurrent callers of `lists` share one. */
  private readonly inflight = new Map<string, Promise<CodeHostLists>>()
  private readonly onListsChanged: (() => void) | undefined
  /** The host a profile's folders live on. */
  private readonly folderHost: (target: HostTarget) => Pick<HostFolders, 'git'>

  constructor(
    private readonly loadConfig: () => Promise<WorkhubConfig>,
    options: { demo: boolean; /** Called when a read stored lists that differ from the cached ones (the tray shows the cached lists and never reads). */ onListsChanged?: () => void; /** Demo only: the step the synthetic pull requests are at (see the GitHub demo). */ demoStep?: () => number; /** The host a profile's folders live on; this computer when not given. */ hostFor?: (target: HostTarget) => Pick<HostFolders, 'git'> }
  ) {
    this.folderHost = options.hostFor ?? (() => ({ git: runGit }))
    this.run = createCliRunner()
    this.onListsChanged = options.onListsChanged
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
    if (this.demoHost) return { host: this.demoHost, key: 'demo', scope: '', cli: 'gh', folders: [], profileId: null }
    const config = await this.loadConfig()
    const profile: Profile | undefined = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    const connection = config.connections.find((c) => c.id === profile?.connections.codeHost)
    if (!profile || !connection) return null
    const made = this.hostFor(connection)
    if (!made) return null
    const configured = connection.settings['scope']?.trim() ?? ''
    const filter = normalizePullRequestFilter(profile.pullRequests)
    return {
      host: made.host,
      key: `${profile.id}|${connection.id}|${connection.endpoint ?? ''}|${configured}|${(profile.folders ?? []).join(',')}|${JSON.stringify(filter)}`,
      scope: configured,
      cli: made.cli,
      folders: profile.folders ?? [],
      profileId: profile.id,
      filter
    }
  }

  /**
   * The search scope: the profile's owners (GitHub), else the connection's `scope` setting, else
   * (GitHub) the repos behind the profile's folders, else everything. The profile's filter is also
   * applied to the results (`filterPullRequests`), which is all it does on GitLab.
   */
  private async scopeOf(r: Resolved): Promise<string> {
    if (r.host.provider === 'github' && r.filter?.owners?.length) return githubScopeFromFilter(r.filter)
    if (r.scope || r.host.provider !== 'github' || r.folders.length === 0) return r.scope
    return githubScopeFromRemotes(await this.remotesOf(r.folders, r.profileId))
  }

  async lists(profileId: string | null, force = false): Promise<CodeHostLists> {
    const empty = { mine: [], toReview: [] }
    const resolved = await this.resolve(profileId)
    if (!resolved) return { state: 'notConnected', ...empty }
    const cached = this.cache.get(resolved.key)
    if (cached && !force && Date.now() - cached.at < LIST_TTL_MS) return cached.value
    const running = this.inflight.get(resolved.key)
    if (running) return running
    const read = this.read(resolved, cached?.value)
    this.inflight.set(resolved.key, read)
    try {
      return await read
    } finally {
      if (this.inflight.get(resolved.key) === read) this.inflight.delete(resolved.key)
    }
  }

  /** The lists this service already holds for the profile, whatever their age; null when none. Never reads the host. */
  async cachedLists(profileId: string | null): Promise<CodeHostLists | null> {
    const resolved = await this.resolve(profileId)
    return (resolved && this.cache.get(resolved.key)?.value) || null
  }

  private async read(resolved: Resolved, previous: CodeHostLists | undefined): Promise<CodeHostLists> {
    const empty = { mine: [], toReview: [] }
    const { host, cli } = resolved
    const demo = this.demoHost !== null
    const status = await host.status()
    if (status.state !== 'ready') {
      const base = { provider: host.provider, cli, ...empty, demo }
      if (status.state === 'error') {
        // A transient failure (right after wake, a VPN drop) keeps the last good lists, so the screen keeps its content and shows the error line. Not cached: the next call asks again.
        const last = previous
        return { ...base, mine: last?.mine ?? [], toReview: last?.toReview ?? [], login: last?.login, updatedAt: last?.updatedAt, state: 'error', message: status.message }
      }
      return { ...base, state: status.state }
    }
    this.logins.set(resolved.key, status.login)
    const query = { scope: await this.scopeOf(resolved) }
    const [mine, toReview] = await Promise.allSettled([loadMyPullRequests(host, query), loadReviewQueue(host, query)])
    const failures = [mine, toReview].flatMap((r) => (r.status === 'rejected' ? [messageOf(r.reason)] : []))
    const value: CodeHostLists = {
      state: mine.status === 'rejected' && toReview.status === 'rejected' ? 'error' : 'ready',
      provider: host.provider,
      cli,
      login: status.login,
      // A list that failed keeps what the last read found, like Workhub 1.
      mine: mine.status === 'fulfilled' ? filterPullRequests(mine.value, resolved.filter) : (previous?.mine ?? []),
      toReview: toReview.status === 'fulfilled' ? filterPullRequests(toReview.value, resolved.filter) : (previous?.toReview ?? []),
      message: failures[0],
      updatedAt: failures.length < 2 ? Date.now() : previous?.updatedAt,
      demo
    }
    this.cache.set(resolved.key, { at: Date.now(), value })
    if (!previous || JSON.stringify({ ...previous, updatedAt: 0 }) !== JSON.stringify({ ...value, updatedAt: 0 })) this.onListsChanged?.()
    return value
  }

  async view(profileId: string | null, url: string): Promise<PullRequestViewResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      const view = await loadPullRequestView(resolved.host, ref)
      const login = this.logins.get(resolved.key)
      const isMine = Boolean(login) && login!.toLowerCase() === view.detail.author.toLowerCase()
      return { ok: true, view, capabilities: resolved.host.capabilities, provider: resolved.host.provider, isMine }
    } catch (e) {
      return { ok: false, error: messageOf(e) }
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

  private async act(profileId: string | null, url: string, fn: (host: CodeHost, ref: NonNullable<ReturnType<CodeHost['parseUrl']>>, resolvedKey: string) => Promise<void>): Promise<CodeHostActionResult> {
    const resolved = await this.resolve(profileId)
    if (!resolved) return { ok: false, error: 'No code host is connected to this profile' }
    const ref = resolved.host.parseUrl(url)
    if (!ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      await fn(resolved.host, ref, resolved.key)
      this.cache.delete(resolved.key)
      return { ok: true }
    } catch (e) {
      return failureOf(e)
    }
  }

  /** Forgets what is known of one PR, so the lists and the session monitor read it again. */
  private forget(key: string, url: string): void {
    this.cache.delete(key)
    for (const k of this.items.keys()) if (k.endsWith(`\n${url}`)) this.items.delete(k)
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
      this.forget(resolved.key, ref.url)
      return { ok: true, url: ref.url }
    } catch (e) {
      return failureOf(e)
    }
  }

  async mergeMethods(profileId: string | null, url: string): Promise<MergeMethodsResult> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    try {
      return { ok: true, methods: await resolved.host.mergeMethods(ref) }
    } catch (e) {
      return { ok: false, error: messageOf(e) }
    }
  }

  /** Merges now with an allowed method; a protected head branch is kept whatever was asked. */
  async merge(profileId: string | null, url: string, method: MergeMethod, deleteBranch: boolean): Promise<MergeResult> {
    const resolved = await this.resolve(profileId)
    const ref = resolved?.host.parseUrl(url)
    if (!resolved || !ref) return { ok: false, error: 'This is not a pull request of the connected code host' }
    const { host } = resolved
    try {
      const [pr, allowed] = await Promise.all([host.detail(ref), host.mergeMethods(ref)])
      const protectedBranches = appOptions(await this.loadConfig()).protectedBranches
      const { branchDeleted } = await mergePullRequest(host, ref, pr, { method, deleteBranch, allowed, protectedBranches })
      return { ok: true, branchDeleted }
    } catch (e) {
      // A failure after the merge itself (deleting the branch) still leaves a merged PR.
      const after = await host.detail(ref).catch(() => null)
      return after?.state === 'merged' ? { ok: true, branchDeleted: false, warning: messageOf(e) } : failureOf(e)
    } finally {
      this.forget(resolved.key, ref.url)
    }
  }

  async review(profileId: string | null, url: string, action: ReviewAction, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (host, ref, key) => {
      const view = await host.detail(ref)
      const login = this.logins.get(key)
      const isMine = Boolean(login) && login!.toLowerCase() === view.author.toLowerCase()
      await submitReview(host, ref, action, body, isMine)
    })
  }

  comment(profileId: string | null, url: string, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, (host, ref) => postComment(host, ref, body))
  }

  /** Closes the user's own open PR without merging; the head branch is deleted only when asked and not long-lived. */
  close(profileId: string | null, url: string, comment: string, deleteBranch: boolean): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (host, ref, key) => {
      const pr = await host.detail(ref)
      const login = this.logins.get(key)
      const isMine = Boolean(login) && login!.toLowerCase() === pr.author.toLowerCase()
      const protectedBranches = appOptions(await this.loadConfig()).protectedBranches
      await closePullRequest(host, ref, pr, isMine, { comment, deleteBranch, protectedBranches })
    })
  }

  reply(profileId: string | null, url: string, threadId: string, body: string): Promise<CodeHostActionResult> {
    return this.act(profileId, url, async (host, ref) => {
      if (body.trim() === '') throw new CodeHostError('reply refused: bodyRequired', 'unsupported')
      await host.replyToThread(ref, threadId, body.trim())
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
  ipc.handle('codeHost:view', (_e, profileId: string | null, url: string) => service.view(profileId, url))
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
