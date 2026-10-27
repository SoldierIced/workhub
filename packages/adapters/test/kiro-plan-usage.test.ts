import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { KiroPlanUsageReader, kiroProbeCwd, kiroProbeHome, parseKiroUsage, removeLegacyProbeSession, type KiroChild, type KiroSpawn } from '../src/transcript-kiro/plan-usage'

/** The `data` of Kiro 2.33's `/usage` answer, as observed (numbers changed). */
const USAGE = {
  planName: 'KIRO POWER',
  billingCycleReset: '2026-11-01',
  overagesEnabled: false,
  usageBreakdowns: [{ resourceType: 'CREDIT', displayName: 'Credits', used: 2500, limit: 10000, percentage: 25, currentOverages: 0, currency: 'USD', hasLimit: true }],
  bonusCredits: []
}

describe('parseKiroUsage', () => {
  it('reads the credits window with used, limit, the local reset day and the plan name', () => {
    expect(parseKiroUsage(USAGE)).toEqual([{ window: 'monthly', percent: 25, used: 2500, limit: 10000, resetsAt: new Date(2026, 10, 1).getTime(), plan: 'KIRO POWER' }])
  })

  it('computes the percent when Kiro leaves it out, and reports nothing without a limit', () => {
    const noPercent = { usageBreakdowns: [{ resourceType: 'CREDIT', used: 50, limit: 200, hasLimit: true }] }
    expect(parseKiroUsage(noPercent)[0]).toMatchObject({ percent: 25, used: 50, limit: 200 })
    expect(parseKiroUsage({ usageBreakdowns: [{ resourceType: 'CREDIT', used: 5, hasLimit: false }] })).toEqual([])
    expect(parseKiroUsage(null)).toEqual([])
  })
})

/** A fake `kiro-cli acp`: answers JSON-RPC lines; `loadFails` makes `session/load` fail. */
function fakeKiro(log: string[], options: { loadFails?: boolean; seen?: { cwd: string; home?: string }[] } = {}): KiroSpawn {
  return (_command, _args, spawnOptions) => {
    options.seen?.push({ cwd: spawnOptions.cwd, home: spawnOptions.env?.['KIRO_HOME'] })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const events = new EventEmitter()
    let buffer = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      buffer += chunk
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, i)) as { id: number; method?: string; params?: { sessionId?: string } }
        buffer = buffer.slice(i + 1)
        if (!m.method) continue
        log.push(m.method)
        const reply = (body: object) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, ...body })}\n`)
        if (m.method === 'initialize') {
          // Kiro may ask the client something first: the reader must refuse, not hang.
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {} })}\n`)
          reply({ result: { protocolVersion: 1 } })
        } else if (m.method === 'session/new') reply({ result: { sessionId: 'probe-1' } })
        else if (m.method === 'session/load') reply(options.loadFails ? { error: { code: -32602, message: 'gone' } } : { result: {} })
        else if (m.method === '_kiro.dev/commands/execute') reply({ result: { success: true, message: 'Estimated Usage', data: USAGE } })
      }
    })
    stdin.on('finish', () => events.emit('exit'))
    const child: KiroChild = { stdin, stdout, on: (event, cb) => events.on(event, cb), kill: () => undefined }
    return child
  }
}

