/**
 * How to start an agent process. On POSIX the command is spawned as is. On Windows the command is
 * resolved to an absolute path first, and only `.cmd`/`.bat` files (npm shims such as `npx`) go
 * through `cmd.exe`, with every argument quoted so no string reaches the shell unescaped.
 */
import { win32 } from 'node:path'

export interface SpawnPlan {
  command: string
  args: string[]
  /** Pass the arguments to the child untouched (Node would otherwise re-quote the cmd.exe line). */
  windowsVerbatimArguments: boolean
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
  if (platform !== 'win32' || !needsCmdShell(file)) return { command: file, args: [...args], windowsVerbatimArguments: false }
  const line = [file, ...args].map((part) => quoteCmdArgument(part)).join(' ')
  return { command: process.env['ComSpec'] ?? win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}
