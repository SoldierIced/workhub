import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  createAccount,
  createConnection,
  createProfile,
  deleteAccount,
  deleteConnection,
  deleteProfile,
  RETYPE_SECRET_TO_TEST,
  secretForConnectionTest,
  updateConnection,
  updateProfile,
  validateConfig,
  type Result,
  type WorkhubConfig
} from '../src'
import { claudeA, config, github, jira, kiroWork, MemoryConfigStore, MemorySecrets, profile } from './fixtures'

function value(r: Result<WorkhubConfig>): WorkhubConfig {
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.value
}

function messages(r: Result<WorkhubConfig>): string[] {
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
}

describe('connections', () => {
  it('creates a valid connection', () => {
    expect(value(createConnection(config(), github)).connections).toEqual([github])
  })

  it('rejects a duplicate id', () => {
    const c = value(createConnection(config(), github))
    expect(messages(createConnection(c, github))).toEqual(['connections.acme-github: id already exists'])
  })

  it('requires a secret when the provider needs one', () => {
    const { secretRef: _, ...noSecret } = jira
    expect(messages(createConnection(config(), noSecret))).toEqual(['connections.acme-jira.secretRef: a secret is required'])
  })

  it('does not require a secret for code hosts that read through the gh/glab login', () => {
    const { secretRef: _, ...noSecret } = github
    expect(createConnection(config(), noSecret).ok).toBe(true)
  })

  it('does not require a secret for providers that read through the agent', () => {
    const slack = { id: 'acme-slack', kind: 'chat' as const, provider: 'slack', settings: {} }
    expect(createConnection(config(), slack).ok).toBe(true)
  })

  it('requires an http(s) endpoint where the provider needs one', () => {
    expect(messages(createConnection(config(), { ...jira, endpoint: '' }))).toEqual([
      'connections.acme-jira.endpoint: endpoint is required'
    ])
    expect(messages(createConnection(config(), { ...jira, endpoint: 'ftp://acme.example.com' }))).toEqual([
      'connections.acme-jira.endpoint: endpoint must be an http(s) URL'
    ])
  })

  it('rejects an unknown provider and a provider of another kind', () => {
    expect(messages(createConnection(config(), { ...github, provider: 'bitbucket-x' }))).toEqual([
      'connections.acme-github.provider: unknown provider "bitbucket-x"'
    ])
    expect(messages(createConnection(config(), { ...github, provider: 'jira', endpoint: 'https://acme.example.com' }))).toEqual([
      'connections.acme-github.provider: provider "jira" is a tracker provider, not codeHost'
    ])
  })

  it('updates only existing connections', () => {
    expect(messages(updateConnection(config(), github))).toEqual(['connections.acme-github: not found'])
    const c = value(createConnection(config(), github))
    expect(value(updateConnection(c, { ...github, name: 'Renamed' })).connections[0]?.name).toBe('Renamed')
  })

  it('refuses to delete a connection a profile uses', () => {
    const c = config({ connections: [github], profiles: [profile({ connections: { codeHost: github.id } })] })
    expect(messages(deleteConnection(c, github.id))).toEqual(['connections.acme-github: used by profile(s): acme'])
    expect(value(deleteConnection(config({ connections: [github] }), github.id)).connections).toEqual([])
  })
})

