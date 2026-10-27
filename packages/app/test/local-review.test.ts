import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LocalReview } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import { readForViewer, textPayload } from '../src/main/file-viewer'
import { insideRoot, LocalReviewService, PENDING_TTL_MS, validComment } from '../src/main/local-review'
import { folderLabel, formatBytes, parseFileHash, parseReviewHash, sessionFiles } from '../src/renderer/lib/localReview'
import type { ChatItem } from '../src/renderer/store'

describe('file viewer reading', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-file-viewer-'))
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]))
    writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(dir, 'doc.pdf'), '%PDF-1.4')
    writeFileSync(join(dir, 'icon.svg'), '<svg/>\n')
    mkdirSync(join(dir, 'sub'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('tells text from binary and counts lines', () => {
    expect(textPayload(new TextEncoder().encode('a\nb'), false)).toEqual({ kind: 'text', text: 'a\nb', truncated: false, lineCount: 2 })
    expect(textPayload(Uint8Array.from([0x61, 0, 0x62]), false)).toEqual({ kind: 'binary' })
  })

  it('drops a multi-byte character the cut split, and shows other encodings with replacement characters', () => {
    const cut = new TextEncoder().encode('añ').subarray(0, 2)
    expect(textPayload(cut, true)).toMatchObject({ text: 'a', truncated: true })
    expect(textPayload(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), false)).toMatchObject({ text: 'caf�' })
  })

  it('reads each kind of path', async () => {
    expect((await readForViewer(join(dir, 'a.ts')))?.content).toEqual({ kind: 'text', text: 'one\ntwo\n', lineCount: 2, truncated: false, size: 8 })
    expect((await readForViewer(join(dir, 'blob.bin')))?.content).toEqual({ kind: 'binary', size: 3 })
    expect((await readForViewer(join(dir, 'pic.png')))?.content).toMatchObject({ kind: 'image', mime: 'image/png', size: 4 })
    expect((await readForViewer(join(dir, 'doc.pdf')))?.content).toMatchObject({ kind: 'pdf', mime: 'application/pdf' })
    expect((await readForViewer(join(dir, 'sub')))?.content).toEqual({ kind: 'folder' })
    expect(await readForViewer(join(dir, 'nope.txt'))).toEqual({ stamp: null, content: { kind: 'missing' } })
    // An image read as text (an SVG the page cannot draw).
    expect((await readForViewer(join(dir, 'icon.svg')))?.content).toMatchObject({ kind: 'image', mime: 'image/svg+xml' })
    expect((await readForViewer(join(dir, 'icon.svg'), null, true))?.content).toMatchObject({ kind: 'text', text: '<svg/>\n' })
  })

  it('skips a file that did not change and reads it again once it does', async () => {
    const path = join(dir, 'live.txt')
    writeFileSync(path, 'v1\n')
    const first = await readForViewer(path)
    expect(await readForViewer(path, { stamp: first!.stamp })).toBeNull()
    writeFileSync(path, 'v2 longer\n')
    expect((await readForViewer(path, { stamp: first!.stamp }))?.content).toMatchObject({ text: 'v2 longer\n' })
    rmSync(path)
    expect((await readForViewer(path, { stamp: first!.stamp }))?.content).toEqual({ kind: 'missing' })
    expect(await readForViewer(path, { stamp: null })).toBeNull()
  })
})

const view = (over: Partial<SessionView> = {}): SessionView => ({ id: 's1', label: 'app', agentName: 'Claude', cwd: '/w/app', state: 'ready', startedAt: 0, profileId: null, ...over }) as SessionView

