import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseReport, rendererReporter } from '../src/main/diagnostics'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { describeError, redact, timeIpc } from '../src/main/ipc-timing'
import { Activity, LagMonitor } from '../src/main/lag-monitor'
import { RotatingLog, type Logger } from '../src/main/log-file'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-log-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A logger that keeps its lines, prefixed by level. */
function memoryLog(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, debug: (m) => void lines.push(`debug ${m}`), info: (m) => void lines.push(`info ${m}`), warn: (m) => void lines.push(`warn ${m}`), error: (m) => void lines.push(`error ${m}`) }
}

describe('RotatingLog', () => {
  const at = () => new Date('2026-10-28T12:00:00.000Z')

  it('writes timestamped lines with their level, one line per entry', () => {
    const dir = tempDir()
    const log = new RotatingLog(join(dir, 'logs'), 'main', { now: at })
    log.info('start')
    log.warn('two\nlines')
    log.flush()
    expect(readFileSync(join(dir, 'logs', 'main.log'), 'utf8')).toBe('2026-10-28T12:00:00.000Z INFO  start\n2026-10-28T12:00:00.000Z WARN  two ⏎ lines\n')
  })

  it('writes an error at once, without waiting for the batch', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, 'main', { now: at, flushMs: 60_000 })
    log.info('queued')
    log.error('boom')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('ERROR boom')
  })

  it('rotates past the size limit and keeps only the configured number of old files', () => {
    const dir = tempDir()
    const log = new RotatingLog(dir, 'main', { maxBytes: 100, keep: 2, now: at })
    // Each line is about 80 bytes: every flush past the first fills a file of its own.
    for (let i = 0; i < 6; i++) {
      log.info(`entry ${i} ${'x'.repeat(40)}`)
      log.flush()
    }
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('entry 5')
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toContain('entry 4')
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toContain('entry 3')
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).length).toBeLessThanOrEqual(100)
  })

  it('continues the size of a log left by an earlier run', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'main.log'), 'y'.repeat(90))
    const log = new RotatingLog(dir, 'main', { maxBytes: 100, now: at })
    log.info('next')
    log.flush()
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toBe('y'.repeat(90))
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('next')
  })

  it('never throws when the folder cannot be written', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'file'), '')
    const log = new RotatingLog(join(dir, 'file', 'logs'))
    expect(() => log.error('lost')).not.toThrow()
  })
})

describe('LagMonitor', () => {
  it('reports a tick late by the threshold or more, with the work that ran then', () => {
    const activity = new Activity(() => 0)
    const lags: { blockedMs: number; during: string[] }[] = []
    const monitor = new LagMonitor({ thresholdMs: 200, intervalMs: 100, activity, onLag: (l) => void lags.push(l) })
    expect(monitor.check(0)).toBeNull()
    expect(monitor.check(100)).toBe(0)
    // 150 ms late: under the threshold.
    expect(monitor.check(350)).toBe(150)
    expect(lags).toEqual([])
    // 200 ms late: reported.
    expect(monitor.check(650)).toBe(200)
    expect(lags).toEqual([{ blockedMs: 200, during: [] }])
  })

  it('names the spans that overlapped the stall, also ones that already ended', () => {
    let now = 0
    const activity = new Activity(() => now)
    const endScan = activity.begin('token spend scan')
    now = 400
    endScan()
    activity.begin('ipc history:list')
    now = 2_000
    // Before the stall window: not named.
    expect(activity.during(1_000, 2_000)).toEqual(['ipc history:list'])
    expect(activity.during(300, 2_000)).toEqual(['ipc history:list', 'token spend scan'])
  })

  it('forgets ended spans after a while', () => {
    let now = 0
    const activity = new Activity(() => now, 1_000)
    activity.begin('old')()
    now = 5_000
    expect(activity.during(0, 5_000)).toEqual([])
  })
})

