import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, posix } from 'node:path'

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface CliOptions {
  timeoutMs?: number
}

/** Runs a command without a shell. Rejects with `CliNotFoundError` when the program is not installed. */
export type CliRunner = (command: string, args: string[], options?: CliOptions) => Promise<CliResult>

export class CliNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`${command}: command not found`)
    this.name = 'CliNotFoundError'
  }
}

/**
 * Folders a GUI app usually misses in its PATH but where users install CLIs (a macOS app does not
 * inherit the login shell's PATH). Added after the inherited PATH, so a user's own choice still wins.
 */
export function commonCliFolders(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  // POSIX layouts: joined with `/` even when asked about them from another platform.
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local', 'bin')]
  if (platform === 'linux') return ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', posix.join(home, '.local', 'bin')]
  return []
}

export function createCliRunner(extraPath: string[] = commonCliFolders()): CliRunner {
  return (command, args, options) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env }
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
      env[key] = [env[key] ?? '', ...extraPath].filter(Boolean).join(delimiter)
      env['GH_PROMPT_DISABLED'] = '1'
      env['GLAB_NO_PROMPT'] = '1'
      env['NO_COLOR'] = '1'
      execFile(command, args, { env, maxBuffer: 128 * 1024 * 1024, timeout: options?.timeoutMs ?? 60_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new CliNotFoundError(command))
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
}

/**
 * Parses `--paginate` output, where every page is its own top-level JSON array (`[..][..]`) or
 * object, back to back. Splits on bracket depth outside strings, so a body containing `][` is safe.
 */
export function parseJsonPages(stdout: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const value: unknown = JSON.parse(stdout.slice(start, i + 1))
        if (Array.isArray(value)) out.push(...value)
        else out.push(value)
        start = -1
      }
    }
  }
  return out
}

/** The text of a failed command, for the user: stderr, else stdout, else a fallback. */
export function failureText(result: CliResult, fallback: string): string {
  return (result.stderr.trim() || result.stdout.trim() || fallback).slice(0, 2000)
}
