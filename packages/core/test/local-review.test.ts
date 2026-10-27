import { describe, expect, it } from 'vitest'
import {
  absoluteFilePath,
  branchLine,
  commentAnchor,
  commentCounts,
  commentLocation,
  fileKey,
  fileKindOfPath,
  fileTouchOf,
  filterFiles,
  githubPageFor,
  isCommentOn,
  lineCount,
  mimeOfPath,
  parseRemote,
  removeComment,
  reviewMessage,
  summarizeTouches,
  upsertComment,
  type ReviewComment
} from '../src'

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: over.id ?? Math.random().toString(36),
  repoRoot: '/w/app',
  repoName: 'app',
  path: 'src/a.ts',
  side: 'new',
  line: 1,
  text: 'fix',
  createdAt: 0,
  ...over
})

describe('review comments', () => {
  it('anchor on the new line, or the old one for a removed line', () => {
    expect(commentAnchor({ oldNumber: 3, newNumber: 4 })).toEqual({ side: 'new', line: 4 })
    expect(commentAnchor({ oldNumber: 3 })).toEqual({ side: 'old', line: 3 })
    expect(commentAnchor({})).toBeNull()
    expect(isCommentOn({ side: 'old', line: 3 }, { oldNumber: 3 })).toBe(true)
    expect(isCommentOn({ side: 'new', line: 3 }, { oldNumber: 3 })).toBe(false)
  })

  it('say where they are, marking removed lines', () => {
    expect(commentLocation({ path: 'a.ts', side: 'new', line: 44 })).toBe('a.ts:44')
    expect(commentLocation({ path: 'a.ts', side: 'old', line: 40 })).toBe('a.ts:40 (removed line)')
  })

  it('build one message grouped by repo, files and lines in order, multi-line text indented', () => {
    const msg = reviewMessage([
      comment({ repoName: 'cash-out', repoRoot: '/w/c', path: 'src/B.cs', line: 9, text: 'second file' }),
      comment({ repoName: 'cash-out', repoRoot: '/w/c', path: 'src/A.cs', line: 44, text: ' rename this\nand that ' }),
      comment({ repoName: 'web', repoRoot: '/w/web', path: 'x.ts', side: 'old', line: 2, text: 'why removed?' }),
      comment({ repoName: 'cash-out', repoRoot: '/w/c', path: 'src/A.cs', line: 3, text: 'first' })
    ])
    expect(msg).toBe(
      [
        'Review comments on cash-out:',
        '1. src/A.cs:3 — first',
        '2. src/A.cs:44 — rename this\n   and that',
        '3. src/B.cs:9 — second file',
        '',
        'Review comments on web:',
        '1. x.ts:2 (removed line) — why removed?'
      ].join('\n')
    )
  })

  it('are added, edited, removed and counted per file', () => {
    let list = upsertComment([], comment({ id: 'a' }))
    list = upsertComment(list, comment({ id: 'b', path: 'src/b.ts' }))
    list = upsertComment(list, comment({ id: 'a', text: 'edited' }))
    expect(list.map((c) => [c.id, c.text])).toEqual([
      ['a', 'edited'],
      ['b', 'fix']
    ])
    expect(commentCounts(list).get(fileKey('/w/app', 'src/a.ts'))).toBe(1)
    // A blank edit removes the comment.
    list = upsertComment(list, comment({ id: 'b', text: '   ' }))
    expect(list.map((c) => c.id)).toEqual(['a'])
    expect(removeComment(list, 'a')).toEqual([])
  })
})

describe('local review helpers', () => {
  it('show the branch and its base', () => {
    expect(branchLine({ branch: 'feat/qr', base: 'origin/develop' })).toBe('feat/qr → develop')
    expect(branchLine({ branch: null })).toBe('detached HEAD')
  })

  it('filter files case-insensitively', () => {
    const files = [{ path: 'src/App.ts' }, { path: 'README.md' }]
    expect(filterFiles(files, ' app ')).toEqual([{ path: 'src/App.ts' }])
    expect(filterFiles(files, '')).toHaveLength(2)
  })

  it('read GitHub remotes and build a page for the branch', () => {
    expect(parseRemote('git@github.com:acme/web.git')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
    expect(parseRemote('https://github.com/acme/web')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
    expect(parseRemote('ssh://git@gitlab.example.com:2222/g/sub/p.git')).toEqual({ host: 'gitlab.example.com', owner: 'g/sub', repo: 'p' })
    expect(githubPageFor('git@github.com:acme/web.git', 'feat/x', 'origin/main')).toBe('https://github.com/acme/web/compare/main...feat/x')
    expect(githubPageFor('git@github.com:acme/web.git', 'main', 'origin/main')).toBe('https://github.com/acme/web/tree/main')
    expect(githubPageFor('git@gitlab.com:acme/web.git', 'main')).toBeNull()
  })
})

describe('file kinds and paths', () => {
  it('detect images and PDFs by extension', () => {
    expect(fileKindOfPath('/a/b/Shot.PNG')).toBe('image')
    expect(fileKindOfPath('doc.pdf')).toBe('pdf')
    expect(fileKindOfPath('main.ts')).toBe('other')
    expect(fileKindOfPath('.png')).toBe('other')
    expect(mimeOfPath('x.svg')).toBe('image/svg+xml')
    expect(mimeOfPath('x.ts')).toBeNull()
  })

  it('resolve relative, home and dotted paths', () => {
    expect(absoluteFilePath('src/../lib/a.ts', '/w/app', '/home/me')).toBe('/w/app/lib/a.ts')
    expect(absoluteFilePath('~/notes.md', '/w/app', '/home/me')).toBe('/home/me/notes.md')
    expect(absoluteFilePath('/etc/./hosts', '/w', '/h')).toBe('/etc/hosts')
    expect(absoluteFilePath('src\\a.ts', 'C:\\w\\app', 'C:\\Users\\me')).toBe('C:\\w\\app\\src\\a.ts')
  })

  it('count lines without the final newline', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\n\nb')).toBe(3)
  })
})

describe('session files', () => {
  it('take the file of edits, writes and reads only', () => {
    expect(fileTouchOf({ kind: 'edit', path: '/a', edits: [] })).toEqual({ kind: 'edited', path: '/a' })
    expect(fileTouchOf({ kind: 'write', path: '/b', content: '' })).toEqual({ kind: 'wrote', path: '/b' })
    expect(fileTouchOf({ kind: 'read', path: '/c' })).toEqual({ kind: 'read', path: '/c' })
    expect(fileTouchOf({ kind: 'command', command: 'ls' })).toBeNull()
  })

  it('list every file once, most recent first; an edited file stays edited and keeps its place', () => {
    const files = summarizeTouches([
      { kind: 'read', path: '/a', failed: false, at: 1 },
      { kind: 'edited', path: '/a', failed: false, at: 2 },
      { kind: 'read', path: '/b', failed: false, at: 3 },
      { kind: 'wrote', path: '/c', failed: true, at: 4 },
      { kind: 'read', path: '/a', failed: false, at: 5 }
    ])
    expect(files).toEqual([
      { path: '/b', kind: 'read', at: 3, edited: false },
      { path: '/a', kind: 'edited', at: 2, edited: true }
    ])
  })
})
