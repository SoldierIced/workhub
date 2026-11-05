import { accountEnvRef, isValidEnvName, type AgentAccount, type AgentDefinition } from '../domain/agent'
import { connectionSecretRef, type Connection } from '../domain/connection'
import type { Profile } from '../domain/profile'
import { appOptions, type AppOptions, type WorkhubConfig } from '../config/schema'
import { EMPTY_SESSION_GROUPS, replaceSessionIdentity, type GroupMember, type SessionGroups } from '../domain/session-groups'
import type { ConfigStore, SecretStore } from '../ports'
import { fail, knownAgents, ok, validateConfig, type Result, type ValidationIssue } from './validation'
import type { AutomationDefinition } from '../automations/types'
import type { ChatWatcherSettings } from '../chat/types'
import { deleteAutomation, saveAutomation, setChatWatcher } from './chat-automation-config'
import { applyWorkhub1Import, type ImportPlan } from './workhub1-import'

const key = (i: ValidationIssue) => `${i.path}\u0000${i.message}`

/**
 * Applies a change and validates the result. Only issues the change introduces fail it, so a
 * hand-edited config with an old problem can still be edited (and fixed) from the UI.
 */
function commit(before: WorkhubConfig, after: WorkhubConfig): Result<WorkhubConfig> {
  const existing = new Set(validateConfig(before).map(key))
  const introduced = validateConfig(after).filter((i) => !existing.has(key(i)))
  return introduced.length ? fail(introduced) : ok(after)
}

const notFound = (path: string): Result<WorkhubConfig> => fail([{ path, message: 'not found' }])
const exists = (path: string): Result<WorkhubConfig> => fail([{ path, message: 'id already exists' }])

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  return items.map((i) => (i.id === item.id ? item : i))
}

// Connections

export function createConnection(config: WorkhubConfig, connection: Connection): Result<WorkhubConfig> {
  if (config.connections.some((c) => c.id === connection.id)) return exists(`connections.${connection.id}`)
  return commit(config, { ...config, connections: [...config.connections, connection] })
}

export function updateConnection(config: WorkhubConfig, connection: Connection): Result<WorkhubConfig> {
  if (!config.connections.some((c) => c.id === connection.id)) return notFound(`connections.${connection.id}`)
  return commit(config, { ...config, connections: replaceById(config.connections, connection) })
}

/** Refused while a profile uses the connection, so no profile is left pointing at nothing. */
export function deleteConnection(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.connections.some((c) => c.id === id)) return notFound(`connections.${id}`)
  const users = config.profiles.filter((p) => Object.values(p.connections).includes(id) || (p.planner?.calendarIds ?? []).includes(id)).map((p) => p.id)
  if (users.length) return fail([{ path: `connections.${id}`, message: `used by profile(s): ${users.join(', ')}` }])
  return commit(config, { ...config, connections: config.connections.filter((c) => c.id !== id) })
}

// Agent accounts

export function createAccount(config: WorkhubConfig, account: AgentAccount): Result<WorkhubConfig> {
  if (config.accounts.some((a) => a.id === account.id)) return exists(`accounts.${account.id}`)
  return commit(config, { ...config, accounts: [...config.accounts, account] })
}

export function updateAccount(config: WorkhubConfig, account: AgentAccount): Result<WorkhubConfig> {
  if (!config.accounts.some((a) => a.id === account.id)) return notFound(`accounts.${account.id}`)
  return commit(config, { ...config, accounts: replaceById(config.accounts, account) })
}

/** Refused while a profile or the chat watcher uses the account, so nothing is left pointing at nothing. */
export function deleteAccount(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.accounts.some((a) => a.id === id)) return notFound(`accounts.${id}`)
  const users = config.profiles.filter((p) => p.accountIds.includes(id)).map((p) => p.id)
  if (users.length) return fail([{ path: `accounts.${id}`, message: `used by profile(s): ${users.join(', ')}` }])
  if (config.chatWatcher?.accountId === id) return fail([{ path: `accounts.${id}`, message: 'used by the chat watcher' }])
  return commit(config, { ...config, accounts: config.accounts.filter((a) => a.id !== id) })
}