describe('profiles', () => {
  const base = config({ connections: [github, jira], accounts: [kiroWork] })

  it('binds existing connections of the right kind and accounts', () => {
    const p = profile({ connections: { codeHost: github.id, tracker: jira.id }, accountIds: [kiroWork.id] })
    const c = value(createProfile(base, p))
    expect(c.profiles).toEqual([p])
    expect(c.activeProfileId).toBe('acme')
  })

  it('rejects a connection that does not exist', () => {
    const r = createProfile(base, profile({ connections: { codeHost: 'missing' } }))
    expect(messages(r)).toEqual(['profiles.acme.connections.codeHost: unknown connection "missing"'])
  })

  it('rejects a connection of the wrong kind', () => {
    const r = createProfile(base, profile({ connections: { codeHost: jira.id } }))
    expect(messages(r)).toEqual(['profiles.acme.connections.codeHost: connection "acme-jira" is a tracker connection, not codeHost'])
  })

  it('rejects unknown accounts and agents', () => {
    const r = createProfile(base, profile({ accountIds: ['nobody'], agentIds: ['no-agent'] }))
    expect(messages(r)).toEqual([
      'profiles.acme.accountIds: unknown account "nobody"',
      'profiles.acme.agentIds: unknown agent "no-agent"'
    ])
  })

  it('moves the active profile when the active one is deleted', () => {
    let c = value(createProfile(base, profile()))
    c = value(createProfile(c, profile({ id: 'beta', name: 'Beta' })))
    expect(value(deleteProfile(c, 'acme')).activeProfileId).toBe('beta')
    expect(value(deleteProfile(value(deleteProfile(c, 'acme')), 'beta')).activeProfileId).toBeUndefined()
  })

  it('lets an edit through when the config already had an unrelated problem', () => {
    // A hand-edited file: profile points at a connection that is gone.
    const broken = config({ profiles: [profile({ connections: { tracker: 'gone' } })] })
    expect(validateConfig(broken)).toHaveLength(1)
    expect(updateProfile(broken, { ...broken.profiles[0]!, name: 'Renamed' }).ok).toBe(true)
  })
})

describe('accounts', () => {
  it('requires a known agent and valid env names', () => {
    expect(messages(createAccount(config(), { ...kiroWork, agentId: 'nope' }))).toEqual([
      'accounts.kiro-work.agentId: unknown agent "nope"'
    ])
    expect(messages(createAccount(config(), { ...kiroWork, env: { '1BAD': 'x' } }))).toEqual([
      'accounts.kiro-work.env.1BAD: not a valid environment variable name'
    ])
  })

  it('refuses to delete an account a profile uses', () => {
    const c = config({ accounts: [claudeA], profiles: [profile({ accountIds: [claudeA.id] })] })
    expect(messages(deleteAccount(c, claudeA.id))).toEqual(['accounts.claude-a: used by profile(s): acme'])
  })
})

describe('ConfigurationService', () => {
  it('stores the secret under a managed ref and never in the config', async () => {
    const store = new MemoryConfigStore()
    const secrets = new MemorySecrets()
    const svc = new ConfigurationService(store, secrets)
    const { secretRef: _, ...conn } = github
    const r = await svc.saveConnection(conn, { action: 'set', value: 'token-123' })
    expect(r.ok).toBe(true)
    expect(secrets.values.get('connection/acme-github')).toBe('token-123')
    expect(JSON.stringify(store.saved.at(-1))).not.toContain('token-123')
    expect(store.saved.at(-1)?.connections[0]?.secretRef).toBe('connection/acme-github')
  })

  it('keeps the existing secret when the form does not resend it', async () => {
    const store = new MemoryConfigStore(config({ connections: [github] }))
    const svc = new ConfigurationService(store, new MemorySecrets())
    const { secretRef: _, ...edited } = { ...github, name: 'Edited' }
    expect((await svc.saveConnection(edited)).ok).toBe(true)
    expect(store.saved.at(-1)?.connections[0]).toMatchObject({ name: 'Edited', secretRef: github.secretRef })
  })

  it('writes nothing when validation fails', async () => {
    const store = new MemoryConfigStore()
    const secrets = new MemorySecrets()
    const svc = new ConfigurationService(store, secrets)
    const r = await svc.saveConnection({ ...jira, endpoint: '' }, { action: 'set', value: 'x' })
    expect(r.ok).toBe(false)
    expect(store.saved).toHaveLength(0)
    expect(secrets.values.size).toBe(0)
  })

  it('rejects an empty secret', async () => {
    const svc = new ConfigurationService(new MemoryConfigStore(), new MemorySecrets())
    expect((await svc.saveConnection(github, { action: 'set', value: '' })).ok).toBe(false)
  })

  it('deletes the managed secret with the connection', async () => {
    const secrets = new MemorySecrets()
    await secrets.set('connection/acme-github', 'token')
    const svc = new ConfigurationService(new MemoryConfigStore(config({ connections: [github] })), secrets)
    expect((await svc.deleteConnection(github.id)).ok).toBe(true)
    expect(secrets.values.size).toBe(0)
  })

  it('creates and updates profiles and accounts through the same save call', async () => {
    const store = new MemoryConfigStore(config({ connections: [github] }))
    const svc = new ConfigurationService(store, new MemorySecrets())
    expect((await svc.saveAccount(kiroWork)).ok).toBe(true)
    expect((await svc.saveProfile(profile({ accountIds: [kiroWork.id] }))).ok).toBe(true)
    expect((await svc.saveProfile(profile({ name: 'Acme 2', accountIds: [kiroWork.id] }))).ok).toBe(true)
    const saved = store.saved.at(-1)!
    expect(saved.profiles).toHaveLength(1)
    expect(saved.profiles[0]?.name).toBe('Acme 2')
  })
})

