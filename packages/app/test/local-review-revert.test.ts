import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LocalReview, LocalRevertAnswer } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { LocalReviewService, registerLocalReviewIpc, validRevertRequest } from '../src/main/local-review'
import { REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'
import { canRevertFile, canRevertHunks, selectedRevertLines } from '../src/renderer/lib/localReview'

const root = resolve('/w/app')
const view = (over: Partial<SessionView> = {}): SessionView => ({ id: 's1', label: 'app', agentName: 'Claude', cwd: root, state: 'ready', startedAt: 0, profileId: null, ...over }) as SessionView
const review: LocalReview = {
  folder: root,
  scope: 'uncommitted',
  repos: [{ root, name: 'app', branch: 'main', files: [{ path: 'src/a.ts', status: 'modified', binary: false, additions: 1, deletions: 0, hunks: [], hiddenLines: 0, untracked: false, digest: 'd1' }] }],
  scannedRepos: 1
}
const request = (over: Record<string, unknown> = {}) => ({ repoRoot: root, path: 'src/a.ts', scope: 'uncommitted', target: { kind: 'hunk', hunk: 0 }, digest: 'd1', ...over })

function make(revert: (input: unknown) => Promise<LocalRevertAnswer> = async () => ({ ok: true }), withReverter = true) {
  const reverter = { revert: vi.fn(revert) }
  const service = new LocalReviewService({
    sessions: { list: () => [view()] },
    deliver: async () => 'delivered',
    changes: { load: vi.fn(async () => review) },
    emit: () => {},
    ...(withReverter ? { reverter } : {})
  })
  return { service, reverter }
}

describe('LocalReviewService.revert', () => {
  it('reverts a file of a loaded repo through the reverter, with what the window sent', async () => {
    const { service, reverter } = make()
    await service.load('s1', 'uncommitted')
    expect(await service.revert('s1', request({ target: { kind: 'lines', hunk: 1, lines: [4, 2] } }))).toEqual({ ok: true })
    expect(reverter.revert).toHaveBeenCalledWith({ root, path: 'src/a.ts', target: { kind: 'lines', hunk: 1, lines: [2, 4] }, digest: 'd1' })
  })

  it('passes `changed` and other refusals of the reverter through', async () => {
    const { service } = make(async () => ({ ok: false, error: 'changed' }))
    await service.load('s1', 'uncommitted')
    expect(await service.revert('s1', request())).toEqual({ ok: false, error: 'changed' })
  })

  it('refuses before touching git: unknown session, bad request, branch scope, no reverter, a repo or path the review did not load', async () => {
    const { service, reverter } = make()
    expect(await service.revert('nope', request())).toEqual({ ok: false, error: 'unknownSession' })
    // Nothing loaded yet: the repo is not one this session's review showed.
    expect(await service.revert('s1', request())).toEqual({ ok: false, error: 'notReviewed' })
    await service.load('s1', 'uncommitted')
    expect(await service.revert('s1', request({ scope: 'branch' }))).toEqual({ ok: false, error: 'scope' })
    expect(await service.revert('s1', request({ repoRoot: resolve('/w/other') }))).toEqual({ ok: false, error: 'notReviewed' })
    for (const path of ['../outside.ts', '/etc/hosts', resolve('/w/app/src/a.ts')]) expect(await service.revert('s1', request({ path }))).toEqual({ ok: false, error: 'notReviewed' })
    for (const bad of [null, 'x', request({ digest: '' }), request({ target: { kind: 'patch', text: '+x' } }), request({ path: 7 }), request({ scope: 'all' })]) {
      expect(await service.revert('s1', bad)).toMatchObject({ ok: false, error: 'failed' })
    }
    expect(reverter.revert).not.toHaveBeenCalled()
    const none = make(undefined, false)
    await none.service.load('s1', 'uncommitted')
    expect(await none.service.revert('s1', request())).toEqual({ ok: false, error: 'unsupported' })
  })

  it('runs reverts in one repo one after the other, and turns a thrown error into `failed`', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const first = new Promise<void>((r) => (release = r))
    const { service } = make(async (input) => {
      const { digest } = input as { digest: string }
      order.push(`start ${digest}`)
      if (digest === 'a') await first
      if (digest === 'boom') throw new Error('disk full')
      order.push(`end ${digest}`)
      return { ok: true }
    })
    await service.load('s1', 'uncommitted')
    const a = service.revert('s1', request({ digest: 'a' }))
    const b = service.revert('s1', request({ digest: 'b' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['start a'])
    release()
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
    expect(await service.revert('s1', request({ digest: 'boom' }))).toEqual({ ok: false, error: 'failed', detail: 'disk full' })
  })

  it('is reachable over IPC as localReview:revert, and never from a paired device', async () => {
    const { service, reverter } = make()
    await service.load('s1', 'uncommitted')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc: IpcRegistrar = { handle: (c, fn) => void handlers.set(c, fn as (...args: unknown[]) => unknown), on: () => undefined }
    registerLocalReviewIpc(ipc, service, { openWindow: () => undefined, openPath: async () => '', showItemInFolder: () => undefined })
    expect(await handlers.get('localReview:revert')!({}, 's1', request())).toEqual({ ok: true })
    expect(reverter.revert).toHaveBeenCalledTimes(1)
    expect([...Object.keys(REMOTE_INVOKES), ...Object.keys(REMOTE_MESSAGES)].filter((c) => c.startsWith('localReview:'))).toEqual([])
  })
})

describe('validRevertRequest', () => {
  it('keeps only the fields main needs, never patch text', () => {
    expect(validRevertRequest({ ...request(), patch: '+evil' })).toEqual({ repoRoot: root, path: 'src/a.ts', scope: 'uncommitted', target: { kind: 'hunk', hunk: 0 }, digest: 'd1' })
    expect(validRevertRequest(request({ digest: 'x'.repeat(201) }))).toBeNull()
  })
})

describe('revert controls in the review window', () => {
  it('offers a revert only for uncommitted files with a digest, and hunks only for tracked text files that exist', () => {
    const file = { digest: 'd', untracked: false, binary: false, status: 'modified' }
    expect(canRevertFile('uncommitted', file)).toBe(true)
    expect(canRevertFile('branch', file)).toBe(false)
    expect(canRevertFile('uncommitted', { ...file, digest: undefined })).toBe(false)
    expect(canRevertHunks('uncommitted', file)).toBe(true)
    expect(canRevertHunks('uncommitted', { ...file, untracked: true })).toBe(false)
    expect(canRevertHunks('uncommitted', { ...file, binary: true })).toBe(false)
    expect(canRevertHunks('uncommitted', { ...file, status: 'deleted' })).toBe(false)
  })

  it('reads the changed lines of one hunk out of a text selection', () => {
    expect(selectedRevertLines([])).toBeNull()
    expect(selectedRevertLines([{ hunk: 0, line: 0, kind: 'context' }])).toBeNull()
    expect(
      selectedRevertLines([
        { hunk: 1, line: 0, kind: 'context' },
        { hunk: 1, line: 3, kind: 'added' },
        { hunk: 1, line: 1, kind: 'removed' },
        { hunk: 1, line: 3, kind: 'added' }
      ])
    ).toEqual({ hunk: 1, lines: [1, 3] })
    // Across hunks: nothing (each hunk reverts on its own).
    expect(selectedRevertLines([{ hunk: 0, line: 1, kind: 'added' }, { hunk: 1, line: 0, kind: 'added' }])).toBeNull()
    // Context of another hunk does not count.
    expect(selectedRevertLines([{ hunk: 0, line: 1, kind: 'added' }, { hunk: 1, line: 0, kind: 'context' }])).toEqual({ hunk: 0, lines: [1] })
  })
})

describe('LocalReviewService: a session in WSL', () => {
  const wslRoot = '/home/ana/acme'
  const wslReview: LocalReview = { ...review, folder: wslRoot, repos: [{ ...review.repos[0]!, root: wslRoot }] }

  function makeOnHost(connected = true) {
    const local = { load: vi.fn(async () => review) }
    const host = { changes: { load: vi.fn(async () => wslReview) }, realpath: vi.fn(async (p: string) => p) }
    const reverter = { revert: vi.fn(async (): Promise<LocalRevertAnswer> => ({ ok: true })) }
    const service = new LocalReviewService({
      sessions: { list: () => [view({ cwd: wslRoot, hostId: 'wsl:Ubuntu' })] },
      deliver: async () => 'delivered',
      changes: local,
      reverter,
      hostOf: () => (connected ? host : null),
      emit: () => {}
    })
    return { service, local, host, reverter }
  }

  it("reads the session's changes with its host's git, never this computer's", async () => {
    const { service, local, host } = makeOnHost()
    const loaded = await service.load('s1', 'uncommitted')
    expect(loaded).toMatchObject({ ok: true, review: { folder: wslRoot } })
    expect(host.changes.load).toHaveBeenCalledWith(expect.objectContaining({ folder: wslRoot }))
    expect(local.load).not.toHaveBeenCalled()
  })

  it('says the host is not connected instead of reading this computer', async () => {
    const { service, local } = makeOnHost(false)
    expect(await service.load('s1', 'uncommitted')).toMatchObject({ ok: false, reason: 'failed' })
    expect(local.load).not.toHaveBeenCalled()
  })

  it("opens files of the host's repo by its POSIX path, on any computer", async () => {
    const { service } = makeOnHost()
    await service.load('s1', 'uncommitted')
    expect(service.filePath('s1', wslRoot, 'src/a.ts')).toBe('/home/ana/acme/src/a.ts')
    expect(service.filePath('s1', wslRoot, '../etc/passwd')).toBeNull()
  })

  it('refuses to revert there, and touches nothing', async () => {
    const { service, reverter } = makeOnHost()
    await service.load('s1', 'uncommitted')
    expect(await service.revert('s1', request({ repoRoot: wslRoot }))).toEqual({ ok: false, error: 'otherHost' })
    expect(reverter.revert).not.toHaveBeenCalled()
  })
})