/** What `migrateAccountEnv` does: the config without plain account values, and the values to store. */
export interface AccountEnvMigration {
  config: WorkhubConfig
  secrets: { ref: string; value: string }[]
}

/**
 * Moves the plain values of `accounts[].env` out of the config: each valid name goes to `envNames`
 * and its value to the secret store under `accountEnvRef`. The agent's config-folder variable
 * (`accountConfigEnv`, e.g. `CLAUDE_CONFIG_DIR`) is a path, not a secret: it becomes the account's
 * `configDir` when that is empty, so the usage readers still find the folder. Names that are not
 * valid variable names stay where they are (validation reports them). Null when nothing moves.
 */
export function migrateAccountEnv(config: WorkhubConfig): AccountEnvMigration | null {
  const agents = knownAgents(config)
  const secrets: AccountEnvMigration['secrets'] = []
  let changed = false
  const accounts = config.accounts.map((account) => {
    const entries = Object.entries(account.env ?? {})
    if (!entries.length) return account
    const configEnv = agents.find((a) => a.id === account.agentId)?.accountConfigEnv
    const next: AgentAccount = { ...account }
    const kept: Record<string, string> = {}
    const names = [...(account.envNames ?? [])]
    for (const [name, value] of entries) {
      if (!isValidEnvName(name)) {
        kept[name] = value
        continue
      }
      changed = true
      if (name === configEnv && !next.configDir) {
        if (value) next.configDir = value
        continue
      }
      secrets.push({ ref: accountEnvRef(account.id, name), value })
      if (!names.includes(name)) names.push(name)
    }
    if (Object.keys(kept).length) next.env = kept
    else delete next.env
    if (names.length) next.envNames = names
    return next
  })
  return changed ? { config: { ...config, accounts }, secrets } : null
}

// Custom agents

export function saveAgent(config: WorkhubConfig, agent: AgentDefinition): Result<WorkhubConfig> {
  const custom = { ...agent, builtIn: false }
  const agents = config.agents.some((a) => a.id === agent.id)
    ? replaceById(config.agents, custom)
    : [...config.agents, custom]
  return commit(config, { ...config, agents })
}

/** Removes a user agent. Removing an override of a built-in agent restores the built-in one. */
export function deleteAgent(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.agents.some((a) => a.id === id)) return notFound(`agents.${id}`)
  return commit(config, { ...config, agents: config.agents.filter((a) => a.id !== id) })
}

// Profiles

export function createProfile(config: WorkhubConfig, profile: Profile): Result<WorkhubConfig> {
  if (config.profiles.some((p) => p.id === profile.id)) return exists(`profiles.${profile.id}`)
  const next = { ...config, profiles: [...config.profiles, profile] }
  // The first profile becomes the active one.
  if (!config.activeProfileId) next.activeProfileId = profile.id
  return commit(config, next)
}

export function updateProfile(config: WorkhubConfig, profile: Profile): Result<WorkhubConfig> {
  if (!config.profiles.some((p) => p.id === profile.id)) return notFound(`profiles.${profile.id}`)
  return commit(config, { ...config, profiles: replaceById(config.profiles, profile) })
}

/** Refused while an automation runs in the profile, so no automation is left pointing at nothing. */
export function deleteProfile(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.profiles.some((p) => p.id === id)) return notFound(`profiles.${id}`)
  const users = (config.automations ?? []).filter((a) => a.profileId === id).map((a) => a.id)
  if (users.length) return fail([{ path: `profiles.${id}`, message: `used by automation(s): ${users.join(', ')}` }])
  const profiles = config.profiles.filter((p) => p.id !== id)
  const next: WorkhubConfig = { ...config, profiles }
  if (config.activeProfileId === id) {
    if (profiles[0]) next.activeProfileId = profiles[0].id
    else delete next.activeProfileId
  }
  return commit(config, next)
}