describe('KiroPlanUsageReader', () => {
  const probeDir = () => join(mkdtempSync(join(tmpdir(), 'wh-kiro-')), 'kiro-usage')

  it('opens one session the first time, reuses it after, and keeps answers within the interval', async () => {
    const log: string[] = []
    let stored: string | null = null
    let now = 0
    const reader = new KiroPlanUsageReader({
      probeDir: probeDir(),
      state: { load: () => stored, save: (id) => (stored = id) },
      spawn: fakeKiro(log),
      minIntervalMs: 1000,
      now: () => now
    })
    expect(await reader.read()).toMatchObject([{ window: 'monthly', percent: 25 }])
    expect(stored).toBe('probe-1')
    expect(log).toEqual(['initialize', 'session/new', '_kiro.dev/commands/execute'])
    now = 500
    await reader.read()
    expect(log).toHaveLength(3)
    now = 2000
    await reader.read()
    expect(log.slice(3)).toEqual(['initialize', 'session/load', '_kiro.dev/commands/execute'])
  })

  it('opens a new session when the stored one cannot be loaded', async () => {
    const log: string[] = []
    let stored: string | null = 'old'
    const reader = new KiroPlanUsageReader({ probeDir: probeDir(), state: { load: () => stored, save: (id) => (stored = id) }, spawn: fakeKiro(log, { loadFails: true }) })
    await reader.read()
    expect(log).toEqual(['initialize', 'session/load', 'session/new', '_kiro.dev/commands/execute'])
    expect(stored).toBe('probe-1')
  })


  it("runs Kiro in a home of Workhub's own, so its session and the user's MCP servers stay out", async () => {
    const seen: { cwd: string; home?: string }[] = []
    const dir = probeDir()
    const reader = new KiroPlanUsageReader({ probeDir: dir, legacySessionsDir: join(dir, 'none'), state: { load: () => null, save: () => undefined }, spawn: fakeKiro([], { seen }) })
    await reader.read()
    expect(seen).toEqual([{ cwd: kiroProbeCwd(dir), home: kiroProbeHome(dir) }])
    expect(existsSync(kiroProbeHome(dir))).toBe(true)
  })

  it('remembers a failure for the interval, and a forced read tries again', async () => {
    let calls = 0
    let now = 0
    const spawn: KiroSpawn = (...args) => {
      calls++
      if (calls === 1) {
        const events = new EventEmitter()
        setTimeout(() => events.emit('exit'))
        return { stdin: new PassThrough(), stdout: new PassThrough(), on: (e, cb) => events.on(e, cb), kill: () => undefined }
      }
      return fakeKiro([])(...args)
    }
    const reader = new KiroPlanUsageReader({ probeDir: probeDir(), state: { load: () => null, save: () => undefined }, spawn, now: () => now })
    await expect(reader.read()).rejects.toThrow('exited before answering')
    now = 60_000
    await expect(reader.read()).rejects.toThrow('exited before answering')
    expect(calls).toBe(1)
    expect(await reader.read(undefined, { force: true })).toHaveLength(1)
    expect(calls).toBe(2)
  })

  it('shows nothing, without an error, when kiro-cli is not installed', async () => {
    const spawn: KiroSpawn = () => {
      const events = new EventEmitter()
      setTimeout(() => events.emit('error', Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' })))
      return { stdin: new PassThrough(), stdout: new PassThrough(), on: (e, cb) => events.on(e, cb), kill: () => undefined }
    }
    const reader = new KiroPlanUsageReader({ probeDir: probeDir(), state: { load: () => null, save: () => undefined }, spawn })
    expect(await reader.read()).toEqual([])
  })

  it("deletes the probe session an earlier version left in Kiro's list, and nothing else", async () => {
    const dir = probeDir()
    const sessions = join(dir, 'legacy')
    mkdirSync(sessions, { recursive: true })
    for (const ext of ['.json', '.jsonl', '.lock']) writeFileSync(join(sessions, `probe-old${ext}`), ext === '.json' ? JSON.stringify({ cwd: dir }) : '')
    writeFileSync(join(sessions, 'user-1.json'), JSON.stringify({ cwd: '/Users/me/repo' }))
    expect(await removeLegacyProbeSession(sessions, 'user-1', dir)).toBe(false)
    expect(await removeLegacyProbeSession(sessions, '../x', dir)).toBe(false)
    const log: string[] = []
    const reader = new KiroPlanUsageReader({ probeDir: dir, legacySessionsDir: sessions, state: { load: () => 'probe-old', save: () => undefined }, spawn: fakeKiro(log, { loadFails: true }) })
    await reader.read()
    expect(['.json', '.jsonl', '.lock'].map((ext) => existsSync(join(sessions, `probe-old${ext}`)))).toEqual([false, false, false])
    expect(existsSync(join(sessions, 'user-1.json'))).toBe(true)
  })
})