describe('LocalReviewService', () => {
  const emptyReview: LocalReview = { folder: '/w/app', scope: 'branch', repos: [], scannedRepos: 1 }

  function make(sessions: SessionView[], deliver: (id: string, text: string) => Promise<'delivered' | 'waiting'>) {
    let now = 1_000
    const emitted: unknown[] = []
    const service = new LocalReviewService({
      sessions: { list: () => sessions },
      deliver,
      changes: { load: vi.fn(async () => emptyReview) },
      emit: (id, d) => emitted.push([id, d.state, d.reason]),
      now: () => now
    })
    return { service, emitted, advance: (ms: number) => (now += ms) }
  }

  it('delivers to an idle session at once', async () => {
    const deliver = vi.fn(async () => 'delivered' as const)
    const { service, emitted } = make([view()], deliver)
    expect(await service.send('s1', 'hello')).toMatchObject({ state: 'delivered' })
    expect(deliver).toHaveBeenCalledWith('s1', 'hello')
    expect(emitted).toEqual([['s1', 'delivered', undefined]])
  })

  it('queues while the session works, joins a second message, and delivers both as one', async () => {
    const outcomes: ('delivered' | 'waiting')[] = ['waiting', 'delivered']
    const deliver = vi.fn(async () => outcomes.shift() ?? 'delivered')
    const { service } = make([view({ state: 'busy' })], deliver)
    expect(await service.send('s1', 'first')).toMatchObject({ state: 'queued' })
    expect(await service.send('s1', 'second')).toMatchObject({ state: 'queued' })
    await service.flush()
    expect(deliver).toHaveBeenLastCalledWith('s1', 'first\n\nsecond')
    expect(service.delivery('s1')).toMatchObject({ state: 'delivered' })
    service.stop()
  })

  it('drops a queued message when the session ends or stays busy too long', async () => {
    const sessions = [view({ state: 'busy' })]
    const { service, advance } = make(sessions, async () => 'waiting')
    await service.send('s1', 'x')
    advance(PENDING_TTL_MS + 1)
    await service.flush()
    expect(service.delivery('s1')).toMatchObject({ state: 'dropped', reason: 'busy' })

    await service.send('s1', 'y')
    sessions[0] = view({ state: 'stopped' })
    await service.flush()
    expect(service.delivery('s1')).toMatchObject({ state: 'dropped', reason: 'closed' })
    service.stop()
  })

  it('refuses to send to a closed or reviewer session', async () => {
    const deliver = vi.fn(async () => 'delivered' as const)
    const { service } = make([view({ state: 'stopped' }), view({ id: 'r', readOnly: true })], deliver)
    expect(await service.send('s1', 'x')).toMatchObject({ state: 'dropped', reason: 'closed' })
    expect(await service.send('r', 'x')).toMatchObject({ state: 'dropped' })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('keeps only well-formed comments, and opens files only inside a loaded repo', async () => {
    const { service } = make([view()], async () => 'delivered')
    const good = { id: 'c', repoRoot: '/w/app', repoName: 'app', path: 'a.ts', side: 'new', line: 3, text: 'x', createdAt: 1 }
    service.setComments('s1', [good, { ...good, side: 'left' }, { ...good, line: -1 }, null])
    expect(service.comments('s1')).toEqual([good])
    service.setComments('s1', [])
    expect(service.comments('s1')).toEqual([])
    expect(validComment({ ...good, text: 5 })).toBeNull()

    expect(service.filePath('s1', '/w/app', 'a.ts')).toBeNull()
    ;(service as unknown as { roots: Map<string, Set<string>> }).roots.set('s1', new Set(['/w/app']))
    expect(service.filePath('s1', '/w/app', 'src/a.ts')).toBe('/w/app/src/a.ts')
    expect(service.filePath('s1', '/w/app', '../etc/passwd')).toBeNull()
    expect(insideRoot('/w/app', '/etc/passwd')).toBeNull()
  })

  it('loads the review with the session it belongs to', async () => {
    const { service } = make([view({ state: 'stopped' })], async () => 'delivered')
    expect(await service.load('s1', 'branch')).toMatchObject({ ok: true, session: { id: 's1', blocker: 'closed' }, review: emptyReview })
    expect(await service.load('nope', 'branch')).toEqual({ ok: false, reason: 'unknownSession' })
  })
})

describe('renderer helpers for the review and the viewer', () => {
  it('parse the window hashes', () => {
    expect(parseReviewHash('#review?session=abc%201')).toEqual({ sessionId: 'abc 1' })
    expect(parseReviewHash('#pr?url=x')).toBeNull()
    expect(parseFileHash(`#file?path=${encodeURIComponent('/a b/c.ts')}`)).toEqual({ path: '/a b/c.ts' })
    expect(parseFileHash('#file?')).toBeNull()
  })

  it('list the files of a session from its tool calls', () => {
    const items: ChatItem[] = [
      { id: 1, kind: 'tool', toolCallId: 't1', title: 'Read', status: 'completed', view: { kind: 'read', path: '/w/app/a.ts' } },
      { id: 2, kind: 'tool', toolCallId: 't2', title: 'Edit', status: 'failed', view: { kind: 'edit', path: '/w/app/b.ts', edits: [] } },
      { id: 3, kind: 'tool', toolCallId: 't3', title: 'Write', status: 'completed', view: { kind: 'write', path: '/w/app/src/c.ts', content: '' } },
      { id: 4, kind: 'agent', text: 'done' }
    ]
    expect(sessionFiles(items).map((f) => [f.path, f.kind])).toEqual([
      ['/w/app/src/c.ts', 'wrote'],
      ['/w/app/a.ts', 'read']
    ])
    expect(folderLabel('/w/app/src/c.ts', '/w/app')).toBe('./src')
    expect(folderLabel('/w/app/a.ts', '/w/app/')).toBe('./')
    expect(folderLabel('/tmp/x.png', '/w/app')).toBe('/tmp')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
  })
})