export function setActiveProfile(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.profiles.some((p) => p.id === id)) return notFound(`profiles.${id}`)
  return commit(config, { ...config, activeProfileId: id })
}

export function setOptions(config: WorkhubConfig, options: Partial<AppOptions>): Result<WorkhubConfig> {
  return commit(config, { ...config, options: { ...appOptions(config), ...options } })
}

/** Replaces the stored session groups (the renderer computes them with the pure functions of `session-groups`). */
export function setSessionGroups(config: WorkhubConfig, groups: SessionGroups): Result<WorkhubConfig> {
  return commit(config, { ...config, sessionGroups: groups })
}

/**
 * Moves the group and position of one session to the session that replaces it (an automation, a
 * move to another account). A session with no place leaves the config as it was.
 */
export function replaceStoredSessionIdentity(
  config: WorkhubConfig,
  oldKey: string,
  newKey: string,
  meta?: Partial<Omit<GroupMember, 'key'>>
): Result<WorkhubConfig> {
  const before = config.sessionGroups ?? EMPTY_SESSION_GROUPS
  const after = replaceSessionIdentity(before, oldKey, newKey, meta)
  return after === before ? ok(config) : commit(config, { ...config, sessionGroups: after })
}

/**
 * Adds imported profiles, accounts and connections (ids that already exist must be left out by
 * the caller). Imported connections may lack their secret: secrets are never imported, so a
 * missing one is reported as a stored problem ("re-enter it") instead of refusing the import.
 */
export function addImported(
  config: WorkhubConfig,
  additions: { profiles: Profile[]; accounts: AgentAccount[]; connections: Connection[] }
): Result<WorkhubConfig> {
  for (const [list, items] of [
    ['profiles', additions.profiles],
    ['accounts', additions.accounts],
    ['connections', additions.connections]
  ] as const) {
    for (const item of items) {
      if ((config[list] as { id: string }[]).some((x) => x.id === item.id)) return exists(`${list}.${item.id}`)
    }
  }
  const next: WorkhubConfig = {
    ...config,
    profiles: [...config.profiles, ...additions.profiles],
    accounts: [...config.accounts, ...additions.accounts],
    connections: [...config.connections, ...additions.connections]
  }
  if (!next.activeProfileId && next.profiles[0]) next.activeProfileId = next.profiles[0].id
  return commitImported(config, next, additions.connections.map((c) => c.id))
}

/**
 * Validates an imported config like any change, except that the imported connections (by id) may
 * lack their secret: secrets are never imported, so the stored problem asks to re-enter it.
 */
export function commitImported(before: WorkhubConfig, next: WorkhubConfig, importedConnectionIds: string[]): Result<WorkhubConfig> {
  const imported = new Set(importedConnectionIds.map((id) => `connections.${id}.secretRef`))
  const result = commit(before, next)
  if (result.ok) return result
  const blocking = result.issues.filter((i) => !(imported.has(i.path) && i.message === 'a secret is required'))
  return blocking.length ? fail(blocking) : ok(next)
}

/** What to do with a connection's secret when saving it. */
export type SecretChange =
  /** Keep whatever secret the connection already has. */
  | { action: 'keep' }
  | { action: 'set'; value: string }
  | { action: 'clear' }

export const RETYPE_SECRET_TO_TEST = 'The address changed: enter the secret again to test this connection'

/**
 * The secret a "Test connection" may use for a connection as typed in a form. A typed secret is
 * used as is. Keeping the stored one only ever reads the secret Workhub saved for that connection
 * id, and only while the typed address is still the saved one: the stored secret is never sent to
 * an address it was not saved for, and the form never picks which stored secret is read.
 */
