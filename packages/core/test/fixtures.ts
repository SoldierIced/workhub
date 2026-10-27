import {
  emptyConfig,
  NO_MODULES,
  type AgentAccount,
  type ConfigStore,
  type Connection,
  type Profile,
  type SecretStore,
  type WorkhubConfig
} from '../src'

export const github: Connection = {
  id: 'acme-github',
  kind: 'codeHost',
  provider: 'github',
  name: 'Acme GitHub',
  secretRef: 'connection/acme-github',
  settings: { scope: 'org:acme' }
}

export const jira: Connection = {
  id: 'acme-jira',
  kind: 'tracker',
  provider: 'jira',
  endpoint: 'https://acme.example.com',
  secretRef: 'connection/acme-jira',
  settings: {}
}

export const kiroWork: AgentAccount = { id: 'kiro-work', agentId: 'kiro', name: 'Work', env: { ACME_ENV: 'work' } }
export const claudeA: AgentAccount = { id: 'claude-a', agentId: 'claude', name: 'Account A', configDir: '/tmp/claude-a' }
export const claudeB: AgentAccount = { id: 'claude-b', agentId: 'claude', name: 'Account B' }

export function profile(overrides: Partial<Profile> = {}): Profile {
  return { id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { ...NO_MODULES }, ...overrides }
}

export function config(overrides: Partial<WorkhubConfig> = {}): WorkhubConfig {
  return { ...emptyConfig(), ...overrides }
}

export class MemoryConfigStore implements ConfigStore {
  saved: WorkhubConfig[] = []
  constructor(private value: WorkhubConfig = emptyConfig()) {}
  async load(): Promise<WorkhubConfig> {
    return this.value
  }
  async save(config: WorkhubConfig): Promise<void> {
    this.value = config
    this.saved.push(config)
  }
}

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>()
  async get(ref: string) {
    return this.values.get(ref) ?? null
  }
  async set(ref: string, value: string) {
    this.values.set(ref, value)
  }
  async delete(ref: string) {
    this.values.delete(ref)
  }
  async has(ref: string) {
    return this.values.has(ref)
  }
}
