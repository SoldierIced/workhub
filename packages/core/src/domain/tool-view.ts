/**
 * What a tool call did, structured enough for the chat to show it per tool: an edit as a diff, a
 * command with its output, a search with its match count. Agents fill what they know; a call
 * without a view keeps the plain title-and-detail row. Everything here is data from the agent:
 * the renderer shows it as text, never as HTML.
 */
import type { DiffHunk, DiffLine } from '../codehost/domain'
import type { TokenUsage } from './monitor'

export interface ToolArg {
  key: string
  value: string
}

export interface FileEdit {
  oldText: string
  newText: string
  /** The edit replaced every occurrence of `oldText`. */
  replaceAll?: boolean
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ToolView =
  | { kind: 'edit'; path: string; edits: FileEdit[] }
  /** A new or rewritten file (Write), or a notebook cell's new source. */
  | { kind: 'write'; path: string; content: string }
  | { kind: 'read'; path: string; offset?: number; limit?: number }
  | { kind: 'search'; tool: string; pattern: string; path?: string; glob?: string }
  | { kind: 'command'; command: string; description?: string }
  | { kind: 'fetch'; url: string; prompt?: string }
  | { kind: 'webSearch'; query: string }
  /** A subagent the call started; the link to its conversation comes with the result. */
  | { kind: 'task'; subagentType?: string; description?: string; prompt?: string }
  | { kind: 'todo'; items: TodoItem[] }
  | { kind: 'mcp'; server: string; tool: string; args: ToolArg[] }
  | { kind: 'generic'; tool: string; args: ToolArg[] }

export interface ToolResultView {
  /** The result as text, cut to a bounded size. */
  text?: string
  /** `text` was cut. */
  truncated?: boolean
  isError?: boolean
  /** A command's exit status, when the agent reports it. */
  exitCode?: number
  /** Matches or files a search found. */
  matchCount?: number
  /** Lines a read returned. */
  lineCount?: number
  /** The subagent a Task call started (its id in the session's subagent list). */
  agentId?: string
  /** The edit as the agent applied it, with the file's real line numbers (Claude's `structuredPatch`). */
  patch?: PatchHunk[]
}

/** A unified-diff hunk as agents report it: start lines and ` `/`-`/`+` prefixed lines. */
export interface PatchHunk {
  oldStart: number
  newStart: number
  lines: string[]
}

export type ConversationEntry =
  | { kind: 'text'; id: string; text: string; at?: number }
  /** `durationMs`: time between the previous record and this thinking block, when both carry a time. */
  | { kind: 'thinking'; id: string; text: string; durationMs?: number; at?: number }
  /** A later message the parent (or the harness) sent the subagent. */
  | { kind: 'user'; id: string; text: string; at?: number }
  | {
      kind: 'tool'
      id: string
      /** The agent's tool name (`Edit`, `mcp__github__create_issue`). */
      name: string
      title: string
      detail?: string
      view: ToolView
      status: 'in_progress' | 'completed' | 'failed'
      result?: ToolResultView
      at?: number
      endedAt?: number
    }

/** One subagent's conversation, for the subagent view. */
export interface SubagentConversation {
  id: string
  type?: string
  description?: string
  model?: string
  status?: string
  tokens?: TokenUsage
  startedAt?: number
  lastActivityAt?: number
  /** The folder the subagent worked in, for relative paths. */
  cwd?: string
  /** What the parent asked it to do. */
  prompt?: string
  entries: ConversationEntry[]
  /** The answer it returned to the parent, once it finished. */
  result?: string
  /** Earlier entries left out to keep the conversation bounded. */
  omitted?: number
}

/** `path` relative to `cwd` when it is inside it; otherwise unchanged. */
export function relativePath(path: string, cwd: string | undefined): string {
  if (!cwd) return path
  const base = cwd.replace(/[\\/]+$/, '')
  if (path === base) return '.'
  for (const sep of ['/', '\\']) if (path.startsWith(base + sep)) return path.slice(base.length + 1)
  return path
}

/** Cuts a text to `max` characters, saying whether it did. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }
}

// ---------------------------------------------------------------------------------------------
// Line diff (Myers), for edit views: old and new strings in, hunks in the PR diff's model out.

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { op: '=' | '-' | '+'; a: number; b: number }

/** Shortest edit script of `a` into `b`, or null when it needs more than `maxD` edits. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(n + m, maxD)
  const off = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, off, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], off: number, n: number, m: number): Op[] {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? k + 1 : k - 1
    const prevX = v[off + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ op: '=', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (d > 0) ops.push(x === prevX ? { op: '+', a: x, b: y - 1 } : { op: '-', a: x - 1, b: y })
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/**
 * Line diff of two texts, every line kept (the PR diff's line model). The common start and end
 * are matched first; past `maxEdits` changes in between, the middle shows as removed then added.
 */
export function diffLines(oldText: string, newText: string, maxEdits = 1000): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const ops =
    myers(midA, midB, maxEdits) ?? [...midA.map((_, i): Op => ({ op: '-', a: i, b: 0 })), ...midB.map((_, j): Op => ({ op: '+', a: 0, b: j }))]
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ kind: 'context', text: a[i]!, oldNumber: i + 1, newNumber: i + 1 })
  for (const o of ops) {
    if (o.op === '=') out.push({ kind: 'context', text: midA[o.a]!, oldNumber: start + o.a + 1, newNumber: start + o.b + 1 })
    else if (o.op === '-') out.push({ kind: 'removed', text: midA[o.a]!, oldNumber: start + o.a + 1 })
    else out.push({ kind: 'added', text: midB[o.b]!, newNumber: start + o.b + 1 })
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ kind: 'context', text: a[i]!, oldNumber: i + 1, newNumber: j + 1 })
  return out
}

