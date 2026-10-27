import type { Connection } from '../domain/connection'
import type { WorkhubConfig } from '../config/schema'
import type { SecretStore } from '../ports'
import { slugId, type Workhub1Settings } from './workhub1-import'
import type { ConfigurationService } from './configuration'

/**
 * Importing the tokens Workhub 1 keeps in the macOS Keychain. The secret value only ever travels
 * from the reader into `ConfigurationService.saveConnection` (and so the SecretStore): it is never
 * part of a result, an error or a log line.
 */

/** A Workhub 1 Keychain item (names only, never a value). */
export interface KeychainItemRef {
  service: string
  /** Omitted: any account of that service, as Workhub 1 reads it. */
  account?: string
}

export type KeychainRead =
  | { status: 'found'; value: string }
  | { status: 'notFound' }
  | { status: 'denied' }
  | { status: 'error'; code: string }

export type KeychainReader = (item: KeychainItemRef) => Promise<KeychainRead>

export interface Workhub1SecretTarget {
  connectionId: string
  item: KeychainItemRef
}

export type Workhub1SecretStatus = 'imported' | 'notFound' | 'denied' | 'error'

/** What the renderer learns per connection: a status and a short code, never the secret. */
export interface Workhub1SecretResult {
  connectionId: string
  name: string
  status: Workhub1SecretStatus
  code?: string
}

/**
 * The Keychain item behind each Workhub 2 connection that came from a Workhub 1 profile (same ids
 * as the settings import gives them): Jira reads the item `connections.jira.keychainService`
 * (default `workhub-jira-<profile id>`); Elastic reads `keychainItem`, for the user name when it
 * uses basic auth.
 */
export function workhub1SecretTargets(v1: Workhub1Settings): Workhub1SecretTarget[] {
  const targets: Workhub1SecretTarget[] = []
  for (const [index, p] of (v1.profiles ?? []).entries()) {
    const id = slugId(p.id ?? p.name ?? '', `profile-${index + 1}`)
    const jira = p.id ? v1.jira?.[p.id] : undefined
    if (p.id && jira?.site?.trim()) {
      targets.push({ connectionId: slugId(`jira-${id}`, 'jira'), item: { service: jira.keychainService?.trim() || `workhub-jira-${p.id}` } })
    }
    const obs = p.id ? v1.observability?.[p.id] : undefined
    if (obs?.elasticURL?.trim()) {
      const service = obs.keychainItem?.trim() ?? ''
      const account = obs.auth?.basic ? obs.auth.basic.username?.trim() : undefined
      targets.push({ connectionId: slugId(`elastic-${id}`, 'elastic'), item: account ? { service, account } : { service } })
    }
  }
  return targets
}

/** The `security -w` output without its line end; empty after that means "no secret". */
export function cleanKeychainValue(raw: string): string {
  return raw.replace(/\r?\n$/, '')
}

/** Connections of this config that need a secret, have none stored, and have a Workhub 1 item. */
export async function pendingWorkhub1Secrets(
  v1: Workhub1Settings,
  config: WorkhubConfig,
  secrets: Pick<SecretStore, 'has'>
): Promise<{ connection: Connection; item: KeychainItemRef }[]> {
  const out: { connection: Connection; item: KeychainItemRef }[] = []
  for (const target of workhub1SecretTargets(v1)) {
    const connection = config.connections.find((c) => c.id === target.connectionId)
    if (!connection || (connection.provider !== 'jira' && connection.provider !== 'elastic-apm')) continue
    if (connection.secretRef && (await secrets.has(connection.secretRef))) continue
    out.push({ connection, item: target.item })
  }
  return out
}

/**
 * Reads each pending connection's Workhub 1 Keychain item and saves it as that connection's
 * secret. One connection at a time: macOS may show an access prompt for each item.
 */
export async function importWorkhub1Secrets(
  v1: Workhub1Settings,
  configuration: Pick<ConfigurationService, 'current' | 'saveConnection'>,
  secrets: Pick<SecretStore, 'has'>,
  read: KeychainReader
): Promise<Workhub1SecretResult[]> {
  const results: Workhub1SecretResult[] = []
  for (const { connection, item } of await pendingWorkhub1Secrets(v1, await configuration.current(), secrets)) {
    const base = { connectionId: connection.id, name: connection.name || connection.id }
    if (!item.service) {
      results.push({ ...base, status: 'notFound' })
      continue
    }
    let read1: KeychainRead
    try {
      read1 = await read(item)
    } catch {
      results.push({ ...base, status: 'error', code: 'read-failed' })
      continue
    }
    if (read1.status === 'notFound' || read1.status === 'denied') {
      results.push({ ...base, status: read1.status })
      continue
    }
    if (read1.status === 'error') {
      results.push({ ...base, status: 'error', code: read1.code })
      continue
    }
    const value = cleanKeychainValue(read1.value)
    if (!value) {
      results.push({ ...base, status: 'notFound' })
      continue
    }
    try {
      const saved = await configuration.saveConnection(connection, { action: 'set', value })
      results.push(saved.ok ? { ...base, status: 'imported' } : { ...base, status: 'error', code: 'save-failed' })
    } catch {
      results.push({ ...base, status: 'error', code: 'save-failed' })
    }
  }
  return results
}
