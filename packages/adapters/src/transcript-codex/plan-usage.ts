/**
 * Codex plan usage per account, ported from usageChecker (`providers/_codex.py`): the account's own
 * Codex ChatGPT sign-in (`<codex home>/auth.json`) is sent to ChatGPT's undocumented
 * `backend-api/codex/usage` endpoint, which reports the percent used and the reset time of the
 * 5 h (`primary_window`) and weekly (`secondary_window`) windows. Only called while the user has
 * Codex usage on in Settings (off by default).
 *
 * Differences from usageChecker, on purpose:
 * - the token is read, used for this one request and never stored; an expired sign-in is
 *   reported, never refreshed (usageChecker rewrites `auth.json` with a refreshed token; Workhub
 *   does not write into an agent's config folder);
 * - without a usable sign-in, or when the endpoint fails, the newest `rate_limits` Codex wrote in
 *   the account's session files are used instead (no network), marked with when they were written.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PlanUsageWindow, UsageProvider } from '@workhub/core'
import { PlanUsageError } from '../shared/plan-usage-error'
import { num, obj, parseLine, str, toMillis } from '../shared/reader-utils'
import { defaultCodexHome, readRollout, rolloutFiles } from './files'
import { rateWindow, windowLabel } from './parser'

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/usage'

/** One window of the usage response: `used_percent` and `reset_at` (unix seconds). */
function apiWindow(raw: unknown, fallbackLabel: string): PlanUsageWindow | undefined {
  const w = obj(raw)
  const percent = num(w?.['used_percent'])
  if (!w || percent === undefined) return undefined
  const seconds = num(w['limit_window_seconds'])
  const out: PlanUsageWindow = { window: seconds !== undefined ? windowLabel(Math.round(seconds / 60)) : fallbackLabel, percent: Math.min(100, Math.max(0, percent)) }
  const resetsAt = toMillis(w['reset_at'])
  if (resetsAt !== undefined) out.resetsAt = resetsAt
  return out
}

/** The windows of a Codex usage response: `primary_window` is the 5 h window, `secondary_window` the weekly one. */
export function parseCodexUsage(body: unknown): PlanUsageWindow[] {
  const limits = obj(obj(body)?.['rate_limit'])
  return [apiWindow(limits?.['primary_window'], '5h'), apiWindow(limits?.['secondary_window'], 'weekly')].filter((w): w is PlanUsageWindow => !!w)
}

/** The access token and ChatGPT account id of an `auth.json`; null without a ChatGPT sign-in (an API key login has none). */
export function codexCredentials(authJson: string): { accessToken: string; accountId?: string } | null {
  try {
    const tokens = obj(obj(JSON.parse(authJson))?.['tokens'])
    const accessToken = str(tokens?.['access_token'])
    if (!accessToken) return null
    const accountId = str(tokens?.['account_id'])
    return accountId ? { accessToken, accountId } : { accessToken }
  } catch {
    return null
  }
}

/** The last `rate_limits` of a rollout's text, with the time they were written. */
export function lastRateLimits(text: string): PlanUsageWindow[] {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('rate_limits')) continue
    const entry = parseLine(line)
    const payload = obj(entry?.['payload'])
    const limits = obj(payload?.['rate_limits'])
    if (entry?.['type'] !== 'event_msg' || payload?.['type'] !== 'token_count' || !limits) continue
    const at = toMillis(entry['timestamp'])
    const windows = [rateWindow(limits['primary'], at), rateWindow(limits['secondary'], at)].filter((w): w is PlanUsageWindow => !!w)
    if (!windows.length) continue
    return windows.map((w) => ({ ...w, percent: Math.min(100, Math.max(0, w.percent)), ...(at !== undefined ? { asOf: at } : {}) }))
  }
  return []
}

export interface CodexPlanUsageOptions {
  fetch?: typeof fetch
  /** Reads a file; injectable for tests. */
  readFile?: (path: string) => Promise<string | null>
  /** The Codex home of the default account: `CODEX_HOME`, else `~/.codex`. */
  defaultHome?: string
  /** Newest rollouts looked at for the session-file fallback. */
  maxRollouts?: number
  userAgent?: string
  now?: () => number
}

export class CodexPlanUsageReader implements UsageProvider {
  readonly agentId = 'codex'
  private readonly cache = new Map<string, { at: number; windows: PlanUsageWindow[] }>()
  private readonly retryAt = new Map<string, number>()

  constructor(private readonly options: CodexPlanUsageOptions = {}) {}

  async read(configDir: string | undefined): Promise<PlanUsageWindow[]> {
    const now = this.options.now?.() ?? Date.now()
    const home = resolve(configDir || this.options.defaultHome || defaultCodexHome())
    const cached = this.cache.get(home)
    const retry = this.retryAt.get(home) ?? 0
    if (cached && (now - cached.at < 45_000 || now < retry)) return cached.windows

    const read = this.options.readFile ?? ((p: string) => readFile(p, 'utf8').catch(() => null))
    const auth = await read(join(home, 'auth.json'))
    const credentials = auth === null ? null : codexCredentials(auth)
    let failure: PlanUsageError | null = credentials ? null : new PlanUsageError('noLogin', 'No Codex ChatGPT sign-in for this folder')
    if (credentials && now >= retry) {
      try {
        const windows = await this.fetchUsage(credentials, home, now)
        if (windows.length) {
          this.cache.set(home, { at: now, windows })
          return windows
        }
        failure = new PlanUsageError('unreadable', 'The Codex usage response had no windows')
      } catch (err) {
        failure = err instanceof PlanUsageError ? err : new PlanUsageError('unreadable', 'Could not read the Codex usage response')
      }
    } else if (credentials) {
      failure = new PlanUsageError('rateLimited', 'ChatGPT is rate limiting usage reads; retrying later')
    }
    const local = await this.fromSessions(home)
    if (local.length) {
      this.cache.set(home, { at: now, windows: local })
      return local
    }
    throw failure ?? new PlanUsageError('noLogin', 'No Codex usage found for this folder')
  }

  private async fetchUsage(credentials: { accessToken: string; accountId?: string }, home: string, now: number): Promise<PlanUsageWindow[]> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': this.options.userAgent ?? 'codex-cli'
    }
    if (credentials.accountId) headers['chatgpt-account-id'] = credentials.accountId
    let res: Response
    try {
      res = await (this.options.fetch ?? fetch)(ENDPOINT, { headers, signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new PlanUsageError('offline', 'Could not reach ChatGPT')
    }
    if (res.status === 401 || res.status === 403) throw new PlanUsageError('expired', 'The Codex sign-in expired; sign in again with codex')
    if (res.status === 429) {
      this.retryAt.set(home, now + 5 * 60_000)
      throw new PlanUsageError('rateLimited', 'ChatGPT is rate limiting usage reads; retrying later')
    }
    if (!res.ok) throw new PlanUsageError('http', `Codex usage unavailable (HTTP ${res.status})`)
    try {
      return parseCodexUsage(await res.json())
    } catch {
      throw new PlanUsageError('unreadable', 'Could not read the Codex usage response')
    }
  }

  /** The newest rate limits in the account's session files, if any of the newest rollouts has them. */
  private async fromSessions(home: string): Promise<PlanUsageWindow[]> {
    let seen = 0
    for await (const path of rolloutFiles(join(home, 'sessions'))) {
      const windows = lastRateLimits(await readRollout(path))
      if (windows.length) return windows
      if (++seen >= (this.options.maxRollouts ?? 5)) break
    }
    return []
  }
}
