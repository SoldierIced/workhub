import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { JiraTracker } from '@workhub/adapters/tracker-jira'
import { LinearTracker } from '@workhub/adapters/tracker-linear'
import { GitHubIssuesTracker } from '@workhub/adapters/tracker-github'
import { createCliRunner, type CliRunner } from '@workhub/adapters/cli'
import { runGit, type GitRunner } from '@workhub/adapters/git-review'
import type { HttpClient } from '@workhub/adapters/http'
import {
  githubSlugFromRemote,
  secretForConnectionTest,
  type ConfigurationService,
  type Connection,
  type ConnectionTest,
  type SecretChange,
  type SecretStore,
  type Ticket,
  type TicketTracker
} from '@workhub/core'
import type { TicketsResult, TicketsStatus } from '../shared/tickets-api'
import { originUrl, type HostFolders, type HostTarget } from './hosts'

const NOT_READY: Record<TicketsStatus['state'], string> = {
  ready: '',
  demo: '',
  noConnection: 'This profile has no ticket tracker connection',
  incomplete: 'The ticket tracker connection is incomplete',
  unsupported: 'This ticket tracker is not supported yet'
}

/** Settings keys a tracker connection uses (Settings → Trackers writes them). */
export const TRACKER_SETTINGS = { email: 'email', ignoredStatuses: 'ignoredStatuses', projectKeys: 'projectKeys', repositories: 'repositories', backlogQuery: 'backlogQuery' } as const


const list = (value: string | undefined) =>
  (value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)

interface Resolved {
  status: TicketsStatus
  tracker?: TicketTracker
  ignoredStatuses: string[]
  /** The connection's backlog query (Jira: JQL); empty when not set. */
  backlogQuery: string
}

/** What GitHub Issues needs beyond the connection: the `gh` runner and the profile's folders (their remotes are the default scope). */
export interface TrackerContext {
  run?: CliRunner
  folders?: string[]
  /** Runs git where the folders live; this computer's git when not given. */
  git?: GitRunner
}

/** The `owner/repo` behind each folder's `origin` remote; folders that are not GitHub clones are skipped. */
export async function githubReposOfFolders(folders: readonly string[], host = 'github.com', git: GitRunner = runGit): Promise<string[]> {
  const out: string[] = []
  for (const folder of folders) {
    const url = await originUrl(git, folder)
    const slug = url === null ? null : githubSlugFromRemote(url, host)
    if (slug) out.push(slug)
  }
  return out
}

/** The GitHub Enterprise host of an endpoint; undefined for github.com (and its API host). */
function githubHostOf(endpoint: string | undefined): string | undefined {
  try {
    const host = endpoint ? new URL(endpoint).hostname : ''
    return host && host !== 'github.com' && host !== 'api.github.com' ? host : undefined
  } catch {
    return undefined
  }
}

/** Builds a tracker from a saved or typed connection; `incomplete` names what is missing. */
export function buildTracker(connection: Connection, secret: string | null, http?: HttpClient, context: TrackerContext = {}): { tracker: TicketTracker } | { missing: 'unsupported' | 'incomplete'; detail?: string } {
  const projectKeys = list(connection.settings[TRACKER_SETTINGS.projectKeys])
  if (connection.provider === 'jira') {
    const email = connection.settings[TRACKER_SETTINGS.email]?.trim()
    if (!connection.endpoint?.trim()) return { missing: 'incomplete', detail: 'site' }
    if (!email) return { missing: 'incomplete', detail: 'email' }
    if (!secret) return { missing: 'incomplete', detail: 'token' }
    return { tracker: new JiraTracker({ site: connection.endpoint, email, token: secret, projectKeys, http }) }
  }
  if (connection.provider === 'linear') {
    if (!secret) return { missing: 'incomplete', detail: 'token' }
    // The provider catalog's default endpoint is the REST root; the tracker adds /graphql.
    return { tracker: new LinearTracker({ apiKey: secret, endpoint: connection.endpoint, projectKeys, http }) }
  }
  if (connection.provider === 'github-issues') {
    // No token: `gh` is signed in by the user. Without listed repositories the profile's folders decide.
    const host = githubHostOf(connection.endpoint)
    const folders = context.folders ?? []
    return {
      tracker: new GitHubIssuesTracker({
        run: context.run ?? createCliRunner(),
        host,
        repositories: list(connection.settings[TRACKER_SETTINGS.repositories]),
        fallbackRepositories: folders.length > 0 ? () => githubReposOfFolders(folders, host, context.git) : undefined
      })
    }
  }
  return { missing: 'unsupported' }
}

