import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_VERSION, ConfigParseError, ConfigVersionError, emptyConfig, type WorkhubConfig } from '@workhub/core'
import { JsonConfigStore } from '../src/config-json'
import { EncryptionUnavailableError, MemorySecretStore, SafeStorageSecretStore, type SafeStorageLike } from '../src/secrets-electron'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workhub-adapters-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sample: WorkhubConfig = {
  ...emptyConfig(),
  connections: [{ id: 'acme-github', kind: 'codeHost', provider: 'github', secretRef: 'connection/acme-github', settings: {} }],
  profiles: [
    {
      id: 'acme',
      name: 'Acme',
      connections: { codeHost: 'acme-github' },
      accountIds: [],
      modules: { flows: true, health: false, chatWatcher: false, automations: false }
    }
  ],
  activeProfileId: 'acme'
}

describe('JsonConfigStore', () => {
  it('loads an empty config when the file is missing', async () => {
    expect(await new JsonConfigStore(join(dir, 'config.json')).load()).toEqual(emptyConfig())
  })

  it('round-trips a config and creates missing folders', async () => {
    const path = join(dir, 'nested', 'config.json')
    const store = new JsonConfigStore(path)
    await store.save(sample)
    expect(await new JsonConfigStore(path).load()).toEqual(sample)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('leaves no temp files behind, even with concurrent saves', async () => {
    const store = new JsonConfigStore(join(dir, 'config.json'))
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ ...sample, profiles: [{ ...sample.profiles[0]!, name: `Acme ${n}` }] })))
    expect(await readdir(dir)).toEqual(['config.json'])
    expect((await store.load()).profiles[0]?.name).toBe('Acme 5')
  })

  it('migrates an unversioned file on load', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, JSON.stringify({ profiles: [{ id: 'acme', name: 'Acme' }] }))
    expect((await new JsonConfigStore(path).load()).version).toBe(CONFIG_VERSION)
  })

  it('refuses corrupt or newer files without touching them', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, '{ not json')
    await expect(new JsonConfigStore(path).load()).rejects.toBeInstanceOf(ConfigParseError)
    expect(await readFile(path, 'utf8')).toBe('{ not json')
    await writeFile(path, JSON.stringify({ version: 99 }))
    await expect(new JsonConfigStore(path).load()).rejects.toBeInstanceOf(ConfigVersionError)
  })

  it('refuses to save a config with a bad shape', async () => {
    const store = new JsonConfigStore(join(dir, 'config.json'))
    await expect(store.save({ ...sample, profiles: [{ ...sample.profiles[0]!, id: 'Bad Id' }] })).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })
})

/** Reversible fake: not encryption, just enough to prove plain text never reaches the file. */
const fakeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8')
})

describe('SafeStorageSecretStore', () => {
  it('stores ciphertext only and reads it back', async () => {
    const path = join(dir, 'secrets.json')
    const store = new SafeStorageSecretStore(path, fakeSafeStorage())
    await store.set('connection/acme-github', 'dummy-token-123')
    expect(await readFile(path, 'utf8')).not.toContain('dummy-token-123')
    expect(await new SafeStorageSecretStore(path, fakeSafeStorage()).get('connection/acme-github')).toBe('dummy-token-123')
    expect(await store.has('connection/acme-github')).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('deletes secrets and returns null for unknown refs', async () => {
    const store = new SafeStorageSecretStore(join(dir, 'secrets.json'), fakeSafeStorage())
    await store.set('a', '1')
    await store.set('b', '2')
    await store.delete('a')
    expect(await store.get('a')).toBeNull()
    expect(await store.get('b')).toBe('2')
  })

  it('refuses to store when OS encryption is unavailable', async () => {
    const path = join(dir, 'secrets.json')
    await expect(new SafeStorageSecretStore(path, fakeSafeStorage(false)).set('a', '1')).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    )
    expect(await readdir(dir)).toEqual([])
  })
})

describe('MemorySecretStore', () => {
  it('implements the port', async () => {
    const s = new MemorySecretStore()
    await s.set('x', 'y')
    expect([await s.get('x'), await s.has('x')]).toEqual(['y', true])
    await s.delete('x')
    expect(await s.get('x')).toBeNull()
  })
})
