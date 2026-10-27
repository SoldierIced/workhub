/**
 * The PATH agents and terminals start with. An app started from the Finder, the Dock or a desktop
 * launcher inherits the launcher's bare PATH (launchd's /usr/bin:/bin:/usr/sbin:/sbin on macOS),
 * not the one the user's shell profile builds, so CLIs installed with Homebrew, nvm, mise, cargo...
 * are "not found". The login shell's PATH is read once at startup; Windows keeps its PATH as is.
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter as hostDelimiter } from 'node:path'
import { commonCliFolders } from './cli'

const MARK = '__WORKHUB_PATH__'

/** The shell command that prints PATH between markers, so profile banners around it are ignored. */
export const PRINT_PATH_COMMAND = `printf '${MARK}%s${MARK}' "$PATH"`

/** The PATH printed by `PRINT_PATH_COMMAND`, or null when the output has none. */
export function parsePrintedPath(stdout: string): string | null {
  const start = stdout.indexOf(MARK)
  if (start < 0) return null
  const end = stdout.indexOf(MARK, start + MARK.length)
  if (end < 0) return null
  const path = stdout.slice(start + MARK.length, end).trim()
  return path || null
}

export interface PathSources {
  platform: NodeJS.Platform
  /** The PATH the app process inherited. */
  inherited: string | undefined
  /** The login shell's PATH; null when it could not be read. */
  loginShell: string | null
  home?: string
}

/**
 * The login shell's PATH first (the user's own order), then whatever the app inherited, then the
 * usual CLI folders as a fallback; duplicates and empty entries dropped. Windows: the inherited
 * PATH unchanged.
 */
export function augmentedPath({ platform, inherited, loginShell, home = homedir() }: PathSources): string {
  if (platform === 'win32') return inherited ?? ''
  const delimiter = ':'
  const parts = [...(loginShell ?? '').split(delimiter), ...(inherited ?? '').split(delimiter), ...commonCliFolders(platform, home)]
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))].join(delimiter)
}

/** Prepends folders to a PATH (bundled tools that must win over anything installed). */
export function prependPath(path: string, folders: readonly string[], delimiter: string = hostDelimiter): string {
  return [...folders, ...path.split(delimiter)].filter(Boolean).join(delimiter)
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>

const runShell: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(shell, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    )
  })

/**
 * Reads the PATH of the user's login shell (`$SHELL -ilc`, interactive too, since many users set
 * PATH in .zshrc / .bashrc). Null on Windows, on a timeout or on any failure.
 */
export async function readLoginShellPath(options: { platform?: NodeJS.Platform; shell?: string; timeoutMs?: number; run?: ShellRunner } = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return null
  const shell = options.shell ?? process.env['SHELL'] ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  try {
    return parsePrintedPath(await (options.run ?? runShell)(shell, ['-ilc', PRINT_PATH_COMMAND], options.timeoutMs ?? 5000))
  } catch {
    return null
  }
}

/** The PATH key of an env (Windows spells it `Path`); a plain object copy is case-sensitive. */
export function pathKeyOf(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
}