/** Resolves the tracker of a profile from its connection and serves the renderer's ticket calls. */
export class TicketService {
  private readonly demos = new Map<string, DemoTracker>()

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly secrets: SecretStore,
    private readonly demo: boolean,
    private readonly http?: HttpClient,
    /** The demo scenario whose tickets the demo tracker serves (`WORKHUB_DEMO_SCENARIO`). */
    private readonly demoScenario?: string,
    /** The `gh` runner of GitHub Issues (tests); the real one by default. */
    private readonly run?: CliRunner,
    /** The host a profile's folders live on (their remotes scope GitHub Issues); this computer when not given. */
    private readonly hostFor?: (target: HostTarget) => Pick<HostFolders, 'git'>
  ) {}

  async resolve(profileId: string | null): Promise<Resolved> {
    const config = await this.configuration.current()
    const profile = config.profiles.find((p) => p.id === profileId)
    const connection = config.connections.find((c) => c.id === profile?.connections.tracker)
    const projectKeys = connection ? list(connection.settings[TRACKER_SETTINGS.projectKeys]) : []
    const ignoredStatuses = connection ? list(connection.settings[TRACKER_SETTINGS.ignoredStatuses]) : []
    const backlogQuery = connection?.settings[TRACKER_SETTINGS.backlogQuery]?.trim() ?? ''
    const base = { provider: connection?.provider, connectionName: connection ? connection.name || connection.id : undefined, projectKeys }
    // The Backlog view: offered when the tracker lists backlogs, ready once a query or project keys say which.
    const backlog = (tracker: TicketTracker, demo = false): TicketsStatus['backlog'] =>
      tracker.capabilities.backlog && tracker.listBacklog ? (demo || backlogQuery || projectKeys.length > 0 ? 'ready' : 'unconfigured') : undefined
    if (this.demo && profileId) {
      const tracker = this.demos.get(profileId) ?? new DemoTracker(connection?.provider ?? 'jira', { scenario: this.demoScenario })
      this.demos.set(profileId, tracker)
      return { status: { ...base, state: 'demo', backlog: backlog(tracker, true) }, tracker, ignoredStatuses, backlogQuery }
    }
    if (!connection) return { status: { state: 'noConnection', projectKeys }, ignoredStatuses, backlogQuery }
    const secret = connection.secretRef ? await this.secrets.get(connection.secretRef) : null
    const built = buildTracker(connection, secret, this.http, { run: this.run, folders: profile?.folders, git: this.hostFor?.({ profileId }).git })
    if ('missing' in built) return { status: { ...base, state: built.missing }, ignoredStatuses, backlogQuery }
    return { status: { ...base, state: 'ready', backlog: backlog(built.tracker) }, tracker: built.tracker, ignoredStatuses, backlogQuery }
  }

  async status(profileId: string | null): Promise<TicketsStatus> {
    return (await this.resolve(profileId)).status
  }

  async test(connection: Connection, change: SecretChange): Promise<ConnectionTest> {
    if (this.demo) return new DemoTracker(connection.provider, { scenario: this.demoScenario }).testConnection()
    const resolved = await secretForConnectionTest(await this.configuration.current(), this.secrets, connection, change)
    if (!resolved.ok) return resolved
    const { secret } = resolved
    try {
      const built = buildTracker(connection, secret, this.http, { run: this.run })
      if ('missing' in built) return { ok: false, error: built.missing === 'unsupported' ? NOT_READY.unsupported : `The ${built.detail} is missing` }
      return await built.tracker.testConnection()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The tracker of a connection for a profile's Plan features (milestones, inbox): the given tracker
   * connection, or the profile's own when none is named. The demo serves the profile's demo tracker.
   */
  async trackerFor(profileId: string, connectionId?: string): Promise<{ tracker: TicketTracker } | { error: string }> {
    try {
      if (!connectionId || this.demo) {
        const { tracker, status } = await this.resolve(profileId)
        return tracker ? { tracker } : { error: NOT_READY[status.state] }
      }
      const connection = (await this.configuration.current()).connections.find((c) => c.id === connectionId && c.kind === 'tracker')
      if (!connection) return { error: 'The tracker connection no longer exists' }
      const secret = connection.secretRef ? await this.secrets.get(connection.secretRef) : null
      const folders = (await this.configuration.current()).profiles.find((p) => p.id === profileId)?.folders
      const built = buildTracker(connection, secret, this.http, { run: this.run, folders, git: this.hostFor?.({ profileId }).git })
      return 'missing' in built ? { error: NOT_READY[built.missing] } : { tracker: built.tracker }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** The open tickets of the profile's backlog, whoever has them (the connection's query or project keys). */
  async backlog(profileId: string): Promise<TicketsResult<Ticket[]>> {
    try {
      const { tracker, ignoredStatuses, backlogQuery, status } = await this.resolve(profileId)
      if (!tracker) return { ok: false, error: NOT_READY[status.state] }
      if (!tracker.capabilities.backlog || !tracker.listBacklog) return { ok: false, error: 'This ticket tracker has no backlog view' }
      return { ok: true, value: await tracker.listBacklog({ query: backlogQuery, projectKeys: status.projectKeys, ignoredStatuses }) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Runs a tracker call for a profile; every failure becomes a readable error, never a throw. */
  async call<T>(profileId: string, fn: (tracker: TicketTracker, ignoredStatuses: string[]) => Promise<T>): Promise<TicketsResult<T>> {
    try {
      const { tracker, ignoredStatuses, status } = await this.resolve(profileId)
      if (!tracker) return { ok: false, error: NOT_READY[status.state] }
      return { ok: true, value: await fn(tracker, ignoredStatuses) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

