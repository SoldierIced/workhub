import { describe, expect, it } from 'vitest'
import { clip, diffHunks, diffLines, diffStats, editHunks, hunksFromPatch, relativePath } from '../src'

const signs = (text: string, next: string) =>
  diffLines(text, next).map((l) => `${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}${l.text}`)

describe('diffLines', () => {
  it('keeps unchanged lines and marks the changed ones', () => {
    expect(signs('a\nb\nc\n', 'a\nB\nc\n')).toEqual([' a', '-b', '+B', ' c'])
  })

  it('finds the shortest script inside the changed middle', () => {
    expect(signs('a\nb\nc\nd', 'a\nc\nx\nd')).toEqual([' a', '-b', ' c', '+x', ' d'])
  })

  it('treats an empty side as all added or all removed', () => {
    expect(signs('', 'one\ntwo')).toEqual(['+one', '+two'])
    expect(signs('one\ntwo', '')).toEqual(['-one', '-two'])
    expect(signs('', '')).toEqual([])
  })

  it('numbers lines in the old and the new text', () => {
    const lines = diffLines('a\nb\nc', 'a\nx\ny\nc')
    expect(lines.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [undefined, 3],
      [3, 4]
    ])
  })

  it('falls back to removed-then-added past the edit budget', () => {
    const lines = diffLines('a\nb\nc', 'x\ny\nz', 1)
    expect(lines.map((l) => l.kind)).toEqual(['removed', 'removed', 'removed', 'added', 'added', 'added'])
  })

  it('handles CRLF text like LF text', () => {
    expect(signs('a\r\nb\r\n', 'a\r\nc\r\n')).toEqual([' a', '-b', '+c'])
  })
})

describe('diffHunks', () => {
  const old = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

  it('groups changes with three lines of context and a unified header', () => {
    const next = old.replace('line 10', 'line ten')
    const hunks = diffHunks(diffLines(old, next))
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.header).toBe('@@ -7,7 +7,7 @@')
    expect(hunks[0]!.lines.map((l) => l.text)).toEqual(['line 7', 'line 8', 'line 9', 'line 10', 'line ten', 'line 11', 'line 12', 'line 13'])
  })

  it('splits far-apart changes into separate hunks and merges close ones', () => {
    const far = old.replace('line 2\n', 'line two\n').replace('line 19', 'line nineteen')
    expect(diffHunks(diffLines(old, far))).toHaveLength(2)
    const close = old.replace('line 5\n', 'line five\n').replace('line 9\n', 'line nine\n')
    expect(diffHunks(diffLines(old, close))).toHaveLength(1)
  })

  it('has no hunk when nothing changed', () => {
    expect(diffHunks(diffLines(old, old))).toEqual([])
  })

  it('counts added and removed lines', () => {
    expect(diffStats(diffHunks(diffLines('a\nb\nc', 'a\nB\nC\nD')))).toEqual({ added: 3, removed: 2 })
  })
})

describe('hunksFromPatch and editHunks', () => {
  it('reads a reported patch with the file line numbers', () => {
    const [h] = hunksFromPatch([{ oldStart: 40, newStart: 40, lines: [' keep', '-old', '+new', '+more'] }])
    expect(h!.header).toBe('@@ -40,2 +40,3 @@')
    expect(h!.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 40, 40],
      ['removed', 41, undefined],
      ['added', undefined, 41],
      ['added', undefined, 42]
    ])
  })

  it('prefers the patch and otherwise diffs every edit', () => {
    const view = { kind: 'edit' as const, path: '/r/a.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'x\ny', newText: 'x' }] }
    expect(diffStats(editHunks(view))).toEqual({ added: 1, removed: 2 })
    expect(editHunks(view, [{ oldStart: 3, newStart: 3, lines: ['+z'] }])).toHaveLength(1)
  })
})

describe('relativePath and clip', () => {
  it('makes paths inside the folder relative and leaves the rest alone', () => {
    expect(relativePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativePath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(relativePath('/repository/a.ts', '/repo')).toBe('/repository/a.ts')
    expect(relativePath('C:\\r\\a.ts', 'C:\\r')).toBe('a.ts')
    expect(relativePath('/repo/a.ts', undefined)).toBe('/repo/a.ts')
  })

  it('cuts long text and says so', () => {
    expect(clip('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
    expect(clip('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })
})
