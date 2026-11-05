/**
 * Where a session worked, from its tool calls (Workhub 1's rule): the folders its edits and writes
 * touched, the folders its `cd` and `git -C` commands went to, and the cwd its commands ran in.
 * Reading a file does not count. The token spend per folder follows the last of them.
 *
 * The monitor's "Local changes" uses a narrower list (`toolChangePaths`): only the folders the
 * session changed something in, through an edit or a git command that writes (a commit, a push, a
 * new branch) or a pull request it opened or merged. A `cd` to read a repository does not count.
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

/**
 * git subcommands that change a repository: the agent's own work, not a look around. `worktree
 * add` is left out: the work happens in the new worktree, which its own edits and commits list.
 */
const GIT_WRITE = /^(commit|push|merge|rebase|cherry-pick|revert|am|apply)\b|^(checkout|switch)\s+-[bBcC]\b/

/** A command without the bodies of its here-documents (a PR body is text, not commands); `<<<` is a here-string, not one. */
function withoutHeredocs(command: string): string {
  const out: string[] = []
  let end: string | undefined
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if (line.replace(/^\t+/, '').trim() === end) end = undefined
      continue
    }
    out.push(line)
    const m = /(?<!<)<<(?!<)-?\s*(["']?)([A-Za-z_][\w-]*)\1/.exec(line)
    if (m) end = m[2]
  }
  return out.join('\n')
}

/**
 * The simple commands of a shell line, split on newlines, `;`, `&&`, `||` and `|` outside quotes,
 * each with how many subshells it opens (leading `(`) and closes (trailing `)`).
 */
function shellSegments(command: string): { text: string; opens: number; closes: number }[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += ch + command[++i]
        continue
      }
      if (ch === quote) quote = undefined
      cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i]
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      parts.push(cur)
      cur = ''
      if ((ch === '|' && command[i + 1] === '|') || ch === '&') i++
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.map((raw) => {
    let text = raw.trim()
    let opens = 0
    let closes = 0
    while (/^[({]/.test(text)) {
      if (text[0] === '(') opens++
      text = text.slice(1).trimStart()
    }
    while (/[)}]$/.test(text)) {
      if (text.endsWith(')')) closes++
      text = text.slice(0, -1).trimEnd()
    }
    return { text, opens, closes }
  })
}

/** A shell word at the start of `rest`: quoted (spaces allowed) or bare; its unquoted value and length. */
function shellWord(rest: string): { value: string; length: number } | undefined {
  const m = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))/.exec(rest)
  return m ? { value: m[1] ?? m[2] ?? m[3]!, length: m[0].length } : undefined
}

/** `VAR=x`, `command`, `time`, `env`, `nice` and `sudo` in front of a command do not change what it is. */
const PREFIX = /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:command|time|env|nice|sudo)\s+)/

/**
 * The folders a shell command changed a repository in, in order: where each writing git command
 * ran (its `cd`s, subshells and `-C` followed), and where `gh pr create` or `gh pr merge` ran.
 * Quoted text is never split, and a `cd` inside `( … )` ends with the subshell.
 */
export function commandChangePaths(command: string, cwd: string | undefined, home: string): string[] {
  const out: string[] = []
  let here = cwd
  const saved: (string | undefined)[] = []
  for (const seg of shellSegments(withoutHeredocs(command))) {
    for (let i = 0; i < seg.opens; i++) saved.push(here)
    let text = seg.text
    for (let p = PREFIX.exec(text); p; p = PREFIX.exec(text)) text = text.slice(p[0].length)
    const cd = /^cd\s+/.exec(text)
    if (cd) {
      const word = shellWord(text.slice(cd[0].length))
      const quotedHome = word && /^["']/.test(text.slice(cd[0].length)) && word.value.startsWith('~')
      if (word && !quotedHome) here = resolveWorkPath(word.value, here, home) ?? here
    } else if (/^git\s/.test(text)) {
      let rest = text.slice(3).trimStart()
      let where = here
      for (;;) {
        const c = /^-C\s+/.exec(rest)
        if (c) {
          const word = shellWord(rest.slice(c[0].length))
          if (!word) break
          where = resolveWorkPath(word.value, where, home)
          rest = rest.slice(c[0].length + word.length).trimStart()
          continue
        }
        const o = /^(?:-c\s+\S+|--no-pager|--paginate|-P|--no-replace-objects|--(?:git-dir|work-tree|namespace)=\S+)\s*/.exec(rest)
        if (o) {
          rest = rest.slice(o[0].length)
          continue
        }
        break
      }
      if (where && GIT_WRITE.test(rest)) out.push(where)
    } else if (here && /^gh\s+pr\s+(create|merge)\b/.test(text) && !/\s(-R|--repo)[\s=]/.test(text)) out.push(here)
    for (let i = 0; i < seg.closes && saved.length; i++) here = saved.pop()
  }
  return out
}

/**
 * The folders one Claude Code tool call changed something in: an edited or written file's folder,
 * or where a Bash command wrote to git or opened a pull request (see `commandChangePaths`).
 */
export function toolChangePaths(tool: string | undefined, input: Readonly<Record<string, unknown>>, cwd: string | undefined, home: string): string[] {
  if (tool === 'Bash') return typeof input['command'] === 'string' ? commandChangePaths(input['command'], cwd, home) : []
  return toolWorkPaths(tool, input, cwd, home)
}
