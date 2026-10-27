/**
 * Kiro plan usage (credits used and left this billing cycle), asked from Kiro itself: `kiro-cli acp`
 * answers its own `/usage` command through the `_kiro.dev/commands/execute` extension
 * (`{ command: 'usage', args: {} }`, Kiro 2.33), the same call its chat makes. Kiro uses its own
 * sign-in for it; Workhub never reads Kiro's credentials. The answer (observed 2026-10-27):
 *
 *   { planName, billingCycleReset: 'YYYY-MM-DD', usageBreakdowns: [{ resourceType: 'CREDIT',
 *     used, limit, percentage, hasLimit, ... }], bonusCredits, ... }
 *
 * Kiro only runs a command inside a session, and every session leaves files under
 * `<Kiro home>/sessions/cli`. So the reader starts Kiro with `KIRO_HOME` pointing at a folder of
 * Workhub's own (`<probeDir>/home`, checked with kiro-cli 2.33: the sign-in still comes from Kiro's
 * data folder, and the session files land there instead of `~/.kiro`). That home has no
 * `settings/mcp.json`, agents or hooks, so none of the user's MCP servers start either. One
 * session is created there and loaded again on later reads (its id is kept in Workhub's state).
 * Earlier versions left that session in `~/.kiro/sessions/cli`: its files are deleted once, only
 * when the stored id names a session whose cwd is the probe's own folder.
 *
 * Reads are spaced out (`minIntervalMs`, 15 min) and also after a failure; a forced read (the
 * user's refresh) skips the interval. kiro-cli missing is not an error: there is nothing to show.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlanUsageWindow, UsageProvider } from '@workhub/core'
import { PlanUsageError } from '../shared/plan-usage-error'
import { arr, num, obj, str } from '../shared/reader-utils'

/** The billing-cycle window of Kiro credits. */
export const KIRO_CREDITS_WINDOW = 'monthly'

/** A `YYYY-MM-DD` reset day as local midnight (epoch ms). */
function localDay(value: string | undefined): number | undefined {
  const m = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return undefined
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(at) ? at : undefined
}

/** The credits window of a `/usage` answer (its `data`); empty when Kiro reports no credit limit. */
export function parseKiroUsage(data: unknown): PlanUsageWindow[] {
  const d = obj(data)
  const breakdowns = arr(d?.['usageBreakdowns'])
    .map((b) => obj(b))
    .filter((b) => !!b)
  const credits = breakdowns.find((b) => str(b?.['resourceType']) === 'CREDIT') ?? breakdowns[0]
  if (!credits || credits['hasLimit'] === false) return []
  const used = num(credits['used'])
  const limit = num(credits['limit'])
  const reported = num(credits['percentage'])
  const percent = reported ?? (used !== undefined && limit ? (used / limit) * 100 : undefined)
  if (percent === undefined) return []
  const window: PlanUsageWindow = { window: KIRO_CREDITS_WINDOW, percent: Math.min(100, Math.max(0, percent)) }
  const resetsAt = localDay(str(d?.['billingCycleReset']))
  if (resetsAt !== undefined) window.resetsAt = resetsAt
  if (used !== undefined) window.used = used
  if (limit !== undefined) window.limit = limit
  return [window]
}

/** The small part of a child process the reader uses; injectable for tests. */
export interface KiroChild {
  stdin: Writable
  stdout: Readable
  on(event: 'error' | 'exit', cb: (err?: NodeJS.ErrnoException) => void): unknown
  kill(): unknown
}
export type KiroSpawn = (command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => KiroChild

export interface KiroPlanUsageOptions {
  /** `kiro-cli`, or the Kiro agent's command from the config. */
  command?: () => string
  /** A folder of Workhub's own: Kiro's home (`home/`) and the session's cwd (`work/`) go in it. */
  probeDir: string
  /** Where earlier versions left the probe session (`~/.kiro/sessions/cli`). */
  legacySessionsDir?: string
  /** Where the usage session's id is kept between reads. */
  state: { load(): string | null; save(sessionId: string): void }
  /** PATH for the child, so a GUI-launched app finds `kiro-cli`. */
  path?: () => string | undefined
  spawn?: KiroSpawn
  /** Reads closer together than this return the previous answer (default 15 min). */
  minIntervalMs?: number
  timeoutMs?: number
  now?: () => number
}

interface RpcMessage {
  id?: number | string
  method?: string
  result?: unknown
  error?: { message?: string }
}

/** kiro-cli is not installed (or not on the PATH). */
class KiroMissingError extends PlanUsageError {
  constructor() {
    super('unreadable', 'kiro-cli was not found')
  }
}

/** Kiro's home for the probe: its own session files and settings, none of the user's. */
export const kiroProbeHome = (probeDir: string): string => join(probeDir, 'home')
/** The probe session's cwd. */
export const kiroProbeCwd = (probeDir: string): string => join(probeDir, 'work')

/**
 * Deletes the probe session an earlier version left in Kiro's own list: only `<id>.json`,
 * `<id>.jsonl` and `<id>.lock`, and only when the session's cwd is the probe folder. Never throws.
 */
export async function removeLegacyProbeSession(sessionsDir: string, sessionId: string, probeDir: string): Promise<boolean> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return false
  try {
    const meta = obj(JSON.parse(await readFile(join(sessionsDir, `${sessionId}.json`), 'utf8')))
    const cwd = str(meta?.['cwd'])
    if (!cwd || (cwd !== probeDir && cwd !== kiroProbeCwd(probeDir))) return false
    for (const ext of ['.json', '.jsonl', '.lock']) await rm(join(sessionsDir, `${sessionId}${ext}`), { force: true })
    return true
  } catch {
    return false
  }
}

