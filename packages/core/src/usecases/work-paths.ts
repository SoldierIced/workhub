/**
 * Where a session worked, from its tool calls (Workhub 1's rule): the folders its edits and writes
 * touched, the folders its `cd` and `git -C` commands went to, and the cwd its commands ran in.
 * Reading a file does not count. Shared by the token spend per folder (which follows the last
 * folder) and the monitor's "Local changes" (which lists the repositories behind all of them).
 * Pure: the caller passes the home folder.
 */

/** Joins and normalizes a POSIX path: `.` and `..` resolved, repeated and trailing `/` dropped. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const parentOf = (path: string) => normalize(`${path}/..`)

/** Shell syntax a path argument must not hold to be taken literally (variables, globs, substitutions, printf formats). */
const NOT_LITERAL = /[$`*?{}%<>()]/

/**
 * A path a command or tool names, as an absolute path: `~/x` from the home folder, a relative one
 * from `cwd`. Undefined when it is not a literal path (`$dir`, `-`, a format string) or cannot be placed.
 */
export function resolveWorkPath(raw: string, cwd: string | undefined, home: string): string | undefined {
  const p = raw.trim()
  if (!p || NOT_LITERAL.test(p) || p.startsWith('-')) return undefined
  if (p === '~' || p.startsWith('~/')) return normalize(`${home}/${p.slice(1)}`)
  if (p.startsWith('~')) return undefined
  if (p.startsWith('/')) return normalize(p)
  return cwd?.startsWith('/') ? normalize(`${cwd}/${p}`) : undefined
}

const CD = /\b(cd|git\s+-C)\s+(["']?)([^\s"';&|]+)\2/g

/**
 * Every folder a shell command moves to with `cd` or points git at with `git -C`, in order. A
 * relative path counts from where the command's earlier `cd`s left it; a quoted `~` is not the home.
 */
export function commandWorkPaths(command: string, cwd: string | undefined, home: string): string[] {
  const out: string[] = []
  let here = cwd
  for (const m of command.matchAll(CD)) {
    const raw = m[3]!
    if (m[2] && raw.startsWith('~')) continue
    const path = resolveWorkPath(raw, here, home)
    if (!path) continue
    out.push(path)
    if (m[1] === 'cd') here = path
  }
  return out
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/**
 * The folders one Claude Code tool call worked in, in order: an edited or written file's folder,
 * or each `cd`/`git -C` target of a Bash command. Empty for reads and every other tool.
 */
export function toolWorkPaths(tool: string | undefined, input: Readonly<Record<string, unknown>>, cwd: string | undefined, home: string): string[] {
  if (tool && EDIT_TOOLS.has(tool)) {
    const file = typeof input['file_path'] === 'string' ? input['file_path'] : typeof input['notebook_path'] === 'string' ? input['notebook_path'] : undefined
    const path = file ? resolveWorkPath(file, cwd, home) : undefined
    return path ? [parentOf(path)] : []
  }
  if (tool === 'Bash' && typeof input['command'] === 'string') return commandWorkPaths(input['command'], cwd, home)
  return []
}

/** How many distinct folders a session keeps; the oldest ones go first. */
export const WORK_PATH_LIMIT = 200

/**
 * Adds a folder to the list of the ones a session worked in, oldest first: a folder seen again
 * moves to the end, so the most recent work is last.
 */
export function noteWorkPath(paths: string[], path: string | undefined, limit = WORK_PATH_LIMIT): void {
  if (!path) return
  const i = paths.indexOf(path)
  if (i >= 0) {
    if (i === paths.length - 1) return
    paths.splice(i, 1)
  }
  paths.push(path)
  if (paths.length > limit) paths.splice(0, paths.length - limit)
}