function hunk(lines: DiffLine[], oldStart?: number, newStart?: number): DiffHunk {
  const oldCount = lines.filter((l) => l.kind !== 'added').length
  const newCount = lines.filter((l) => l.kind !== 'removed').length
  const o = oldStart ?? lines.find((l) => l.oldNumber !== undefined)?.oldNumber ?? 0
  const n = newStart ?? lines.find((l) => l.newNumber !== undefined)?.newNumber ?? 0
  return { header: `@@ -${o},${oldCount} +${n},${newCount} @@`, lines }
}

/** Changed lines with `context` unchanged lines around them, grouped as unified-diff hunks. */
export function diffHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.flatMap((l, i) => (l.kind === 'context' ? [] : [i]))
  if (!changed.length) return []
  const hunks: DiffHunk[] = []
  let from = Math.max(0, changed[0]! - context)
  let to = Math.min(lines.length - 1, changed[0]! + context)
  for (const i of changed.slice(1)) {
    if (i - context <= to + 1) to = Math.min(lines.length - 1, i + context)
    else {
      hunks.push(hunk(lines.slice(from, to + 1)))
      from = Math.max(0, i - context)
      to = Math.min(lines.length - 1, i + context)
    }
  }
  hunks.push(hunk(lines.slice(from, to + 1)))
  return hunks
}

/** Hunks of a reported patch (` `/`-`/`+` prefixed lines), numbered from their start lines. */
export function hunksFromPatch(patch: PatchHunk[]): DiffHunk[] {
  return patch.map((h) => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines = h.lines.map((raw): DiffLine => {
      const mark = raw[0]
      const text = raw.slice(1)
      if (mark === '-') return { kind: 'removed', text, oldNumber: oldNo++ }
      if (mark === '+') return { kind: 'added', text, newNumber: newNo++ }
      return { kind: 'context', text: mark === ' ' ? text : raw, oldNumber: oldNo++, newNumber: newNo++ }
    })
    return hunk(lines, h.oldStart, h.newStart)
  })
}

export function diffStats(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.kind === 'added') added++
      else if (l.kind === 'removed') removed++
    }
  return { added, removed }
}

/** The hunks of an edit view: the reported patch when there is one, else a diff of each edit. */
export function editHunks(view: Extract<ToolView, { kind: 'edit' }>, patch?: PatchHunk[]): DiffHunk[] {
  if (patch?.length) return hunksFromPatch(patch)
  return view.edits.flatMap((e) => diffHunks(diffLines(e.oldText, e.newText)))
}
