/**
 * Kiro plan usage (credits used and left this billing cycle), asked from Kiro itself: `kiro-cli acp`
 * answers its own `/usage` command through the `_kiro.dev/commands/execute` extension
 * (`{ command: 'usage', args: {} }`, Kiro 2.33), the same call its chat makes. Kiro uses its own
 * sign-in for it; Workhub never reads Kiro's credentials. The answer (observed 2026-10-27):
 *
 *   { planName, billingCycleReset: 'YYYY-MM-DD', usageBreakdowns: [{ resourceType: 'CREDIT',
 *     used, limit, percentage, hasLimit, ... }], bonusCredits, ... }
 *
 * Kiro only runs a command inside a session, and every new session leaves a file under
 * `~/.kiro/sessions/cli`. So the reader creates one session, in a folder of Workhub's own, and
 * loads that same session on later reads (the id is kept in Workhub's state): one empty session
 * in Kiro's list, never one per read. Starting Kiro also starts its MCP servers, so reads are
 * spaced out (`minIntervalMs`).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { mkdir } from 'node:fs/promises'
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
  /** A folder of Workhub's own the usage session runs in (created when missing). */
  probeDir: string
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

/** One short `kiro-cli acp` run: initialize, open the usage session, run `/usage`, quit. */
async function askKiro(options: KiroPlanUsageOptions): Promise<{ data: unknown; sessionId: string }> {
  await mkdir(options.probeDir, { recursive: true })
  const env = { ...process.env }
  const path = options.path?.()
  if (path) env['PATH'] = path
  const child = (options.spawn ?? ((c, a, o) => nodeSpawn(c, a, { ...o, stdio: ['pipe', 'pipe', 'ignore'] })))(options.command?.() ?? 'kiro-cli', ['acp'], { cwd: options.probeDir, env })
  const pending = new Map<number, (m: RpcMessage) => void>()
  let nextId = 0
  let buffer = ''
  let failed: Error | null = null
  const failAll = (err: Error) => {
    failed = err
    for (const resolve of pending.values()) resolve({ error: { message: err.message } })
    pending.clear()
  }
  child.on('error', (err?: NodeJS.ErrnoException) => failAll(err?.code === 'ENOENT' ? new PlanUsageError('unreadable', 'kiro-cli was not found') : (err ?? new Error('kiro-cli failed'))))
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
          const loaded = await call('session/load', { sessionId, cwd: options.probeDir, mcpServers: [] })
          if (loaded.error) sessionId = null
        }
        if (!sessionId) {
          const created = await call('session/new', { cwd: options.probeDir, mcpServers: [] })
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
    setTimeout(() => child.kill(), 3_000).unref?.()
  }
}

/** Kiro credits used and left this billing cycle, for the agent usage service. */
export class KiroPlanUsageReader implements UsageProvider {
  readonly agentId = 'kiro'
  private last: { at: number; windows: PlanUsageWindow[] } | null = null
  private running: Promise<PlanUsageWindow[]> | null = null

  constructor(private readonly options: KiroPlanUsageOptions) {}

  /** Kiro has a single sign-in per machine: the folder argument is ignored. */
  async read(_configDir?: string): Promise<PlanUsageWindow[]> {
    const now = this.options.now?.() ?? Date.now()
    if (this.last && now - this.last.at < (this.options.minIntervalMs ?? 15 * 60_000)) return this.last.windows
    this.running ??= askKiro(this.options)
      .then(({ data, sessionId }) => {
        this.options.state.save(sessionId)
        const windows = parseKiroUsage(data)
        this.last = { at: this.options.now?.() ?? Date.now(), windows }
        return windows
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }
}