/** One short `kiro-cli acp` run: initialize, open the usage session, run `/usage`, quit. */
async function askKiro(options: KiroPlanUsageOptions, track: (child: KiroChild, running: boolean) => void): Promise<{ data: unknown; sessionId: string }> {
  const home = kiroProbeHome(options.probeDir)
  const cwd = kiroProbeCwd(options.probeDir)
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, KIRO_HOME: home }
  const path = options.path?.()
  if (path) env['PATH'] = path
  const child = (options.spawn ?? ((c, a, o) => nodeSpawn(c, a, { ...o, stdio: ['pipe', 'pipe', 'ignore'] })))(options.command?.() ?? 'kiro-cli', ['acp'], { cwd, env })
  track(child, true)
  const pending = new Map<number, (m: RpcMessage) => void>()
  let nextId = 0
  let buffer = ''
  let failed: Error | null = null
  const failAll = (err: Error) => {
    failed = err
    for (const resolve of pending.values()) resolve({ error: { message: err.message } })
    pending.clear()
  }
  child.on('error', (err?: NodeJS.ErrnoException) => failAll(err?.code === 'ENOENT' ? new KiroMissingError() : (err ?? new Error('kiro-cli failed'))))
  child.on('exit', () => failAll(new PlanUsageError('unreadable', 'kiro-cli exited before answering')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      let m: RpcMessage
      try {
        m = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (m.method !== undefined && m.id !== undefined) {
        // A request from Kiro (permission, file access): never granted from here.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } })}\n`)
      } else if (typeof m.id === 'number' && pending.has(m.id)) {
        pending.get(m.id)!(m)
        pending.delete(m.id)
      }
    }
  })
  const call = (method: string, params: unknown): Promise<RpcMessage> =>
    new Promise((resolve) => {
      if (failed) return resolve({ error: { message: failed.message } })
      const id = ++nextId
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const timeout = options.timeoutMs ?? 60_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PlanUsageError('offline', 'Kiro did not answer in time')), timeout)
  })
  try {
    return await Promise.race([
      (async () => {
        const init = await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
        if (init.error) throw failed ?? new PlanUsageError('unreadable', init.error.message ?? 'Kiro did not start')
        let sessionId = options.state.load()
        if (sessionId) {
          const loaded = await call('session/load', { sessionId, cwd, mcpServers: [] })
          if (loaded.error) sessionId = null
        }
        if (!sessionId) {
          const created = await call('session/new', { cwd, mcpServers: [] })
          sessionId = str(obj(created.result)?.['sessionId']) ?? null
          if (!sessionId) throw new PlanUsageError('unreadable', created.error?.message ?? 'Kiro did not open a session')
        }
        const r = await call('_kiro.dev/commands/execute', { sessionId, command: { command: 'usage', args: {} } })
        const result = obj(r.result)
        if (r.error || result?.['success'] === false) throw new PlanUsageError('unreadable', r.error?.message ?? str(result?.['message']) ?? 'Kiro did not report its usage')
        return { data: result?.['data'], sessionId }
      })(),
      timedOut
    ])
  } finally {
    clearTimeout(timer)
    // Closing stdin lets Kiro end on its own (and release its session lock); kill it if it lingers.
    child.stdin.end()
    setTimeout(() => {
      child.kill()
      track(child, false)
    }, 3_000).unref?.()
  }
}

/** Kiro credits used and left this billing cycle, for the agent usage service. */
export class KiroPlanUsageReader implements UsageProvider {
  readonly agentId = 'kiro'
  private last: { at: number; windows: PlanUsageWindow[]; error?: unknown } | null = null
  private running: Promise<PlanUsageWindow[]> | null = null
  private child: KiroChild | null = null
  private cleaned = false

  constructor(private readonly options: KiroPlanUsageOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * Kiro has a single sign-in per machine: the folder argument is ignored. Within the interval the
   * previous answer (or failure) is returned; `force` (the user's refresh) reads again.
   */
  async read(_configDir?: string, options: { force?: boolean } = {}): Promise<PlanUsageWindow[]> {
    const last = this.last
    if (!options.force && last && this.now() - last.at < (this.options.minIntervalMs ?? 15 * 60_000)) {
      if (last.error) throw last.error
      return last.windows
    }
    this.running ??= this.ask().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Stops a read in progress (the app is quitting). */
  dispose(): void {
    this.child?.kill()
    this.child = null
  }

  private async ask(): Promise<PlanUsageWindow[]> {
    if (!this.cleaned) {
      this.cleaned = true
      const stored = this.options.state.load()
      const legacy = this.options.legacySessionsDir ?? join(homedir(), '.kiro', 'sessions', 'cli')
      if (stored) await removeLegacyProbeSession(legacy, stored, this.options.probeDir)
    }
    try {
      const { data, sessionId } = await askKiro(this.options, (child, running) => {
        if (running) this.child = child
        else if (this.child === child) this.child = null
      })
      this.options.state.save(sessionId)
      const windows = parseKiroUsage(data)
      this.last = { at: this.now(), windows }
      return windows
    } catch (err) {
      // kiro-cli is not installed: nothing to show, and no error row.
      if (err instanceof KiroMissingError) {
        this.last = { at: this.now(), windows: [] }
        return []
      }
      this.last = { at: this.now(), windows: [], error: err }
      throw err
    }
  }
}
