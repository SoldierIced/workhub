import type { AgentAccount, AgentDefinition } from '../domain/agent'
import { connectionSecretRef, type Connection } from '../domain/connection'
import type { Profile } from '../domain/profile'
import { appOptions, type AppOptions, type WorkhubConfig } from '../config/schema'
import type { ConfigStore, SecretStore } from '../ports'
import { fail, knownAgents, ok, validateConfig, type Result, type ValidationIssue } from './validation'

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
  const users = config.profiles.filter((p) => Object.values(p.connections).includes(id)).map((p) => p.id)
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

export function deleteAccount(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.accounts.some((a) => a.id === id)) return notFound(`accounts.${id}`)
  const users = config.profiles.filter((p) => p.accountIds.includes(id)).map((p) => p.id)
  if (users.length) return fail([{ path: `accounts.${id}`, message: `used by profile(s): ${users.join(', ')}` }])
  return commit(config, { ...config, accounts: config.accounts.filter((a) => a.id !== id) })
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

export function deleteProfile(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  if (!config.profiles.some((p) => p.id === id)) return notFound(`profiles.${id}`)
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
  const imported = new Set(additions.connections.map((c) => `connections.${c.id}.secretRef`))
  const result = commit(config, next)
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

/**
 * Config use cases bound to their stores. Every write validates first, then persists secrets,
 * then the config, so a rejected change touches neither store.
 */
export class ConfigurationService {
  private cache: WorkhubConfig | null = null

  constructor(
    private readonly store: ConfigStore,
    private readonly secrets: SecretStore
  ) {}

  async load(): Promise<WorkhubConfig> {
    this.cache = await this.store.load()
    return this.cache
  }

  async current(): Promise<WorkhubConfig> {
    return this.cache ?? this.load()
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
  }

  async deleteConnection(id: string): Promise<Result<WorkhubConfig>> {
    const config = await this.current()
    const previous = config.connections.find((c) => c.id === id)
    const result = deleteConnection(config, id)
    if (!result.ok) return result
    const saved = await this.persist(result)
    // Only the secret Workhub manages for this connection; a shared ref is left alone.
    if (previous?.secretRef === connectionSecretRef(id)) await this.secrets.delete(previous.secretRef)
    return saved
  }

  async saveAccount(account: AgentAccount): Promise<Result<WorkhubConfig>> {
    const config = await this.current()
    const exists = config.accounts.some((a) => a.id === account.id)
    return this.persist(exists ? updateAccount(config, account) : createAccount(config, account))
  }

  async deleteAccount(id: string): Promise<Result<WorkhubConfig>> {
    return this.persist(deleteAccount(await this.current(), id))
  }

  async saveProfile(profile: Profile): Promise<Result<WorkhubConfig>> {
    const config = await this.current()
    const exists = config.profiles.some((p) => p.id === profile.id)
    return this.persist(exists ? updateProfile(config, profile) : createProfile(config, profile))
  }

  async deleteProfile(id: string): Promise<Result<WorkhubConfig>> {
    return this.persist(deleteProfile(await this.current(), id))
  }

  async setActiveProfile(id: string): Promise<Result<WorkhubConfig>> {
    return this.persist(setActiveProfile(await this.current(), id))
  }

  async saveAgent(agent: AgentDefinition): Promise<Result<WorkhubConfig>> {
    return this.persist(saveAgent(await this.current(), agent))
  }

  async saveOptions(options: Partial<AppOptions>): Promise<Result<WorkhubConfig>> {
    return this.persist(setOptions(await this.current(), options))
  }

  async addImported(additions: { profiles: Profile[]; accounts: AgentAccount[]; connections: Connection[] }): Promise<Result<WorkhubConfig>> {
    return this.persist(addImported(await this.current(), additions))
  }

  async deleteAgent(id: string): Promise<Result<WorkhubConfig>> {
    return this.persist(deleteAgent(await this.current(), id))
  }

  private async persist(result: Result<WorkhubConfig>): Promise<Result<WorkhubConfig>> {
    if (!result.ok) return result
    await this.store.save(result.value)
    this.cache = result.value
    return result
  }
}
