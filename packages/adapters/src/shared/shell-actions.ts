/**
 * What a shell command did to pull requests and branches, for the monitor's "work of the session":
 * the `gh pr` commands that create or act on one PR, `gh api` calls on one PR, and the git commands
 * that create, check out, commit on or push a branch. Listings (`gh pr list`, `gh search`) act on
 * none. Pure: command text and its output in, references out. The shell is read word by word,
 * so quoted text (a commit message, a PR body) and heredocs never count as commands.
 */
import { resolveWorkPath } from '@workhub/core'

/** A pull request one command acted on: by URL, or by number with its `owner/repo` (`-R`) or the folder it ran in. */
export interface CommandPullRequest {
  /** The command changed it (created, edited, commented, reviewed, merged it...) rather than only read it (`view`, `diff`, `checks`, a GET). */
  changes: boolean
  url?: string
  number?: number
  repo?: string
  folder?: string
}

/** A branch one command created, checked out, committed on or pushed: by name, or by its folder when the command did not name it. */
export interface CommandBranch {
  name?: string
  folder?: string
  pushed?: boolean
}

export interface CommandActions {
  prs: CommandPullRequest[]
  branches: CommandBranch[]
  /**
   * Which PR URLs of the command's output are PRs it acted on: `any` for a `gh pr` command without
   * a PR (`create` prints the new one's URL), `targeted` for the ones it named by number only.
   */
  prOutput: 'none' | 'targeted' | 'any'
  /** Whether the `gh pr` command without a PR changes the PR its output names (`create`), rather than reading it (`view`). */
  outputChanges: boolean
  /** Whether the command commits or pushes, so its output can name the branch (`[feat/x 1a2b3c4]`, `feat/x -> feat/x`). */
  readsGitOutput: boolean
}

interface Word {
  text: string
  /** Holds a variable, substitution or glob: its value is not known. */
  dynamic: boolean
}

type Token = Word | { op: string }

const isWord = (t: Token): t is Word => 'text' in t

/** Drops heredoc bodies (`<<'EOF' … EOF`): their lines are data, not commands. */
function withoutHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  let end: string | null = null
  for (const line of lines) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) end = m[2]!
  }
  return out.join('\n')
}

