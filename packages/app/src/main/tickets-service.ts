import { DemoTracker } from '@workhub/adapters/tracker-demo'
import { JiraTracker } from '@workhub/adapters/tracker-jira'
import { LinearTracker } from '@workhub/adapters/tracker-linear'
import type { HttpClient } from '@workhub/adapters/http'
import {
  connectionSecretRef,
  type ConfigurationService,
  type Connection,
  type ConnectionTest,
  type SecretChange,
  type SecretStore,
  type TicketTracker
} from '@workhub/core'
import type { TicketsResult, TicketsStatus } from '../shared/tickets-api'

const NOT_READY: Record<TicketsStatus['state'], string> = {
  ready: '',
  demo: '',
  noConnection: 'This profile has no ticket tracker connection',
  incomplete: 'The ticket tracker connection is incomplete',
  unsupported: 'This ticket tracker is not supported yet'
}

/** Settings keys a tracker connection uses (Settings → Trackers writes them). */
export const TRACKER_SETTINGS = { email: 'email', ignoredStatuses: 'ignoredStatuses', projectKeys: 'projectKeys' } as const

const list = (value: string | undefined) =>
  (value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)

interface Resolved {
  status: TicketsStatus
  tracker?: TicketTracker
  ignoredStatuses: string[]
}

/** Builds a tracker from a saved or typed connection; `incomplete` names what is missing. */
export function buildTracker(connection: Connection, secret: string | null, http?: HttpClient): { tracker: TicketTracker } | { missing: 'unsupported' | 'incomplete'; detail?: string } {
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
  return { missing: 'unsupported' }
}

/** Resolves the tracker of a profile from its connection and serves the renderer's ticket calls. */
export class TicketService {
  private readonly demos = new Map<string, DemoTracker>()

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly secrets: SecretStore,
    private readonly demo: boolean,
    private readonly http?: HttpClient
  ) {}

  async resolve(profileId: string | null): Promise<Resolved> {
    const config = await this.configuration.current()
    const profile = config.profiles.find((p) => p.id === profileId)
    const connection = config.connections.find((c) => c.id === profile?.connections.tracker)
    const projectKeys = connection ? list(connection.settings[TRACKER_SETTINGS.projectKeys]) : []
    const ignoredStatuses = connection ? list(connection.settings[TRACKER_SETTINGS.ignoredStatuses]) : []
    const base = { provider: connection?.provider, connectionName: connection ? connection.name || connection.id : undefined, projectKeys }
    if (this.demo && profileId) {
      const tracker = this.demos.get(profileId) ?? new DemoTracker(connection?.provider ?? 'jira')
      this.demos.set(profileId, tracker)
      return { status: { ...base, state: 'demo' }, tracker, ignoredStatuses }
    }
    if (!connection) return { status: { state: 'noConnection', projectKeys }, ignoredStatuses }
    const secret = connection.secretRef ? await this.secrets.get(connection.secretRef) : null
    const built = buildTracker(connection, secret, this.http)
    if ('missing' in built) return { status: { ...base, state: built.missing }, ignoredStatuses }
    return { status: { ...base, state: 'ready' }, tracker: built.tracker, ignoredStatuses }
  }

  async status(profileId: string | null): Promise<TicketsStatus> {
    return (await this.resolve(profileId)).status
  }

  async test(connection: Connection, change: SecretChange): Promise<ConnectionTest> {
    if (this.demo) return new DemoTracker(connection.provider).testConnection()
    const ref = connection.secretRef ?? connectionSecretRef(connection.id)
    const secret = change.action === 'set' ? change.value : change.action === 'keep' ? await this.secrets.get(ref) : null
    try {
      const built = buildTracker(connection, secret, this.http)
      if ('missing' in built) return { ok: false, error: built.missing === 'unsupported' ? NOT_READY.unsupported : `The ${built.detail} is missing` }
      return await built.tracker.testConnection()
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