export async function secretForConnectionTest(
  config: WorkhubConfig,
  secrets: Pick<SecretStore, 'get'>,
  connection: Connection,
  change: SecretChange
): Promise<{ ok: true; secret: string | null } | { ok: false; error: string }> {
  if (change.action === 'set') return { ok: true, secret: change.value }
  if (change.action === 'clear') return { ok: true, secret: null }
  const saved = config.connections.find((c) => c.id === connection.id)
  if (!saved) return { ok: true, secret: null }
  if ((saved.endpoint ?? '').trim() !== (connection.endpoint ?? '').trim()) return { ok: false, error: RETYPE_SECRET_TO_TEST }
  return { ok: true, secret: await secrets.get(connectionSecretRef(saved.id)) }
}

/**
 * Config use cases bound to their stores. Every write validates first, then persists secrets,
 * then the config, so a rejected change touches neither store.
 *
 * Writes run one at a time, in call order: each reads the config inside its turn, so two writes
 * issued together (an automation moving a session while the user saves Settings) both land
 * instead of the later one overwriting the earlier one with a stale copy.
 */
export class ConfigurationService {
  private cache: WorkhubConfig | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: ConfigStore,
    private readonly secrets: SecretStore
  ) {}

  /** Reads the store again; queued behind pending writes so it never caches a copy they replace. */
  async load(): Promise<WorkhubConfig> {
    return this.serial(() => this.read())
  }

  async current(): Promise<WorkhubConfig> {
    return this.cache ?? this.read()
  }

  async issues(): Promise<ValidationIssue[]> {
    return validateConfig(await this.current())
  }

  async agents(): Promise<AgentDefinition[]> {
    return knownAgents(await this.current())
  }

  async saveConnection(
    connection: Connection,
    secret: SecretChange = { action: 'keep' }
  ): Promise<Result<WorkhubConfig>> {
    return this.serial(async () => {
      const config = await this.current()
      const previous = config.connections.find((c) => c.id === connection.id)
      const ref = connectionSecretRef(connection.id)
      const next: Connection = { ...connection }
      if (secret.action === 'set') next.secretRef = ref
      else if (secret.action === 'clear') delete next.secretRef
      else if (previous?.secretRef && !next.secretRef) next.secretRef = previous.secretRef

      if (secret.action === 'set' && !secret.value) {
        return fail([{ path: `connections.${connection.id}.secretRef`, message: 'the secret is empty' }])
      }
      const result = previous ? updateConnection(config, next) : createConnection(config, next)
      if (!result.ok) return result
      if (secret.action === 'set') await this.secrets.set(ref, secret.value)
      if (secret.action === 'clear' && previous?.secretRef === ref) await this.secrets.delete(ref)
      return this.persist(result)
    })
  }

  async deleteConnection(id: string): Promise<Result<WorkhubConfig>> {
    return this.serial(async () => {
      const config = await this.current()
      const previous = config.connections.find((c) => c.id === id)
      const result = deleteConnection(config, id)
      if (!result.ok) return result
      const saved = await this.persist(result)
      // Only the secret Workhub manages for this connection; a shared ref is left alone.
      if (previous?.secretRef === connectionSecretRef(id)) await this.secrets.delete(previous.secretRef)
      return saved
    })
  }

  async saveAccount(account: AgentAccount): Promise<Result<WorkhubConfig>> {
    return this.write((config) => (config.accounts.some((a) => a.id === account.id) ? updateAccount(config, account) : createAccount(config, account)))
  }

  async deleteAccount(id: string): Promise<Result<WorkhubConfig>> {
    return this.serial(async () => {
      const names = (await this.current()).accounts.find((a) => a.id === id)?.envNames ?? []
      const saved = await this.persist(deleteAccount(await this.current(), id))
      // The account's environment values go with it.
      if (saved.ok) for (const name of names) await this.secrets.delete(accountEnvRef(id, name))
      return saved
    })
  }

  /**
   * Moves plain account environment values from the config file to the secret store (see
   * `migrateAccountEnv`). The values are stored before the config drops them, so a failure never
   * loses one. Returns how many values moved to the secret store.
   */
  async migrateAccountEnv(): Promise<number> {
    return this.serial(async () => {
      const before = await this.current()
      const plan = migrateAccountEnv(before)
      if (!plan) return 0
      for (const { ref, value } of plan.secrets) await this.secrets.set(ref, value)
      await this.persist(ok(plan.config))
      return plan.secrets.length
    })
  }

  async saveProfile(profile: Profile): Promise<Result<WorkhubConfig>> {
    return this.write((config) => (config.profiles.some((p) => p.id === profile.id) ? updateProfile(config, profile) : createProfile(config, profile)))
  }

  async deleteProfile(id: string): Promise<Result<WorkhubConfig>> {
    return this.write((config) => deleteProfile(config, id))
  }

  async setActiveProfile(id: string): Promise<Result<WorkhubConfig>> {
    return this.write((config) => setActiveProfile(config, id))
  }

  async saveAgent(agent: AgentDefinition): Promise<Result<WorkhubConfig>> {
    return this.write((config) => saveAgent(config, agent))
  }

  async saveOptions(options: Partial<AppOptions>): Promise<Result<WorkhubConfig>> {
    return this.write((config) => setOptions(config, options))
  }

  async saveSessionGroups(groups: SessionGroups): Promise<Result<WorkhubConfig>> {
    return this.write((config) => setSessionGroups(config, groups))
  }

  /** For automations and account moves: the new session takes the old one's group and place. */
  async replaceSessionIdentity(oldKey: string, newKey: string, meta?: Partial<Omit<GroupMember, 'key'>>): Promise<Result<WorkhubConfig>> {
    return this.serial(async () => {
      const config = await this.current()
      const result = replaceStoredSessionIdentity(config, oldKey, newKey, meta)
      // Nothing to move (the usual case): do not rewrite the file.
      return result.ok && result.value === config ? result : this.persist(result)
    })
  }

  async saveChatWatcher(settings: ChatWatcherSettings): Promise<Result<WorkhubConfig>> {
    return this.write((config) => {
      const r = setChatWatcher(config, settings)
      return r.ok ? commit(config, r.value) : r
    })
  }

  async saveAutomation(automation: AutomationDefinition): Promise<Result<WorkhubConfig>> {
    return this.write((config) => {
      const r = saveAutomation(config, automation)
      return r.ok ? commit(config, r.value) : r
    })
  }

  async deleteAutomation(id: string): Promise<Result<WorkhubConfig>> {
    return this.write((config) => {
      const r = deleteAutomation(config, id)
      return r.ok ? commit(config, r.value) : r
    })
  }

  async addImported(additions: { profiles: Profile[]; accounts: AgentAccount[]; connections: Connection[] }): Promise<Result<WorkhubConfig>> {
    return this.write((config) => addImported(config, additions))
  }

  /** Applies a Workhub 1 import plan (see `applyWorkhub1Import`); the result's notes are the plan's plus what was already here. */
  async applyImport(plan: ImportPlan): Promise<Result<WorkhubConfig>> {
    return this.write((config) => applyWorkhub1Import(config, plan).result)
  }

  async deleteAgent(id: string): Promise<Result<WorkhubConfig>> {
    return this.write((config) => deleteAgent(config, id))
  }

  private async read(): Promise<WorkhubConfig> {
    this.cache = await this.store.load()
    return this.cache
  }

  /** Runs `task` after every task queued before it; a failed task does not stop the ones after it. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** A queued write: `change` gets the config as it is when the write's turn comes. */
  private write(change: (config: WorkhubConfig) => Result<WorkhubConfig>): Promise<Result<WorkhubConfig>> {
    return this.serial(async () => this.persist(change(await this.current())))
  }

  private async persist(result: Result<WorkhubConfig>): Promise<Result<WorkhubConfig>> {
    if (!result.ok) return result
    await this.store.save(result.value)
    this.cache = result.value
    return result
  }
}