describe('timeIpc', () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  function fakeIpc() {
    const handlers = new Map<string, Listener>()
    const listeners = new Map<string, Listener>()
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => void handlers.set(channel, listener as Listener),
      on: (channel, listener) => void listeners.set(channel, listener as Listener)
    }
    return { ipc, handlers, listeners }
  }

  it('logs a slow handler by channel with its total and blocking time, never its payload or result', async () => {
    const { ipc, handlers } = fakeIpc()
    const log = memoryLog()
    let clock = 0
    const timed = timeIpc(ipc, { log, slowMs: 300, now: () => clock })
    timed.handle('sessions:prompt', async (_e, text) => {
      clock += 50 // blocks before awaiting
      await Promise.resolve()
      clock += 400
      return `answer to ${String(text)}`
    })
    timed.handle('config:get', () => 'fast')
    expect(await handlers.get('sessions:prompt')!({}, 'my secret prompt xoxb-123-456')).toBe('answer to my secret prompt xoxb-123-456')
    expect(await handlers.get('config:get')!({})).toBe('fast')
    expect(log.lines).toEqual(['warn ipc slow sessions:prompt total=450ms sync=50ms'])
    expect(log.lines.join('\n')).not.toMatch(/secret|answer|xoxb/)
  })

  it('logs a failing handler with its error, redacted, and still rejects', async () => {
    const { ipc, handlers } = fakeIpc()
    const log = memoryLog()
    timeIpc(ipc, { log }).handle('tickets:list', async () => {
      throw new Error('401 for token ghp_abcdefghijklmnopqrstuvwxyz123456')
    })
    await expect(handlers.get('tickets:list')!({})).rejects.toThrow(/401/)
    expect(log.lines).toEqual(['error ipc error tickets:list: Error: 401 for token [redacted]'])
  })

  it('times one-way messages too and names the running channel for the lag monitor', () => {
    const { ipc, listeners } = fakeIpc()
    const log = memoryLog()
    let clock = 0
    const activity = new Activity(() => clock)
    const seen: string[][] = []
    timeIpc(ipc, { log, activity, slowMs: 300, now: () => clock }).on('sessions:write', () => {
      clock += 500
      seen.push(activity.during(0, clock))
    })
    listeners.get('sessions:write')!({}, 's1', 'typed text')
    expect(seen).toEqual([['ipc sessions:write']])
    expect(log.lines).toEqual(['warn ipc slow sessions:write total=500ms sync=500ms'])
  })
})

describe('redact', () => {
  it('replaces anything that looks like a credential and cuts long text', () => {
    expect(redact('slack xoxb-1234-abcd failed')).toBe('slack [redacted] failed')
    expect(redact('Authorization: Bearer abc.def-ghi_jkl')).toBe('Authorization: [redacted]')
    expect(redact('key sk-ant-api03-abcdefghij')).toBe('key [redacted]')
    expect(redact(`blob ${'A'.repeat(40)}`)).toBe('blob [redacted]')
    expect(redact('x'.repeat(10), 4)).toBe('xxxx…')
    expect(redact('ENOENT: no such file')).toBe('ENOENT: no such file')
  })

  it('describes non-errors without their content', () => {
    expect(describeError({ prompt: 'secret' })).toBe('non-error thrown')
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad')
  })
})

describe('renderer reports', () => {
  it('accepts long task summaries and errors, nothing else', () => {
    expect(parseReport({ kind: 'longtask', count: 3, maxMs: 250.4, totalMs: 700, text: 'ignored' })).toEqual({ kind: 'longtask', count: 3, maxMs: 250, totalMs: 700 })
    expect(parseReport({ kind: 'error', message: 'boom', source: 'index.js:1:2' })).toEqual({ kind: 'error', message: 'boom', source: 'index.js:1:2' })
    expect(parseReport({ kind: 'longtask', count: 0, maxMs: 1, totalMs: 1 })).toBeNull()
    expect(parseReport({ kind: 'prompt', message: 'hi' })).toBeNull()
    expect(parseReport('error')).toBeNull()
  })

  it('writes at most 20 reports per kind and minute, then says how many were dropped', () => {
    const log = memoryLog()
    let clock = 0
    const report = rendererReporter(log, () => clock)
    for (let i = 0; i < 25; i++) report('main', { kind: 'error', message: `e${i}` })
    report('main', { kind: 'longtask', count: 1, maxMs: 300, totalMs: 300 })
    expect(log.lines.filter((l) => l.includes(' error e'))).toHaveLength(20)
    expect(log.lines).toContain('warn renderer main long tasks count=1 max=300ms total=300ms')
    clock = 60_000
    report('main', { kind: 'error', message: 'next minute' })
    expect(log.lines).toContain('warn renderer error: 5 more reports dropped')
    expect(log.lines.at(-1)).toBe('error renderer main error next minute')
  })
})
