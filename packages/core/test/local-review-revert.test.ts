import { describe, expect, it } from 'vitest'
import { buildRevertPatch, parseUnifiedDiff, splitDiffSections, validRevertTarget } from '../src'

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  ' four',
  '@@ -20,3 +21,3 @@',
  ' x',
  '-y',
  '+Y',
  ' z',
  ''
].join('\n')

const patchLines = (r: ReturnType<typeof buildRevertPatch>) => (r.ok ? r.patch.split('\n') : [])

describe('splitDiffSections', () => {
  it('cuts a raw diff into one section per file, in the order the parser reads them', () => {
    const raw = MODIFIED + MODIFIED.replaceAll('src/a.ts', 'src/b.ts')
    const sections = splitDiffSections(raw)
    expect(sections).toHaveLength(2)
    expect(sections.join('')).toBe(raw)
    expect(sections.map((s) => parseUnifiedDiff(s)[0]!.path)).toEqual(parseUnifiedDiff(raw).map((f) => f.path))
    expect(splitDiffSections('')).toEqual([])
  })
})

describe('buildRevertPatch', () => {
  it('keeps a whole hunk, named on both sides by the new path', () => {
    expect(patchLines(buildRevertPatch(MODIFIED, 1))).toEqual(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -21,3 +21,3 @@', ' x', '-y', '+Y', ' z', ''])
  })

  it('turns unselected added lines into context and drops unselected removed lines', () => {
    // Lines of hunk 0: 0 " one", 1 "-two", 2 "+TWO", 3 "+extra", 4 " three", 5 " four".
    expect(patchLines(buildRevertPatch(MODIFIED, 0, [3]))).toEqual(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,4 +1,5 @@', ' one', ' TWO', '+extra', ' three', ' four', ''])
    expect(patchLines(buildRevertPatch(MODIFIED, 0, [1]))).toEqual(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,6 +1,5 @@', ' one', '-two', ' TWO', ' extra', ' three', ' four', ''])
  })

  it('refuses context lines, lines past the hunk, a missing hunk and an empty selection', () => {
    expect(buildRevertPatch(MODIFIED, 0, [0])).toEqual({ ok: false, reason: 'noLines' })
    expect(buildRevertPatch(MODIFIED, 0, [2, 99])).toEqual({ ok: false, reason: 'noLines' })
    expect(buildRevertPatch(MODIFIED, 0, [])).toEqual({ ok: false, reason: 'noLines' })
    expect(buildRevertPatch(MODIFIED, 2)).toEqual({ ok: false, reason: 'noHunk' })
  })

  it('names a rename by its new path only, so the file keeps its name', () => {
    const renamed = ['diff --git a/old.ts b/new.ts', 'similarity index 90%', 'rename from old.ts', 'rename to new.ts', 'index 1..2 100644', '--- a/old.ts', '+++ b/new.ts', '@@ -1,2 +1,3 @@', ' a', ' b', '+c', ''].join('\n')
    expect(patchLines(buildRevertPatch(renamed, 0)).slice(0, 4)).toEqual(['diff --git a/new.ts b/new.ts', '--- a/new.ts', '+++ b/new.ts', '@@ -1,2 +1,3 @@'])
  })

  it('patches a new file as a modification, and refuses a deleted or binary one', () => {
    const added = ['diff --git a/n.ts b/n.ts', 'new file mode 100644', 'index 0000000..1', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,2 @@', '+n1', '+n2', ''].join('\n')
    expect(patchLines(buildRevertPatch(added, 0, [1]))).toEqual(['diff --git a/n.ts b/n.ts', '--- a/n.ts', '+++ b/n.ts', '@@ -1,1 +1,2 @@', ' n1', '+n2', ''])
    expect(patchLines(buildRevertPatch(added, 0))).toContain('@@ -0,0 +1,2 @@')
    const deleted = ['diff --git a/d.ts b/d.ts', 'deleted file mode 100644', '--- a/d.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', ''].join('\n')
    expect(buildRevertPatch(deleted, 0)).toEqual({ ok: false, reason: 'unsupported' })
    expect(buildRevertPatch('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n', 0)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('keeps quoted names, the tab after a name with spaces, and carriage returns', () => {
    const quoted = ['diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', '--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', '@@ -1 +1 @@', '-a\r', '+b\r', ''].join('\n')
    expect(patchLines(buildRevertPatch(quoted, 0))).toEqual(['diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"', '--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', '@@ -1,1 +1,1 @@', '-a\r', '+b\r', ''])
    const spaced = ['diff --git a/my file.ts b/my file.ts', '--- a/my file.ts\t', '+++ b/my file.ts\t', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    expect(patchLines(buildRevertPatch(spaced, 0)).slice(0, 3)).toEqual(['diff --git a/my file.ts b/my file.ts', '--- a/my file.ts', '+++ b/my file.ts'])
  })

  it('keeps a "no newline" marker with its line and drops it with an omitted one', () => {
    const eof = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,3 @@', ' one', '-two', '\\ No newline at end of file', '+two', '+three', '\\ No newline at end of file', ''].join('\n')
    // Lines: 0 " one", 1 "-two", 2 "+two", 3 "+three" (markers not counted).
    expect(patchLines(buildRevertPatch(eof, 0, [3]))).toEqual(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,3 @@', ' one', ' two', '+three', '\\ No newline at end of file', ''])
    expect(patchLines(buildRevertPatch(eof, 0))).toEqual(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,3 @@', ' one', '-two', '\\ No newline at end of file', '+two', '+three', '\\ No newline at end of file', ''])
  })

  it('numbers a pure deletion from the line before it', () => {
    const removal = ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -4,2 +3,0 @@', '-x', '-y', ''].join('\n')
    expect(patchLines(buildRevertPatch(removal, 0))[3]).toBe('@@ -4,2 +3,0 @@')
  })
})

describe('validRevertTarget', () => {
  it('accepts the three shapes and normalizes the lines', () => {
    expect(validRevertTarget({ kind: 'file', extra: 1 })).toEqual({ kind: 'file' })
    expect(validRevertTarget({ kind: 'hunk', hunk: 2 })).toEqual({ kind: 'hunk', hunk: 2 })
    expect(validRevertTarget({ kind: 'lines', hunk: 0, lines: [5, 1, 5] })).toEqual({ kind: 'lines', hunk: 0, lines: [1, 5] })
  })

  it('refuses anything else', () => {
    for (const bad of [null, 'file', {}, { kind: 'hunk' }, { kind: 'hunk', hunk: -1 }, { kind: 'hunk', hunk: 1.5 }, { kind: 'lines', hunk: 0, lines: [] }, { kind: 'lines', hunk: 0, lines: ['1'] }, { kind: 'patch', hunk: 0 }]) {
      expect(validRevertTarget(bad)).toBeNull()
    }
  })
})