describe('secretForConnectionTest', () => {
  const saved = { ...jira, secretRef: 'connection/acme-jira' }
  const secrets = new MemorySecrets()
  secrets.values.set('connection/acme-jira', 'stored')
  secrets.values.set('connection/other', 'other')
  const cfg = config({ connections: [saved] })

  it('uses a typed secret as is and no secret when cleared', async () => {
    expect(await secretForConnectionTest(cfg, secrets, { ...saved, endpoint: 'https://new.example.com' }, { action: 'set', value: 'typed' })).toEqual({ ok: true, secret: 'typed' })
    expect(await secretForConnectionTest(cfg, secrets, saved, { action: 'clear' })).toEqual({ ok: true, secret: null })
  })

  it('keeps only the stored secret of the saved connection, for its saved address', async () => {
    expect(await secretForConnectionTest(cfg, secrets, saved, { action: 'keep' })).toEqual({ ok: true, secret: 'stored' })
    expect(await secretForConnectionTest(cfg, secrets, { ...saved, secretRef: 'connection/other' }, { action: 'keep' })).toEqual({ ok: true, secret: 'stored' })
    expect(await secretForConnectionTest(cfg, secrets, { ...saved, endpoint: 'https://attacker.example.net' }, { action: 'keep' })).toEqual({ ok: false, error: RETYPE_SECRET_TO_TEST })
    expect(await secretForConnectionTest(cfg, secrets, { ...saved, endpoint: undefined }, { action: 'keep' })).toEqual({ ok: false, error: RETYPE_SECRET_TO_TEST })
    expect(await secretForConnectionTest(cfg, secrets, { ...saved, id: 'other', secretRef: 'connection/other' }, { action: 'keep' })).toEqual({ ok: true, secret: null })
  })
})

describe('schema rules inside validation', () => {
  it('reports what the config schema would reject, by item id or position', () => {
    const bad = { ...config(), profiles: [profile({ id: '', name: '' })] }
    const found = validateConfig(bad).filter((i) => i.code)
    expect(found.map((i) => i.path)).toEqual(expect.arrayContaining(['profiles.#0.id', 'profiles.#0.name']))
    expect(validateConfig({ ...config(), profiles: [profile({ id: 'Bad Id' })] }).some((i) => i.path === 'profiles.Bad Id.id' && i.code === 'invalid_format')).toBe(true)
  })

  it('refuses an incomplete profile as a result and never reaches the store', async () => {
    const store = new MemoryConfigStore(config())
    const service = new ConfigurationService(store, new MemorySecrets())
    const saved = vi.spyOn(store, 'save')
    const r = await service.saveProfile(profile({ id: '', name: '' }))
    expect(r.ok).toBe(false)
    expect(saved).not.toHaveBeenCalled()
  })
})
