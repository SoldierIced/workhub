import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LocalReviewInput } from '@workhub/adapters/git-review'
import type { HistoryMessage, LocalReview } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import { readForViewer, textPayload } from '../src/main/file-viewer'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { editedPaths, insideRoot, LocalReviewService, opensAsProgram, PENDING_TTL_MS, registerLocalReviewIpc, validComment } from '../src/main/local-review'
import { folderLabel, formatBytes, parseFileHash, parseReviewHash, sessionFiles } from '../src/renderer/lib/localReview'
import type { ChatItem } from '../src/renderer/store'
import { ElsewhereBar } from '../src/renderer/screens/LocalReviewWindow'

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
    expect(service.filePath('s1', '/w/app', 'src/a.ts')).toBe(resolve('/w/app/src/a.ts'))
    expect(service.filePath('s1', '/w/app', '../etc/passwd')).toBeNull()
    expect(insideRoot('/w/app', '/etc/passwd')).toBeNull()
  })

  it('loads the review with the session it belongs to', async () => {
    const { service } = make([view({ state: 'stopped' })], async () => 'delivered')
    expect(await service.load('s1', 'branch')).toMatchObject({ ok: true, session: { id: 's1', blocker: 'closed' }, review: emptyReview })
    expect(await service.load('nope', 'branch')).toEqual({ ok: false, reason: 'unknownSession' })
  })

  it('shows only the files the session edited, or the whole repo', async () => {
    const file = (path: string) => ({ path, status: 'modified' as const, binary: false, additions: 1, deletions: 0, hunks: [], hiddenLines: 0, untracked: false })
    const review: LocalReview = {
      folder: '/w/app',
      scope: 'branch',
      scannedRepos: 2,
      repos: [
        { root: resolve('/w/app'), name: 'app', branch: 'feat/x', files: [file('src/mine.ts'), file('src/theirs.ts'), file('docs/new.md')] },
        { root: resolve('/w/app/lib'), name: 'lib', branch: 'main', files: [file('other.ts')] }
      ]
    }
    const history: HistoryMessage[] = [
      { kind: 'tool', id: 't1', title: 'Edit', view: { kind: 'edit', path: 'src/mine.ts', edits: [] } },
      { kind: 'tool', id: 't2', title: 'Write', view: { kind: 'write', path: '/w/app/docs/new.md', content: '' } },
      { kind: 'tool', id: 't3', title: 'Read', view: { kind: 'read', path: 'src/theirs.ts' } }
    ] as HistoryMessage[]
    const service = new LocalReviewService({
      sessions: { list: () => [view()] },
      deliver: async () => 'delivered',
      changes: { load: vi.fn(async () => review) },
      emit: () => {},
      history: async () => history
    })
    const only = await service.load('s1', 'branch', 'session')
    expect(only).toMatchObject({ ok: true, hiddenFiles: 2 })
    expect(only.ok && only.review.repos.map((r) => [r.name, r.files.map((f) => f.path)])).toEqual([['app', ['src/mine.ts', 'docs/new.md']]])
    // A review a tool asked for shows the whole repo until the switch is used.
    service.request('s1', [{ path: '/w/app', base: 'abc1234' }])
    expect(await service.load('s1', 'branch', 'session', false)).toMatchObject({ ok: true, files: 'repo', review: { repos: review.repos } })
    expect(await service.load('s1', 'branch', 'session', true)).toMatchObject({ ok: true, files: 'session', hiddenFiles: 2 })
    const all = await service.load('s1', 'branch', 'repo')
    expect(all).toMatchObject({ ok: true, review: { repos: review.repos } })
    expect(all.ok && 'hiddenFiles' in all).toBe(false)
  })

  it('names the files the agent wrote or edited, not the ones it read', () => {
    const history = [
      { kind: 'tool', id: 'a', title: 'Edit', view: { kind: 'edit', path: 'a.ts', edits: [] } },
      { kind: 'tool', id: 'b', title: 'Read', view: { kind: 'read', path: 'b.ts' } },
      { kind: 'agent', text: 'done' }
    ] as HistoryMessage[]
    expect([...editedPaths('/w/app', history)]).toEqual([resolve('/w/app/a.ts')])
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

describe('opening a file of the review', () => {
  it('treats programs, scripts, bundles and executable files as things to show, not open', () => {
    for (const path of ['/r/run.command', '/r/Tool.app', '/r/Tool.app/', '/r/x.terminal', '/r/lib.jar', '/r/build.sh', '/r/SETUP.EXE', '/r/link.webloc', '/r/a.desktop']) expect(opensAsProgram(path, {}, 'darwin')).toBe(true)
    expect(opensAsProgram('/r/Tool.app', { isDirectory: true }, 'darwin')).toBe(true)
    expect(opensAsProgram('/r/src', { isDirectory: true, mode: 0o40755 }, 'darwin')).toBe(false)
    expect(opensAsProgram('/r/README.md', { mode: 0o100644 }, 'darwin')).toBe(false)
    expect(opensAsProgram('/r/tool', { mode: 0o100755 }, 'linux')).toBe(true)
    // Windows runs .js with its script host; mode bits mean nothing there.
    expect(opensAsProgram('C:\\r\\index.js', {}, 'win32')).toBe(true)
    expect(opensAsProgram('/r/index.js', { mode: 0o100644 }, 'darwin')).toBe(false)
    expect(opensAsProgram('C:\\r\\notes.txt', { mode: 0o100777 }, 'win32')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('shows a risky file in its folder and opens the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-open-'))
    try {
      writeFileSync(join(dir, 'notes.md'), '# notes')
      writeFileSync(join(dir, 'run.command'), 'echo hi')
      writeFileSync(join(dir, 'tool'), 'echo hi')
      chmodSync(join(dir, 'tool'), 0o755)
      const handlers = new Map<string, (...args: any[]) => unknown>()
      const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l), on: () => undefined }
      const service = { filePath: (_s: string, _r: string, path: string) => join(dir, path) } as unknown as LocalReviewService
      const opened: string[] = []
      const shown: string[] = []
      registerLocalReviewIpc(ipc, service, { openWindow: () => undefined, openPath: async (p) => (opened.push(p), ''), showItemInFolder: (p) => void shown.push(p) })
      const open = (path: string) => handlers.get('localReview:openFile')!({}, 's1', dir, path)
      expect(await open('notes.md')).toBe(true)
      expect(await open('run.command')).toBe(true)
      expect(await open('tool')).toBe(true)
      expect(await open('missing.md')).toBe(false)
      expect(opened).toEqual([join(dir, 'notes.md')])
      expect(shown).toEqual([join(dir, 'run.command'), join(dir, 'tool')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('changes the session made outside the review', () => {
  const repo = (root: string, files = 1) => ({ root, name: root.split('/').pop()!, branch: 'main', base: 'main', files: Array.from({ length: files }, (_, i) => ({ path: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0 })) })
  const touched = (root: string, files: number, additions: number, deletions: number) => ({ name: root.split('/').pop()!, root, branch: 'feat/x', files, additions, deletions })

  function make(touchedRepos: ReturnType<typeof touched>[]) {
    const load = vi.fn(async (input: { extraRepos?: { path: string }[]; alsoRepos?: readonly string[] }) => ({
      folder: '/w/app',
      scope: 'branch' as const,
      repos: [repo('/w/app'), ...(input.extraRepos ?? []).filter((r) => r.path !== '/w/app').map((r) => repo(r.path)), ...(input.alsoRepos ?? []).map((p) => repo(p))],
      scannedRepos: 1
    }) as unknown as LocalReview)
    const service = new LocalReviewService({ sessions: { list: () => [view()] }, deliver: async () => 'delivered', changes: { load }, emit: () => {}, touchedRepos: async () => touchedRepos })
    return { service, load }
  }

  it('lists the repos with changes the session bar counts and the review did not load', async () => {
    const { service } = make([touched('/w/app', 2, 46, 4), touched('/scratch/clone', 108, 7263, 1466), touched('/scratch/clean', 0, 0, 0)])
    const res = await service.load('s1', 'branch')
    expect(res.ok && res.elsewhere).toEqual([{ name: 'clone', root: '/scratch/clone', files: 108, additions: 7263, deletions: 1466 }])
  })

  it('says nothing when every changed repo is in the review', async () => {
    const { service } = make([touched('/w/app', 2, 46, 4)])
    const res = await service.load('s1', 'branch')
    expect(res.ok && res.elsewhere).toBeUndefined()
  })

  it('reviews them next to its own folder once asked, and lists nothing more', async () => {
    const { service, load } = make([touched('/w/app', 2, 46, 4), touched('/scratch/clone', 108, 7263, 1466)])
    await service.load('s1', 'branch')
    service.includeElsewhere('s1')
    const res = await service.load('s1', 'branch')
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ alsoRepos: ['/scratch/clone'] }))
    expect(load.mock.calls.at(-1)![0]).not.toHaveProperty('extraRepos')
    expect(res.ok && res.review.repos.map((r) => r.root)).toEqual(['/w/app', '/scratch/clone'])
    expect(res.ok && res.elsewhere).toBeUndefined()
  })

  it('keeps the scan of a folder that is not a repo when they are added: the session repos stay', async () => {
    const load = vi.fn(async (input: { extraRepos?: { path: string }[]; alsoRepos?: readonly string[] }) => ({
      folder: '/w',
      scope: 'branch' as const,
      // A scan finds the children; extraRepos would replace it (the old bug), alsoRepos joins it.
      repos: input.extraRepos?.length ? input.extraRepos.map((r) => repo(r.path)) : [repo('/w/a'), repo('/w/b'), ...(input.alsoRepos ?? []).map((p) => repo(p))],
      scannedRepos: 2
    }) as unknown as LocalReview)
    const service = new LocalReviewService({ sessions: { list: () => [view({ cwd: '/w' })] }, deliver: async () => 'delivered', changes: { load }, emit: () => {}, touchedRepos: async () => [touched('/scratch/clone', 3, 1, 0)] })
    await service.load('s1', 'branch')
    service.includeElsewhere('s1')
    const res = await service.load('s1', 'branch')
    expect(res.ok && res.review.repos.map((r) => r.root)).toEqual(['/w/a', '/w/b', '/scratch/clone'])
  })
})

describe('the session split of the review', () => {
  const repo = (root: string, names = ['f.ts']) => ({ root, name: root.split('/').pop()!, branch: 'main', base: 'main', files: names.map((path) => ({ path, status: 'modified', additions: 1, deletions: 0 })) })
  const other = (root: string) => ({ name: root.split('/').pop()!, root, files: 2, additions: 5, deletions: 1 })

  function make(opts: { paths?: string[]; asked?: boolean; adapterWhole?: boolean; touchedRepos?: { name: string; root: string; branch: string; files: number; additions: number; deletions: number }[]; history?: HistoryMessage[] } = {}) {
    const load = vi.fn(async (_input: LocalReviewInput) => ({
      folder: '/w',
      scope: 'branch' as const,
      repos: [repo('/w/a', ['f.ts', 'g.ts'])],
      untouched: [other('/w/b')],
      // What the adapter reports: it scanned without the split only when it was asked to and nothing asked resolved.
      ...(opts.adapterWhole ? { wholeFolder: true as const } : {}),
      scannedRepos: 2
    }) as unknown as LocalReview)
    const service = new LocalReviewService({
      sessions: { list: () => [view({ cwd: '/w', startedAt: 500 })] },
      deliver: async () => 'delivered',
      changes: { load },
      emit: () => {},
      changePaths: () => opts.paths,
      touchedRepos: async () => opts.touchedRepos ?? [],
      ...(opts.history ? { history: async () => opts.history! } : {})
    })
    if (opts.asked) service.request('s1', [{ path: '/w/a' }])
    return { service, load }
  }
  const edit = (path: string): HistoryMessage => ({ kind: 'tool', view: { kind: 'edit', path } }) as unknown as HistoryMessage

  it('passes what the session changed, when it reports it, with the start time', async () => {
    const { service, load } = make({ paths: ['/w/a/f.ts'] })
    await service.load('s1', 'branch')
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ touched: ['/w/a/f.ts'], since: 500 }))
    expect(load.mock.calls[0]![0]).not.toHaveProperty('wholeFolder')
    expect(load.mock.calls[0]![0]).not.toHaveProperty('alsoRepos')
  })

  it('passes no touched list when the session has none or reports nothing', async () => {
    for (const paths of [undefined, []]) {
      const { service, load } = make({ paths })
      await service.load('s1', 'branch')
      expect(load.mock.calls[0]![0]).not.toHaveProperty('touched')
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ since: 500 }))
    }
  })

  it('passes wholeFolder when asked, and says so in the answer only as the adapter reports it', async () => {
    const { service, load } = make({ adapterWhole: true })
    const res = await service.load('s1', 'branch', 'repo', true, true)
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ wholeFolder: true }))
    expect(res.ok && res.wholeFolder).toBe(true)
    expect(res.ok && 'wholeFolder' in res.review).toBe(false)
    // The adapter did not scan without the split (nothing asked for it): no whole-folder bar.
    const plain = make()
    const res0 = await plain.service.load('s1', 'branch')
    expect(res0.ok && res0.wholeFolder).toBeUndefined()
    // Repos a tool asked for resolved, so no scan ran: the adapter reports nothing.
    const asked = make({ asked: true })
    const res2 = await asked.service.load('s1', 'branch', 'repo', true, true)
    expect(res2.ok && res2.wholeFolder).toBeUndefined()
    // Repos a tool asked for did not resolve and the folder was scanned whole: the answer says so.
    const unresolved = make({ asked: true, adapterWhole: true })
    const res3 = await unresolved.service.load('s1', 'branch', 'repo', true, true)
    expect(res3.ok && res3.wholeFolder).toBe(true)
  })

  it('answers with the untouched repos, with either file filter, and drops the key when there are none', async () => {
    const { service } = make({ history: [edit('/w/a/f.ts')] })
    const repoRes = await service.load('s1', 'branch', 'repo')
    expect(repoRes.ok && repoRes.untouched).toEqual([other('/w/b')])
    const sessionRes = await service.load('s1', 'branch', 'session')
    expect(sessionRes.ok && sessionRes.files).toBe('session')
    expect(sessionRes.ok && sessionRes.hiddenFiles).toBe(1)
    expect(sessionRes.ok && sessionRes.untouched).toEqual([other('/w/b')])
    expect(sessionRes.ok && 'untouched' in sessionRes.review).toBe(false)
    expect(repoRes.ok && 'untouched' in repoRes.review).toBe(false)
    const none = new LocalReviewService({ sessions: { list: () => [view()] }, deliver: async () => 'delivered', changes: { load: vi.fn(async () => ({ folder: '/w/app', scope: 'branch' as const, repos: [], scannedRepos: 1 }) as LocalReview) }, emit: () => {} })
    const res = await none.load('s1', 'branch')
    expect(res.ok && 'untouched' in res).toBe(false)
  })

  it('opens and reverts files only of the repos listed, never of an untouched one', async () => {
    const revert = vi.fn(async () => ({ ok: true }) as never)
    const { service } = make()
    const withRevert = new LocalReviewService({ sessions: { list: () => [view({ cwd: '/w' })] }, deliver: async () => 'delivered', changes: { load: async () => ({ folder: '/w', scope: 'uncommitted' as const, repos: [repo('/w/a')], untouched: [other('/w/b')], scannedRepos: 2 }) as unknown as LocalReview }, reverter: { revert }, emit: () => {} })
    await service.load('s1', 'branch')
    await withRevert.load('s1', 'uncommitted')
    expect(service.filePath('s1', '/w/a', 'f.ts')).toBe(resolve('/w/a', 'f.ts'))
    expect(service.filePath('s1', '/w/b', 'f.ts')).toBeNull()
    const request = { repoRoot: '/w/b', path: 'f.ts', scope: 'uncommitted', target: { kind: 'file' }, digest: 'd' }
    expect(await withRevert.revert('s1', request)).toEqual({ ok: false, error: 'notReviewed' })
    expect(revert).not.toHaveBeenCalled()
  })

  it('does not list an untouched repo as changed elsewhere too', async () => {
    const t = (root: string) => ({ name: root.split('/').pop()!, root, branch: 'x', files: 2, additions: 5, deletions: 1 })
    const { service } = make({ touchedRepos: [t('/w/a'), t('/w/b'), t('/scratch/clone')] })
    const res = await service.load('s1', 'branch')
    expect(res.ok && res.untouched?.map((r) => r.root)).toEqual(['/w/b'])
    expect(res.ok && res.elsewhere?.map((r) => r.root)).toEqual(['/scratch/clone'])
  })

  it('takes the whole-folder flag over IPC as a fifth argument, only when it is true', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l), on: () => undefined }
    const load = vi.fn(async () => ({ ok: false, reason: 'unknownSession' }))
    registerLocalReviewIpc(ipc, { load } as unknown as LocalReviewService, { openWindow: () => undefined, openPath: async () => '', showItemInFolder: () => undefined })
    await handlers.get('localReview:load')!({}, 's1', 'branch', 'repo', true, true)
    await handlers.get('localReview:load')!({}, 's1', 'branch', 'repo', true, 'yes')
    expect(load).toHaveBeenNthCalledWith(1, 's1', 'branch', 'repo', true, true)
    expect(load).toHaveBeenNthCalledWith(2, 's1', 'branch', 'repo', true, false)
  })
})

describe('the elsewhere bar', () => {
  it('says how many repos, files and lines the review leaves out, names them and offers to add them', () => {
    const html = renderToStaticMarkup(
      createElement(ElsewhereBar, {
        repos: [
          { name: 'clone-a', root: '/scratch/clone-a', files: 3, additions: 1200, deletions: 40 },
          { name: 'clone-b', root: '/scratch/clone-b', files: 2, additions: 10, deletions: 5 }
        ],
        busy: false,
        onInclude: () => {}
      })
    )
    expect(html).toContain('The session also changed 2 repos outside this folder')
    expect(html).toContain('5 files')
    expect(html).toContain('+1,210')
    expect(html).toContain('clone-a, clone-b')
    expect(html).toContain('Review them here too')
  })
})
