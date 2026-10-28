import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Where the main process writes; `revealLogs` shows `main.log` in the file manager. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface RotatingLogOptions {
  /** A file grows up to this size before it is rotated (4 MB by default). */
  maxBytes?: number
  /** Rotated files kept next to the live one: `main.1.log` (newest) … `main.<keep>.log` (2 by default). */
  keep?: number
  /** Lines are written in batches this often; `error` lines are written at once. */
  flushMs?: number
  now?: () => Date
}

/**
 * A size-rotated log file (`<dir>/<name>.log`, then `<name>.1.log` … `<name>.<keep>.log`). Lines are
 * buffered and appended in small batches, so logging costs the event loop almost nothing; an error
 * line flushes right away so it survives a crash that follows. Writing never throws: a log that
 * cannot be written is dropped, the app goes on.
 */
export class RotatingLog implements Logger {
  readonly path: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly flushMs: number
  private size: number | null = null
  private buffer: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly dir: string,
    private readonly name = 'main',
    private readonly options: RotatingLogOptions = {}
  ) {
    this.path = join(dir, `${name}.log`)
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    this.keep = Math.max(1, options.keep ?? 2)
    this.flushMs = options.flushMs ?? 250
  }

  debug(message: string): void {
    this.write('debug', message)
  }
  info(message: string): void {
    this.write('info', message)
  }
  warn(message: string): void {
    this.write('warn', message)
  }
  error(message: string): void {
    this.write('error', message)
    this.flush()
  }

  write(level: LogLevel, message: string): void {
    const at = (this.options.now?.() ?? new Date()).toISOString()
    // One line per entry: a newline in a message would start a fake entry.
    this.buffer.push(`${at} ${level.toUpperCase().padEnd(5)} ${message.replace(/\r?\n/g, ' ⏎ ')}\n`)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.flushMs)
    this.timer.unref?.()
  }

  /** Writes what is buffered now (quitting, a crash). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.buffer.length) return
    const text = this.buffer.join('')
    this.buffer = []
    try {
      if (this.size === null) {
        mkdirSync(this.dir, { recursive: true })
        this.size = fileSize(this.path)
      }
      const bytes = Buffer.byteLength(text)
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
      appendFileSync(this.path, text, { mode: 0o600 })
      this.size += bytes
    } catch {
      // Logging must never take the app down; the next write tries again.
      this.size = null
    }
  }

  /** `main.log` → `main.1.log` → … → `main.<keep>.log`; the oldest falls off. */
  private rotate(): void {
    rmSync(this.rotated(this.keep), { force: true })
    for (let i = this.keep - 1; i >= 1; i--) moveIfThere(this.rotated(i), this.rotated(i + 1))
    moveIfThere(this.path, this.rotated(1))
    this.size = 0
  }

  rotated(n: number): string {
    return join(this.dir, `${this.name}.${n}.log`)
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function moveIfThere(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    // Not there yet (fewer rotations so far).
  }
}

/** A logger that writes nowhere, for tests and code that runs before the log is set up. */
export const NULL_LOGGER: Logger = { debug() {}, info() {}, warn() {}, error() {} }
