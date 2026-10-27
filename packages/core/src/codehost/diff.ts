import type { DiffFile, DiffFileStatus, DiffHunk } from './domain'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(["\\])/g, '$1') : path
}

function stripPrefix(path: string): string {
  return unquote(path).replace(/^[ab]\//, '')
}

/**
 * Parses a unified diff (`git diff` / `gh pr diff` output) into files, hunks and numbered lines.
 * Lenient: text it does not understand is skipped, never thrown on.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const open = (path: string, oldPath?: string): DiffFile => {
    const f: DiffFile = { path, oldPath, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
    files.push(f)
    hunk = null
    return f
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (".+?"|\S+) (".+"|\S+)$/.exec(line)
      const a = m?.[1] ? stripPrefix(m[1]) : ''
      const b = m?.[2] ? stripPrefix(m[2]) : a
      file = open(b, a !== b ? a : undefined)
      if (a !== b) file.status = 'renamed'
      continue
    }
    if (!file) continue
    if (hunk === null) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) file.oldPath = unquote(line.slice(12))
      else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('--- ') && line.includes('/dev/null')) file.status = 'added'
      else if (line.startsWith('+++ ') && line.includes('/dev/null')) file.status = 'deleted'
    }
    const h = HUNK.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const current: DiffHunk = hunk
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'added', newNumber: newNo++, text: line.slice(1) })
      file.additions++
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'removed', oldNumber: oldNo++, text: line.slice(1) })
      file.deletions++
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldNumber: oldNo++, newNumber: newNo++, text: line.slice(1) })
    }
    // "\ No newline at end of file" and blank trailing lines carry no code.
  }
  return files
}

/** A one-file unified diff from a host that sends only the hunks (GitLab's `diffs` API). */
export function diffFileFromHunks(info: { path: string; oldPath?: string; status: DiffFileStatus }, hunksText: string): DiffFile {
  const header = `diff --git a/${info.oldPath ?? info.path} b/${info.path}\n`
  const [parsed] = parseUnifiedDiff(header + hunksText)
  const file: DiffFile = parsed ?? { path: info.path, status: info.status, binary: false, additions: 0, deletions: 0, hunks: [] }
  return { ...file, path: info.path, oldPath: info.oldPath && info.oldPath !== info.path ? info.oldPath : undefined, status: info.status }
}