/** Words and operators of a shell command; `$(` and backticks split it like an operator, so a substitution is a command of its own. */
function tokenize(command: string): Token[] {
  const src = withoutHeredocs(command)
  const tokens: Token[] = []
  let text = ''
  let dynamic = false
  let open = false
  /** The word after a redirection (`> file`) is its target, not an argument. */
  let target = false
  const flush = () => {
    if (open) {
      if (target) target = false
      else tokens.push({ text, dynamic })
    }
    text = ''
    dynamic = false
    open = false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end < 0 ? src.length : end
      text += src.slice(i + 1, stop)
      open = true
      i = stop
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++
        else if (src[j] === '$' || src[j] === '`') dynamic = true
        j++
      }
      text += src.slice(i + 1, j).replace(/\\(.)/g, '$1')
      open = true
      i = j
    } else if (c === '\\') {
      text += src[i + 1] ?? ''
      open = true
      i++
    } else if (c === '$' && src[i + 1] === '(') {
      flush()
      tokens.push({ op: '$(' })
      i++
    } else if (/[\s]/.test(c)) {
      flush()
      if (c === '\n') tokens.push({ op: '\n' })
    } else if (/[;&|()`]/.test(c)) {
      flush()
      const two = src.slice(i, i + 2)
      if (two === '&&' || two === '||') {
        tokens.push({ op: two })
        i++
      } else tokens.push({ op: c })
    } else if (c === '>' || c === '<') {
      // A redirection (`2>&1`, `>/dev/null`, `<<EOF`), with the descriptor number before it.
      if (open && /^\d+$/.test(text)) {
        text = ''
        open = false
      } else flush()
      let j = i + 1
      while (src[j] === '>' || src[j] === '<') j++
      if (src[j] === '&') {
        j++
        while (/[\d-]/.test(src[j] ?? '')) j++
      } else target = true
      i = j - 1
    } else if (c === '#' && !open) {
      // A comment runs to the end of the line.
      const end = src.indexOf('\n', i)
      i = (end < 0 ? src.length : end) - 1
    } else {
      if (c === '$' || c === '*' || c === '?' || c === '{') dynamic = true
      text += c
      open = true
    }
  }
  flush()
  return tokens
}

/** The simple commands of a command line, each with the folder it runs in (after the `cd`s before it). */
function simpleCommands(command: string, cwd: string | undefined, home: string): { words: Word[]; folder: string | undefined }[] {
  const out: { words: Word[]; folder: string | undefined }[] = []
  let folder = cwd
  let words: Word[] = []
  const end = () => {
    // `FOO=bar cmd`, `env`, `command` and `time` run the command after them.
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text) || ['env', 'command', 'time', 'nohup'].includes(words[0]!.text))) words.shift()
    if (words[0]?.text === 'cd') {
      const target = words[1]
      const path = target && !target.dynamic ? resolveWorkPath(target.text, folder, home) : undefined
      if (path) folder = path
    } else if (words.length) out.push({ words, folder })
    words = []
  }
  for (const t of tokenize(command)) {
    if (isWord(t)) words.push(t)
    else end()
  }
  end()
  return out
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i
const SHA = /^[0-9a-f]{7,40}$/i

/** A branch name a command gave literally; not a ref like `HEAD`, a commit, a remote branch or a file. */
function branchName(word: Word | undefined): string | undefined {
  if (!word || word.dynamic) return undefined
  const name = word.text.replace(/^\+/, '').replace(/^refs\/heads\//, '')
  if (!name || name.startsWith('-') || name.startsWith('.') || name.startsWith('/') || name === 'HEAD' || name.startsWith('HEAD~') || name.startsWith('HEAD^') || SHA.test(name)) return undefined
  if (/^(origin|upstream)\//.test(name) || /\.[A-Za-z]{1,5}$/.test(name)) return undefined
  return name
}

/** Flags of the git commands read here that take a value (`-m msg`), so their value is not taken as a branch. */
const GIT_VALUE_FLAGS = new Set(['-m', '-F', '-o', '--push-option', '--repo', '--receive-pack', '--exec', '-t', '--track', '--reason', '--orphan'])

function gitActions(args: Word[], folder: string | undefined, home: string, acts: CommandActions): void {
  let i = 0
  let here = folder
  // Global options: `git -C <path>`, `-c key=value`, `--no-pager`.
  while (i < args.length && args[i]!.text.startsWith('-')) {
    const flag = args[i]!.text
    if (flag === '-C') {
      const path = args[i + 1] && !args[i + 1]!.dynamic ? resolveWorkPath(args[i + 1]!.text, here, home) : undefined
      here = path ?? here
      i += 2
    } else if (flag === '-c') i += 2
    else i++
  }
  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  const positionals = (from: Word[]) => {
    const out: Word[] = []
    for (let j = 0; j < from.length; j++) {
      const w = from[j]!
      if (w.text === '--') break
      if (w.text.startsWith('-')) {
        if (GIT_VALUE_FLAGS.has(w.text)) j++
        continue
      }
      out.push(w)
    }
    return out
  }
  if (sub === 'checkout' || sub === 'switch') {
    const create = rest.findIndex((w) => ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(w.text))
    if (create >= 0) {
      const name = branchName(rest[create + 1])
      if (name) acts.branches.push({ name, folder: here })
      return
    }
    // `git checkout <branch>`; with a `--` or a second name it checks out files.
    if (rest.some((w) => w.text === '--' || w.text === '--detach' || w.text === '-')) return
    const names = positionals(rest)
    const name = names.length === 1 ? branchName(names[0]) : undefined
    if (name) acts.branches.push({ name, folder: here })
  } else if (sub === 'worktree' && rest[0]?.text === 'add') {
    const flag = rest.findIndex((w) => w.text === '-b' || w.text === '-B')
    const name = flag >= 0 ? branchName(rest[flag + 1]) : undefined
    const path = positionals(rest.filter((_, j) => j > 0 && (flag < 0 || (j !== flag && j !== flag + 1))))[0]
    const at = path && !path.dynamic ? resolveWorkPath(path.text, here, home) : undefined
    if (name) acts.branches.push({ name, folder: at ?? here })
  } else if (sub === 'commit') {
    acts.readsGitOutput = true
    acts.branches.push({ folder: here })
  } else if (sub === 'push') {
    if (rest.some((w) => ['-d', '--delete', '--tags', '--mirror', '--all'].includes(w.text))) return
    acts.readsGitOutput = true
    const [, ...refspecs] = positionals(rest)
    const named = refspecs.filter((r) => !r.text.startsWith(':')).map((r) => {
      const [src, dst] = r.text.split(':')
      return branchName({ text: dst || src || '', dynamic: r.dynamic })
    })
    if (named.length && named.every(Boolean)) for (const name of named) acts.branches.push({ name, folder: here, pushed: true })
    else acts.branches.push({ folder: here, pushed: true })
  }
}

/** `gh pr` subcommands that act on no single PR. */
const GH_LISTINGS = new Set(['list', 'status'])

/** `gh pr` flags that take a value, so the value is not taken as the PR (`-m`, `-a`, `-r` are left out: `merge` and `review` use them alone). */
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-B', '--base', '-H', '--head', '-l', '--label', '--assignee', '--reviewer', '--milestone', '-p', '--project', '-T', '--template', '--json', '-q', '--jq', '-L', '--limit', '--add-label', '--remove-label', '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project', '--remove-project', '--subject', '--match-head-commit', '-A', '--author-email'])

/** `gh pr` subcommands that only read the PR. */
const GH_READS = new Set(['view', 'diff', 'checks'])

/** Reads one `gh` command; returns whether it lists PRs (its output names PRs it did not act on). */
function ghActions(args: Word[], folder: string | undefined, acts: CommandActions): boolean {
  const sub = args[0]?.text
  if (sub === 'api') {
    const path = args.slice(1).find((w) => /^\/?repos\//.test(w.text))
    const m = path && !path.dynamic ? /^\/?repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)(?:\/|$)/.exec(path.text) : null
    const method = args.findIndex((w) => w.text === '-X' || w.text === '--method')
    const changes = (method >= 0 && args[method + 1]?.text.toUpperCase() !== 'GET') || args.some((w) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(w.text))
    if (m) acts.prs.push({ changes, url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase() })
    // Its JSON names other pages and users: never read for PRs.
    return true
  }
  if (sub !== 'pr') return sub === 'search'
  const verb = args[1]?.text
  if (!verb || GH_LISTINGS.has(verb)) return true
  const changes = !GH_READS.has(verb)
  const flag = args.findIndex((w) => w.text === '-R' || w.text === '--repo')
  const inline = args.find((w) => w.text.startsWith('--repo='))
  const repoWord = flag >= 0 ? args[flag + 1] : inline ? { text: inline.text.slice('--repo='.length), dynamic: inline.dynamic } : undefined
  const repo = repoWord && !repoWord.dynamic && /^[\w.-]+\/[\w.-]+$/.test(repoWord.text) ? repoWord.text : undefined
  // The PR is the first argument that is not a flag or a flag's value: a number, a URL or a branch.
  let target: Word | undefined
  for (let j = 2; j < args.length; j++) {
    const w = args[j]!
    if (w.text.startsWith('-')) {
      if (GH_VALUE_FLAGS.has(w.text)) j++
      continue
    }
    target = w
    break
  }
  if (repoWord && !repo) return false
  if (!target) {
    // The PR of the current branch, or the one `create` makes: its URL is in the output.
    acts.prOutput = 'any'
    acts.outputChanges ||= changes
    return false
  }
  if (target.dynamic) return false
  const url = PR_URL.exec(target.text)
  if (url) acts.prs.push({ changes, url: `https://github.com/${url[1]}/${url[2]}/pull/${url[3]}`.toLowerCase() })
  else if (/^#?\d+$/.test(target.text)) {
    const number = Number(target.text.replace('#', ''))
    if (repo) acts.prs.push({ changes, url: `https://github.com/${repo}/pull/${number}`.toLowerCase() })
    else {
      acts.prs.push({ changes, number, folder })
      if (acts.prOutput === 'none') acts.prOutput = 'targeted'
    }
  }
  return false
}

/** What one shell command did to pull requests and branches (see the module comment). */
export function commandActions(command: string, cwd: string | undefined, home: string): CommandActions {
  const acts: CommandActions = { prs: [], branches: [], prOutput: 'none', outputChanges: false, readsGitOutput: false }
  let lists = false
  for (const { words, folder } of simpleCommands(command, cwd, home)) {
    const [name, ...args] = words
    if (name?.text === 'git') gitActions(args, folder, home, acts)
    else if (name?.text === 'gh') lists = ghActions(args, folder, acts) || lists
  }
  // A listing in the same command prints PRs it did not act on.
  if (lists) acts.prOutput = 'none'
  return acts
}

/**
 * The PR URLs a `gh pr` command printed about the PRs it acted on: a URL alone on its line (what
 * `create`, `edit` and `comment` print), the one `view` ends with, or a JSON `url` field.
 */
export function printedPullRequestUrls(output: string): string[] {
  const out: string[] = []
  const note = (owner: string, repo: string, n: string) => {
    const url = `https://github.com/${owner}/${repo}/pull/${n}`.toLowerCase()
    if (!out.includes(url)) out.push(url)
  }
  for (const line of output.split('\n')) {
    const m =
      /^\s*https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\S*\s*$/i.exec(line) ??
      /View this pull request on GitHub:\s*https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(line) ??
      /"url"\s*:\s*"https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)"/i.exec(line)
    if (m) note(m[1]!, m[2]!, m[3]!)
  }
  return out
}

/**
 * Branches git printed while committing or pushing: `[feat/x 1a2b3c4] message` for a commit,
 * `1a2b3c4..5d6e7f8  feat/x -> feat/x` or `* [new branch] feat/x -> feat/x` for a push, with the
 * `owner/repo` of the push's `To <remote>` line.
 */
export function printedBranches(output: string): { name: string; pushed: boolean; repo?: string }[] {
  const out: { name: string; pushed: boolean; repo?: string }[] = []
  let repo: string | undefined
  for (const line of output.split('\n')) {
    const to = /^To\s+(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:git@)?github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/i.exec(line)
    if (to) {
      repo = `${to[1]}/${to[2]}`.toLowerCase()
      continue
    }
    const commit = /^\[([^\s\]]+)(?: \(root-commit\))? [0-9a-f]{7,40}\]/.exec(line)
    if (commit && commit[1] !== 'detached') out.push({ name: commit[1]!, pushed: false })
    const push = /^\s*[*+ -]?\s*(?:\[new branch\]|[0-9a-f]{7,40}\.\.\.?[0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/.exec(line)
    if (push) out.push({ name: push[2]!.replace(/^refs\/heads\//, ''), pushed: true, ...(repo ? { repo } : {}) })
  }
  return out
}
