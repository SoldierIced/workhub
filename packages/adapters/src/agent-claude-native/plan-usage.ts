/**
 * Claude plan usage per account, the way Workhub 1 reads it: the account's own Claude Code OAuth
 * login is sent to Anthropic's undocumented `api/oauth/usage` endpoint. Workhub 2 only calls this
 * when the user turns it on in Settings (off by default, PLAN section 6). The token is read, used
 * for this one request and never stored; an expired login is reported, never renewed.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlanUsageWindow, UsageProvider } from '@workhub/core'
import { PlanUsageError } from '../shared/plan-usage-error'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/** Response fields and the window names Workhub shows for them, in display order. */
const FIELDS: readonly [string, string][] = [
  ['five_hour', '5h'],
  ['seven_day', 'weekly'],
  ['seven_day_opus', 'weekly Opus'],
  ['seven_day_sonnet', 'weekly Sonnet']
]

export { PlanUsageError }

/** The windows of a usage response; fields without a numeric utilization are left out. */
export function parsePlanUsage(body: unknown): PlanUsageWindow[] {
  const data = obj(body) ?? {}
  return FIELDS.flatMap(([field, window]) => {
    const entry = obj(data[field])
    const raw = entry?.['utilization']
    const percent = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!entry || !Number.isFinite(percent)) return []
    const w: PlanUsageWindow = { window, percent: Math.min(100, Math.max(0, percent)) }
    const resets = typeof entry['resets_at'] === 'string' ? Date.parse(entry['resets_at']) : NaN
    if (!Number.isNaN(resets)) w.resetsAt = resets
    return [w]
  })
}

/** `claudeAiOauth.accessToken` of a credentials document. */
export function accessToken(credentials: string): string | null {
  try {
    const token = obj(obj(JSON.parse(credentials))?.['claudeAiOauth'])?.['accessToken']
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

/**
 * Claude Code's Keychain item names for a config folder (macOS): `Claude Code-credentials-<first
 * 8 hex of SHA-256(path)>`, and the unsuffixed name only for the default `~/.claude`.
 */
export function keychainServices(folder: string, resolvedFolder: string, defaultFolder: string): string[] {
  const services: string[] = []
  for (const spelling of [folder, resolvedFolder]) {
    const service = `${KEYCHAIN_SERVICE}-${createHash('sha256').update(spelling).digest('hex').slice(0, 8)}`
    if (!services.includes(service)) services.push(service)
  }
  if (resolvedFolder === defaultFolder) services.push(KEYCHAIN_SERVICE)
  return services
}

function keychainPassword(service: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 10_000 }, (err, stdout) =>
      done(err ? null : stdout.trim() || null)
    )
  })
}

export interface ClaudePlanUsageOptions {
  fetch?: typeof fetch
  /** Reads a credentials file; injectable for tests. */
  readCredentials?: (path: string) => Promise<string | null>
  /** Reads a Keychain item (macOS); injectable for tests. */
  keychain?: (service: string) => Promise<string | null>
  platform?: NodeJS.Platform
  userAgent?: string
  now?: () => number
}

export class ClaudePlanUsageReader implements UsageProvider {
  readonly agentId = 'claude'
  private readonly cache = new Map<string, { at: number; windows: PlanUsageWindow[] }>()
  private readonly retryAt = new Map<string, number>()

  constructor(private readonly options: ClaudePlanUsageOptions = {}) {}

  async read(configDir: string | undefined): Promise<PlanUsageWindow[]> {
    const now = this.options.now?.() ?? Date.now()
    const defaultFolder = join(homedir(), '.claude')
    const folder = resolve(configDir || defaultFolder)
    const cached = this.cache.get(folder)
    const retry = this.retryAt.get(folder) ?? 0
    if (cached && (now - cached.at < 45_000 || now < retry)) return cached.windows
    if (now < retry) throw new PlanUsageError('rateLimited', 'Anthropic is rate limiting usage reads; retrying later')

    const token = await this.token(folder, defaultFolder)
    if (!token) throw new PlanUsageError('noLogin', 'No Claude Code login for this config folder')
    let res: Response
    try {
      res = await (this.options.fetch ?? fetch)(ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': this.options.userAgent ?? 'workhub'
        },
        signal: AbortSignal.timeout(10_000)
      })
    } catch {
      throw new PlanUsageError('offline', 'Could not reach Anthropic')
    }
    if (res.status === 401) throw new PlanUsageError('expired', 'The Claude Code login expired; sign in again with claude')
    if (res.status === 429) {
      this.retryAt.set(folder, now + 5 * 60_000)
      if (cached) return cached.windows
      throw new PlanUsageError('rateLimited', 'Anthropic is rate limiting usage reads; retrying later')
    }
    if (!res.ok) throw new PlanUsageError('http', `Usage unavailable (HTTP ${res.status})`)
    let windows: PlanUsageWindow[]
    try {
      windows = parsePlanUsage(await res.json())
    } catch {
      throw new PlanUsageError('unreadable', 'Could not read the usage response')
    }
    this.cache.set(folder, { at: now, windows })
    return windows
  }

  /** The folder's `.credentials.json` wins; on macOS the Keychain item Claude Code names after the folder. */
  private async token(folder: string, defaultFolder: string): Promise<string | null> {
    const read = this.options.readCredentials ?? ((p: string) => readFile(p, 'utf8').catch(() => null))
    const file = await read(join(folder, '.credentials.json'))
    if (file !== null) return accessToken(file)
    if ((this.options.platform ?? process.platform) !== 'darwin') return null
    const resolved = await realpath(folder).catch(() => folder)
    const resolvedDefault = await realpath(defaultFolder).catch(() => defaultFolder)
    for (const service of keychainServices(folder, resolved, resolvedDefault)) {
      const blob = await (this.options.keychain ?? keychainPassword)(service)
      if (blob) return accessToken(blob)
    }
    return null
  }
}
