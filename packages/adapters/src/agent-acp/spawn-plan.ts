/**
 * How to start an agent process. On POSIX the command is spawned as is. On Windows the command is
 * resolved to an absolute path first, and only `.cmd`/`.bat` files (npm shims such as `npx`) go
 * through `cmd.exe`, with every argument quoted so no string reaches the shell unescaped.
 *
 * On POSIX the agent starts in its own process group (`detached`), so stopping it can signal the
 * whole group: agents started through `npx` or a shell script leave their real process as a
 * grandchild. Windows ends the tree with `taskkill /T` instead (a detached child there would get a
 * console window of its own).
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

export interface SpawnPlan {
  command: string
  args: string[]
  /** Pass the arguments to the child untouched (Node would otherwise re-quote the cmd.exe line). */
  windowsVerbatimArguments: boolean
  /** Start the child as the leader of a new process group (POSIX only). */
  detached: boolean
}

/** True for the files Windows can only run through a command interpreter. */
export function needsCmdShell(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file)
}

/**
 * Quotes one argument for cmd.exe: C runtime quoting for the program that receives it, then
 * caret-escapes every cmd metacharacter. `.cmd` shims forward `%*` and so are parsed a second
 * time, which is why the caret escaping is applied twice.
 */
export function quoteCmdArgument(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  out = `"${out}"`
  const caret = (s: string): string => s.replace(/[()%!^"`<>&|;, \[\]]/g, '^$&')
  return caret(caret(out))
}

/** The spawn call for `file` (already resolved to a full path on Windows) and its arguments. */
export function planSpawn(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  const detached = platform !== 'win32'
  if (platform !== 'win32' || !needsCmdShell(file)) return { command: file, args: [...args], windowsVerbatimArguments: false, detached }
  const line = [file, ...args].map((part) => quoteCmdArgument(part)).join(' ')
  return { command: process.env['ComSpec'] ?? win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true, detached }
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  /** `process.kill`, faked in tests. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Starts `taskkill` on Windows, faked in tests. */
  spawn?: (command: string, args: string[]) => Pick<ChildProcess, 'once'>
}

/**
 * Signals an agent and everything it started. POSIX: the process group the agent leads (see
 * `planSpawn`), falling back to the agent alone when that fails (it was not started detached, or
 * the group is gone). Windows: `taskkill /T /F`, which has no gentle form, falling back to
 * `child.kill` when taskkill cannot run.
 */
export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals, deps: KillTreeDeps = {}): void {
  const pid = child.pid
  if (pid === undefined) return
  const fallback = () => {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const run = deps.spawn ?? ((command: string, args: string[]) => nodeSpawn(command, args, { stdio: 'ignore', windowsHide: true }))
    try {
      run('taskkill', ['/T', '/F', '/PID', String(pid)]).once('error', fallback)
    } catch {
      fallback()
    }
    return
  }
  try {
    ;(deps.kill ?? process.kill)(-pid, signal)
  } catch {
    fallback()
  }
}
