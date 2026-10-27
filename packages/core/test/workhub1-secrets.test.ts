import { describe, expect, it } from 'vitest'
import { ConfigurationService, importWorkhub1Secrets, workhub1SecretTargets, type KeychainItemRef, type KeychainRead, type Workhub1Settings } from '../src'
import { config, MemoryConfigStore, MemorySecrets } from './fixtures'

const SECRET = 'S3CRET-token-value-123'

const v1: Workhub1Settings = {
  profiles: [{ id: 'acme', name: 'Acme' }],
  jira: { acme: { site: 'acme.atlassian.net', keychainService: 'workhub-jira-acme' } },
  observability: { acme: { elasticURL: 'https://es.acme.test:9200', keychainItem: 'acme-elastic', auth: { basic: { username: 'reader' } } } }
}

const jiraConn = { id: 'jira-acme', kind: 'tracker', provider: 'jira', name: 'Jira (Acme)', endpoint: 'https://acme.atlassian.net', settings: {} } as const
const elasticConn = { id: 'elastic-acme', kind: 'health', provider: 'elastic-apm', name: 'Elastic (Acme)', endpoint: 'https://es.acme.test:9200', settings: {} } as const

class SpySecrets extends MemorySecrets {
  readonly sets: string[] = []
  override async set(ref: string, value: string) {
    this.sets.push(ref)
    return super.set(ref, value)
  }
}

async function setup() {
  const secrets = new SpySecrets()
  const svc = new ConfigurationService(new MemoryConfigStore(config({ connections: [{ ...jiraConn }, { ...elasticConn }] })), secrets)
  await svc.load()
  return { svc, secrets }
}

describe('workhub1SecretTargets', () => {
  it('maps profiles to the Keychain items of Workhub 1 (names only)', () => {
    expect(workhub1SecretTargets(v1)).toEqual([
      { connectionId: 'jira-acme', item: { service: 'workhub-jira-acme' } },
      { connectionId: 'elastic-acme', item: { service: 'acme-elastic', account: 'reader' } }
    ])
  })

  it('defaults the Jira service and leaves the Elastic account out for an API key', () => {
    const t = workhub1SecretTargets({ profiles: [{ id: 'x' }], jira: { x: { site: 's' } }, observability: { x: { elasticURL: 'https://e', keychainItem: ' item ', auth: { apiKey: {} } } } })
    expect(t).toEqual([
      { connectionId: 'jira-x', item: { service: 'workhub-jira-x' } },
      { connectionId: 'elastic-x', item: { service: 'item' } }
    ])
  })
})

describe('importWorkhub1Secrets', () => {
  it('stores found secrets in the SecretStore and reports statuses only', async () => {
    const { svc, secrets } = await setup()
    const asked: KeychainItemRef[] = []
    const results = await importWorkhub1Secrets(v1, svc, secrets, async (item): Promise<KeychainRead> => {
      asked.push(item)
      return { status: 'found', value: `${SECRET}\n` }
    })
    expect(asked).toEqual([{ service: 'workhub-jira-acme' }, { service: 'acme-elastic', account: 'reader' }])
    expect(results).toEqual([
      { connectionId: 'jira-acme', name: 'Jira (Acme)', status: 'imported' },
      { connectionId: 'elastic-acme', name: 'Elastic (Acme)', status: 'imported' }
    ])
    expect(JSON.stringify(results)).not.toContain(SECRET)
    expect(await secrets.get('connection/jira-acme')).toBe(SECRET)
    expect((await svc.issues()).length).toBe(0)
  })

  it('reports not found, denied and errors without storing or leaking anything', async () => {
    const { svc, secrets } = await setup()
    const reads: KeychainRead[] = [{ status: 'denied' }, { status: 'error', code: 'exit-1' }]
    const results = await importWorkhub1Secrets(v1, svc, secrets, async () => reads.shift()!)
    expect(results.map((r) => [r.status, r.code])).toEqual([['denied', undefined], ['error', 'exit-1']])
    expect(secrets.sets).toEqual([])
    const again = await importWorkhub1Secrets(v1, svc, secrets, async () => ({ status: 'notFound' }))
    expect(again.map((r) => r.status)).toEqual(['notFound', 'notFound'])
  })

  it('treats an empty value as not found and never puts a thrown reader message in the result', async () => {
    const { svc, secrets } = await setup()
    const empty = await importWorkhub1Secrets(v1, svc, secrets, async () => ({ status: 'found', value: '\n' }))
    expect(empty.map((r) => r.status)).toEqual(['notFound', 'notFound'])
    const thrown = await importWorkhub1Secrets(v1, svc, secrets, async () => {
      throw new Error(`boom ${SECRET}`)
    })
    expect(thrown.map((r) => [r.status, r.code])).toEqual([['error', 'read-failed'], ['error', 'read-failed']])
    expect(JSON.stringify(thrown)).not.toContain(SECRET)
  })

  it('skips connections that already have a secret', async () => {
    const { svc, secrets } = await setup()
    await svc.saveConnection({ ...jiraConn }, { action: 'set', value: 'existing' })
    const asked: KeychainItemRef[] = []
    await importWorkhub1Secrets(v1, svc, secrets, async (item) => {
      asked.push(item)
      return { status: 'notFound' }
    })
    expect(asked).toEqual([{ service: 'acme-elastic', account: 'reader' }])
    expect(await secrets.get('connection/jira-acme')).toBe('existing')
  })

  it('does not report a failing save with the secret in it', async () => {
    const { svc, secrets } = await setup()
    const failing = { current: () => svc.current(), saveConnection: async () => { throw new Error(`disk ${SECRET}`) } }
    const results = await importWorkhub1Secrets(v1, failing, secrets, async () => ({ status: 'found', value: SECRET }))
    expect(results.map((r) => r.code)).toEqual(['save-failed', 'save-failed'])
    expect(JSON.stringify(results)).not.toContain(SECRET)
  })
})
