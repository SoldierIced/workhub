import { describe, expect, it } from 'vitest'
import { accountEnvRef, BUILTIN_AGENTS, ConfigurationService, launchEnvironment, migrateAccountEnv, parseConfig, type AgentAccount } from '../src'
import { config, MemoryConfigStore, MemorySecrets, profile } from './fixtures'

const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!
const work: AgentAccount = { id: 'work', agentId: 'claude', name: 'Work', env: { ANTHROPIC_API_KEY: 'sk-example', ACME_REGION: 'eu' } }

describe('migrateAccountEnv', () => {
  it('moves plain values to secret refs and keeps only the names in the config', () => {
    const plan = migrateAccountEnv(config({ accounts: [work] }))
    expect(plan?.secrets).toEqual([
      { ref: accountEnvRef('work', 'ANTHROPIC_API_KEY'), value: 'sk-example' },
      { ref: accountEnvRef('work', 'ACME_REGION'), value: 'eu' }
    ])
    const account = plan!.config.accounts[0]!
    expect(account.env).toBeUndefined()
    expect(account.envNames).toEqual(['ANTHROPIC_API_KEY', 'ACME_REGION'])
    expect(JSON.stringify(plan!.config)).not.toContain('sk-example')
  })

  it("turns the agent's config-folder variable into the account's config folder", () => {
    const plan = migrateAccountEnv(config({ accounts: [{ ...work, env: { CLAUDE_CONFIG_DIR: '/tmp/claude-work' } }] }))
    expect(plan?.secrets).toEqual([])
    expect(plan?.config.accounts[0]).toMatchObject({ configDir: '/tmp/claude-work' })
    expect(plan?.config.accounts[0]?.envNames).toBeUndefined()
  })

  it('keeps names that are not valid variable names, and does nothing when there is nothing to move', () => {
    const plan = migrateAccountEnv(config({ accounts: [{ ...work, env: { 'BAD NAME': 'x', GOOD: 'y' } }] }))
    expect(plan?.config.accounts[0]?.env).toEqual({ 'BAD NAME': 'x' })
    expect(migrateAccountEnv(config({ accounts: [{ id: 'a', agentId: 'claude', name: 'A' }] }))).toBeNull()
  })

  it('loads a config whose accounts list envNames', () => {
    expect(parseConfig({ version: 8, connections: [], agents: [], accounts: [{ id: 'a', agentId: 'claude', name: 'A', envNames: ['ACME_TOKEN'] }], profiles: [] }).accounts[0]?.envNames).toEqual(['ACME_TOKEN'])
  })
})

describe('ConfigurationService account environment', () => {
  it('stores the values before the config drops them, then forgets them with the account', async () => {
    const store = new MemoryConfigStore(config({ accounts: [work], profiles: [profile({ accountIds: [] })] }))
    const secrets = new MemorySecrets()
    const svc = new ConfigurationService(store, secrets)
    expect(await svc.migrateAccountEnv()).toBe(2)
    expect(secrets.values.get(accountEnvRef('work', 'ANTHROPIC_API_KEY'))).toBe('sk-example')
    expect(JSON.stringify(store.saved.at(-1))).not.toContain('sk-example')
    expect(await svc.migrateAccountEnv()).toBe(0)
    expect((await svc.deleteAccount('work')).ok).toBe(true)
    expect(secrets.values.size).toBe(0)
  })
})

describe('launchEnvironment with stored account values', () => {
  it('puts the stored values in the account position: the config folder still wins', () => {
    const account: AgentAccount = { id: 'a', agentId: 'claude', name: 'A', configDir: '/tmp/a', envNames: ['ACME', 'CLAUDE_CONFIG_DIR'] }
    expect(launchEnvironment(claude, account, { ACME: '1', CLAUDE_CONFIG_DIR: '/elsewhere' })).toEqual({ ACME: '1', CLAUDE_CONFIG_DIR: '/tmp/a' })
  })
})
