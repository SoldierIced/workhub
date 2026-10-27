import type { SecretStore } from '@workhub/core'
import { readFileIfExists, SerialQueue, writeFileAtomic } from '../shared/atomic-file'

/**
 * The part of Electron's `safeStorage` this store uses. Passed in, so this module does not
 * import Electron and can be tested with a fake. On macOS the key lives in the Keychain,
 * on Windows in DPAPI, on Linux in libsecret/kwallet.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface SecretsFile {
  version: 1
  /** ref -> base64 ciphertext */
  secrets: Record<string, string>
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('OS encryption is not available; Workhub will not store secrets in plain text.')
    this.name = 'EncryptionUnavailableError'
  }
}

/** SecretStore on `safeStorage`: ciphertexts in one JSON file, never plain text. */
export class SafeStorageSecretStore implements SecretStore {
  private readonly queue = new SerialQueue()

  constructor(
    readonly path: string,
    private readonly safeStorage: SafeStorageLike
  ) {}

  async get(ref: string): Promise<string | null> {
    const file = await this.read()
    const cipher = file.secrets[ref]
    if (cipher === undefined) return null
    this.requireEncryption()
    return this.safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }

  async has(ref: string): Promise<boolean> {
    return (await this.read()).secrets[ref] !== undefined
  }

  async set(ref: string, value: string): Promise<void> {
    this.requireEncryption()
    const cipher = this.safeStorage.encryptString(value).toString('base64')
    await this.queue.run(async () => {
      const file = await this.read()
      file.secrets[ref] = cipher
      await this.write(file)
    })
  }

  async delete(ref: string): Promise<void> {
    await this.queue.run(async () => {
      const file = await this.read()
      if (!(ref in file.secrets)) return
      delete file.secrets[ref]
      await this.write(file)
    })
  }

  private requireEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) throw new EncryptionUnavailableError()
  }

  private async read(): Promise<SecretsFile> {
    const text = await readFileIfExists(this.path)
    if (text === null) return { version: 1, secrets: {} }
    const parsed = JSON.parse(text) as Partial<SecretsFile>
    if (parsed.version !== 1 || typeof parsed.secrets !== 'object' || parsed.secrets === null) {
      throw new Error(`${this.path} is not a Workhub secrets file`)
    }
    return { version: 1, secrets: { ...parsed.secrets } }
  }

  private async write(file: SecretsFile): Promise<void> {
    // 0o600 applies on POSIX only. Windows has no file modes: there the file holds safeStorage (DPAPI)
    // ciphertext and is protected by that encryption plus the ACL of the user profile folder.
    await writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`, 0o600)
  }
}

/** SecretStore in memory, for tests and for running without OS encryption. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value)
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref)
  }
  async has(ref: string): Promise<boolean> {
    return this.values.has(ref)
  }
}
