import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCliRunner, type CliRunner } from '@workhub/adapters/cli'
import { GitHubCodeHost, createDemoRunner } from '@workhub/adapters/codehost-github'
import { GitLabCodeHost } from '@workhub/adapters/codehost-gitlab'
import {
  CodeHostError,
  githubScopeFromRemotes,
  loadMyPullRequests,
  loadPullRequestView,
  loadReviewQueue,
  postComment,
  submitReview,
  type CodeHost,
  type Connection,
  type Profile,
  type PullRequest,
  type ReviewAction,
  type WorkhubConfig
} from '@workhub/core'
import type { IpcRegistrar } from './ipc-guard'
import type { CodeHostActionResult, CodeHostLists, PullRequestViewResult } from '../shared/codehost-api'

const exec = promisify(execFile)
const LIST_TTL_MS = 30_000

interface Resolved {
  host: CodeHost
  key: string
  scope: string
  cli: string
  folders: string[]
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

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

  constructor(
    private readonly loadConfig: () => Promise<WorkhubConfig>,
    options: { demo: boolean; /** Demo only: the step the synthetic pull requests are at (see the GitHub demo). */ demoStep?: () => number }
  ) {
    this.run = createCliRunner()
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

  private async remotesOf(folders: string[]): Promise<string[]> {
    const out: string[] = []
    for (const folder of folders) {
      try {
        out.push((await exec('git', ['-C', folder, 'remote', 'get-url', 'origin'], { windowsHide: true, timeout: 10_000 })).stdout.trim())
      } catch {
        // Not a git repository, or no origin.
      }
    }
    return out
  }

  private async resolve(profileId: string | null): Promise<Resolved | null> {
    if (this.demoHost) return { host: this.demoHost, key: 'demo', scope: '', cli: 'gh', folders: [] }
    const config = await this.loadConfig()
    const profile: Profile | undefined = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId))
    const connection = config.connections.find((c) => c.id === profile?.connections.codeHost)
    if (!profile || !connection) return null
    const made = this.hostFor(connection)
    if (!made) return null
    const configured = connection.settings['scope']?.trim() ?? ''
    return {
      host: made.host,
      key: `${profile.id}|${connection.id}|${connection.endpoint ?? ''}|${configured}|${(profile.folders ?? []).join(',')}`,
      scope: configured,
      cli: made.cli,
      folders: profile.folders ?? []
    }
  }

  /** The search scope: the connection's `scope` setting, else (GitHub) the repos behind the profile's folders, else everything. */
  private async scopeOf(r: Resolved): Promise<string> {
    if (r.scope || r.host.provider !== 'github' || r.folders.length === 0) return r.scope
    return githubScopeFromRemotes(await this.remotesOf(r.folders))
  }

  async lists(profileId: string | null, force = false): Promise<CodeHostLists> {
    const empty = { mine: [], toReview: [] }
    const resolved = await this.resolve(profileId)
    if (!resolved) return { state: 'notConnected', ...empty }
    const cached = this.cache.get(resolved.key)
    if (cached && !force && Date.now() - cached.at < LIST_TTL_MS) return cached.value
    const { host, cli } = resolved
    const demo = this.demoHost !== null
    const status = await host.status()
    if (status.state !== 'ready') {
      const base = { provider: host.provider, cli, ...empty, demo }
      if (status.state === 'error') return { ...base, state: 'error', message: status.message }
      return { ...base, state: status.state }
    }
    this.logins.set(resolved.key, status.login)
    const query = { scope: await this.scopeOf(resolved) }
    const [mine, toReview] = await Promise.allSettled([loadMyPullRequests(host, query), loadReviewQueue(host, query)])
    const previous = cached?.value
    const failures = [mine, toReview].flatMap((r) => (r.status === 'rejected' ? [messageOf(r.reason)] : []))
    const value: CodeHostLists = {
      state: mine.status === 'rejected' && toReview.status === 'rejected' ? 'error' : 'ready',
      provider: host.provider,
      cli,
      login: status.login,
      // A list that failed keeps what the last read found, like Workhub 1.
      mine: mine.status === 'fulfilled' ? mine.value : (previous?.mine ?? []),
      toReview: toReview.status === 'fulfilled' ? toReview.value : (previous?.toReview ?? []),
      message: failures[0],
      updatedAt: failures.length < 2 ? Date.now() : previous?.updatedAt,
      demo
    }
    this.cache.set(resolved.key, { at: Date.now(), value })
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
      return { ok: false, error: messageOf(e) }
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
  openWindow: (profileId: string | null, url: string) => void
  openExternal: (url: string, profileId: string | null) => Promise<void>
}

export function registerCodeHostIpc(ipc: IpcRegistrar, { service, openWindow, openExternal }: CodeHostIpcOptions): void {
  ipc.handle('codeHost:lists', (_e, profileId: string | null, force?: boolean) => service.lists(profileId, force === true))
  ipc.handle('codeHost:view', (_e, profileId: string | null, url: string) => service.view(profileId, url))
  ipc.handle('codeHost:review', (_e, profileId: string | null, url: string, action: ReviewAction, body: string) =>
    service.review(profileId, url, action, body)
  )
  ipc.handle('codeHost:comment', (_e, profileId: string | null, url: string, body: string) => service.comment(profileId, url, body))
  ipc.handle('codeHost:reply', (_e, profileId: string | null, url: string, threadId: string, body: string) =>
    service.reply(profileId, url, threadId, body)
  )
  ipc.handle('codeHost:openWindow', async (_e, profileId: string | null, url: string) => {
    if (await service.recognizes(profileId, url)) openWindow(profileId, url)
  })
  ipc.handle('codeHost:openExternal', async (_e, profileId: string | null, url: string) => {
    // Only pull request URLs of the connected host; the renderer never opens arbitrary links.
    if (await service.recognizes(profileId, url)) await openExternal(url, profileId)
  })
}
