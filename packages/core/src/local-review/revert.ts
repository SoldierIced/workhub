/**
 * Reverting uncommitted changes from the local review: what the renderer may ask for (a file, a
 * hunk or some lines of a hunk, with the digest of the diff it saw) and the patch that undoes a
 * hunk or a selection of its lines. Pure: the patch is built from the raw `git diff` text, never
 * from the parsed one, so carriage returns and "\ No newline at end of file" markers survive.
 */
import type { LocalReviewScope } from './index'

/** What to revert in one file: all of it, one hunk, or some changed lines of one hunk (indexes into the hunk's lines as the review shows them). */
export type LocalRevertTarget = { kind: 'file' } | { kind: 'hunk'; hunk: number } | { kind: 'lines'; hunk: number; lines: number[] }

/** A revert as the review window asks for it: never patch text, only where and the digest of what it showed. */
export interface LocalRevertRequest {
  repoRoot: string
  path: string
  /** Only `uncommitted`: in the branch scope a reverse patch would also undo committed work. */
  scope: LocalReviewScope
  target: LocalRevertTarget
  /** The file's `digest` from the load the window shows. */
  digest: string
}

/**
 * `changed`: the file is not what the window showed (refresh); `scope`: not the uncommitted scope;
 * `unsupported`: nothing to revert this way (a hunk of a binary, deleted or new untracked file, a
 * repository without commits); `staged`: the lines differ between the index and the working tree;
 * `hidden`: the hunk is not fully shown (past the line limit); `notReviewed`: not a file of a repo
 * this session's review loaded.
 */
/** `otherHost`: the session runs on another host (a WSL distribution), where nothing is reverted yet. */
export type LocalRevertError = 'unknownSession' | 'notReviewed' | 'scope' | 'changed' | 'unsupported' | 'staged' | 'hidden' | 'otherHost' | 'failed'

export type LocalRevertAnswer = { ok: true } | { ok: false; error: LocalRevertError; detail?: string }

/** Lines a lines target may name, at most. */
const MAX_LINES = 100_000

/** A target as the renderer sent it, checked field by field; null when it is not one. */
export function validRevertTarget(value: unknown): LocalRevertTarget | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const index = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  if (o['kind'] === 'file') return { kind: 'file' }
  if (!index(o['hunk'])) return null
  if (o['kind'] === 'hunk') return { kind: 'hunk', hunk: o['hunk'] }
  if (o['kind'] !== 'lines' || !Array.isArray(o['lines']) || o['lines'].length === 0 || o['lines'].length > MAX_LINES) return null
  if (!o['lines'].every(index)) return null
  return { kind: 'lines', hunk: o['hunk'], lines: [...new Set(o['lines'] as number[])].sort((a, b) => a - b) }
}

/** A raw `git diff` cut into one text per file, each starting at its `diff --git` line. */
export function splitDiffSections(raw: string): string[] {
  const sections: string[] = []
  let start = -1
  let at = 0
  while (at <= raw.length) {
    const end = raw.indexOf('\n', at)
    if (raw.startsWith('diff --git ', at)) {
      if (start >= 0) sections.push(raw.slice(start, at))
      start = at
    }
    if (end < 0) break
    at = end + 1
  }
  if (start >= 0) sections.push(raw.slice(start))
  return sections
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface RawHunk {
  header: string
  /** Body lines as git printed them (`\r` kept), markers (`\`) included. */
  body: string[]
}

function rawHunks(lines: readonly string[]): { header: string[]; hunks: RawHunk[] } {
  const header: string[] = []
  const hunks: RawHunk[] = []
  for (const line of lines) {
    if (HUNK_HEADER.test(line)) hunks.push({ header: line, body: [] })
    else if (hunks.length) {
      if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) hunks.at(-1)!.body.push(line)
    } else header.push(line)
  }
  return { header, hunks }
}

/** The name on a `+++ ` line, without the tab git adds after a name with spaces; null for `/dev/null`. */
function newSideName(header: readonly string[]): string | null {
  const plus = header.find((l) => l.startsWith('+++ '))
  if (plus === undefined) return null
  const raw = plus.slice(4).replace(/\r$/, '')
  const tab = raw.indexOf('\t')
  const name = tab < 0 ? raw : raw.slice(0, tab)
  return name === '/dev/null' ? null : name
}

/** `b/x` → `a/x`, `"b/x"` → `"a/x"`. */
const asOldSide = (name: string): string => (name.startsWith('"b/') ? `"a/${name.slice(3)}` : name.startsWith('b/') ? `a/${name.slice(2)}` : name)

export type RevertPatch = { ok: true; patch: string } | { ok: false; reason: 'noHunk' | 'noLines' | 'unsupported' }

/**
 * The patch that, applied with `git apply -R`, undoes one hunk of a file's section of `git diff
 * <rev>` (or only some of its changed lines). The header always names the new path on both sides,
 * so a renamed, new or mode-changed file keeps its name, mode and the rest of its changes. Lines
 * left out of a selection stay as they are: an added line becomes context, a removed line is
 * dropped (it is not in the working tree and is not put back). Line indexes count the hunk's lines
 * without the "\ No newline" markers, as `parseUnifiedDiff` does.
 */
export function buildRevertPatch(section: string, hunkIndex: number, lineIndexes?: readonly number[]): RevertPatch {
  const { header, hunks } = rawHunks(section.split('\n'))
  const name = newSideName(header)
  // A deleted file (no working-tree copy to patch) or one without a text diff.
  if (name === null) return { ok: false, reason: 'unsupported' }
  const hunk = hunks[hunkIndex]
  if (!hunk) return { ok: false, reason: 'noHunk' }
  const out: string[] = []
  const selected = lineIndexes ? new Set(lineIndexes) : null
  let index = -1
  let kept = false
  let changes = 0
  let oldCount = 0
  let newCount = 0
  for (const line of hunk.body) {
    if (line.startsWith('\\')) {
      if (kept) out.push(line)
      continue
    }
    index++
    const kind = line[0]
    const text = line.slice(1)
    const pick = selected === null || selected.has(index)
    if (selected !== null && pick && kind === ' ') return { ok: false, reason: 'noLines' }
    kept = true
    if (kind === ' ') {
      out.push(line)
      oldCount++
      newCount++
    } else if (kind === '+') {
      out.push(pick ? line : ` ${text}`)
      if (pick) changes++
      else oldCount++
      newCount++
    } else if (pick) {
      out.push(line)
      changes++
      oldCount++
    } else kept = false
  }
  if (selected !== null && [...selected].some((i) => i > index)) return { ok: false, reason: 'noLines' }
  if (changes === 0) return { ok: false, reason: 'noLines' }
  const m = HUNK_HEADER.exec(hunk.header)!
  const newStart = Number(m[3])
  // The old side is the working tree with the change undone: it starts where the new side does.
  const oldStart = oldCount === 0 ? Math.max(newStart - 1, 0) : newCount === 0 ? newStart + 1 : newStart
  const old = asOldSide(name)
  return {
    ok: true,
    patch: [`diff --git ${old} ${name}`, `--- ${old}`, `+++ ${name}`, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...out, ''].join('\n')
  }
}
