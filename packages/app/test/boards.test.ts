import { mkdtempSync, rmSync } from 'node:fs'
import { Agent, request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_LIMITS, NO_MODULES, parseBoard, productBoard, type Board, type BoardsState, type ModuleToggles, type StateStore } from '@workhub/core'
import { journalControl } from '../src/main/agent-changes'
import { createBoards, createBoardSaver, BOARDS_FULL, BOARDS_OFF } from '../src/main/boards'
import { registerBoardsIpc } from '../src/main/boards-ipc'
import { ControlTokens } from '../src/main/control-auth'
import { controlSocketPath, startControlServer, startLoopbackControlServer, type ControlDeps } from '../src/main/control-server'
import { saveFlowMap } from '../src/main/flow-maps'
import { openTestDb, storedState } from './test-db'

const NOW = 1_800_000_000_000
const board = (id = 'b1', over: Partial<Board> = {}): Board => {
  const parsed = parseBoard({ format: 'workhub.board', version: 1, id, title: `Board ${id}`, status: 'live', blocks: [{ type: 'text', text: 'hello' }], ...over })
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return parsed.board
}

/** An in-memory StateStore that behaves like `KvState`: `load` hands back what was saved over the fallback. */
function memoryStore(initial?: unknown) {
  let value: unknown = initial
  const calls = { load: 0, save: [] as BoardsState[] }
  const store: StateStore<BoardsState> = {
    load: (fallback) => {
      calls.load++
      return value === undefined ? fallback : ({ ...fallback, ...(value as object) } as BoardsState)
    },
    save: (v) => {
      value = v
      calls.save.push(v)
    },
    flush: () => {}
  }
  return { store, calls }
}

describe('the boards store', () => {
  it('reads a profile once through sanitize and keeps it in memory', () => {
    const { store, calls } = memoryStore({ version: 1, boards: [{ board: board('kept'), receivedAt: NOW, firstReceivedAt: NOW }, { board: { nonsense: true }, receivedAt: NOW, firstReceivedAt: NOW }] })
    const boards = createBoards({ stateFor: () => store, changed: () => {} })
    expect(boards.list('p').map((b) => b.id)).toEqual(['kept'])
    expect(boards.get('p', 'kept')?.board.title).toBe('Board kept')
    boards.list('p')
    boards.get('p', 'nope')
    expect(calls.load).toBe(1)
  })

  it('does not trust a damaged stored value', () => {
    for (const damaged of ['text', 7, { boards: 'x' }, { version: 1 }, null, { boards: [null, 3, { board: 1 }] }]) {
      const { store } = memoryStore(damaged)
      const boards = createBoards({ stateFor: () => store, changed: () => {} })
      expect(boards.list('p')).toEqual([])
    }
    const throwing: StateStore<BoardsState> = { load: () => { throw new Error('closed') }, save: () => {}, flush: () => {} }
    expect(createBoards({ stateFor: () => throwing, changed: () => {} }).list('p')).toEqual([])
  })

  it('saves, replaces and removes, persisting and announcing every change', () => {
    const stores = new Map<string, ReturnType<typeof memoryStore>>()
    const seen: [string, string][] = []
    const boards = createBoards({
      stateFor: (p) => (stores.set(p, stores.get(p) ?? memoryStore()), stores.get(p)!.store),
      changed: (p, id) => seen.push([p, id])
    })
    expect(boards.save('p1', board('a'), 's1', NOW)).toMatchObject({ ok: true, dropped: [] })
    expect(seen).toEqual([['p1', 'a']])
    expect(stores.get('p1')!.calls.save).toHaveLength(1)
    // The same id again replaces it, keeps when it first arrived, and the sender is the last one.
    boards.save('p1', board('a', { title: 'Renamed' }), 's2', NOW + 5000)
    expect(boards.get('p1', 'a')).toMatchObject({ board: { title: 'Renamed' }, firstReceivedAt: NOW, receivedAt: NOW + 5000, sessionId: 's2' })
    expect(boards.list('p1')).toHaveLength(1)
    expect(seen).toHaveLength(2)
    // Boards are per profile.
    expect(boards.list('p2')).toEqual([])
    expect(boards.remove('p2', 'a')).toBe(false)
    expect(boards.remove('p1', 'zzz')).toBe(false)
    expect(seen).toHaveLength(2)
    expect(boards.remove('p1', 'a')).toBe(true)
    expect(seen.at(-1)).toEqual(['p1', 'a'])
    expect(boards.list('p1')).toEqual([])
    expect(stores.get('p1')!.calls.save.at(-1)).toEqual({ version: 1, boards: [] })
  })

  it('refuses a new board when every one is live, and announces what the cap drops', () => {
    const seen: string[] = []
    const { store } = memoryStore()
    const boards = createBoards({ stateFor: () => store, changed: (_p, id) => seen.push(id) })
    for (let i = 0; i < BOARD_LIMITS.boardsPerProfile; i++) boards.save('p', board(`b${i}`), undefined, NOW + i)
    seen.length = 0
    expect(boards.save('p', board('extra'), undefined, NOW + 100)).toEqual({ ok: false, reason: 'full' })
    expect(seen).toEqual([])
    boards.save('p', board('b0', { status: 'finished' }), undefined, NOW + 200)
    seen.length = 0
    expect(boards.save('p', board('extra'), undefined, NOW + 300)).toMatchObject({ ok: true, dropped: [{ board: { id: 'b0' } }] })
    expect(seen).toEqual(['extra', 'b0'])
  })

  it('does not cache a profile whose store could not be created, and refuses to save into it', () => {
    let broken = true
    const { store, calls } = memoryStore()
    const seen: string[] = []
    const boards = createBoards({
      stateFor: () => {
        if (broken) throw new Error('database closed')
        return store
      },
      changed: (_p, id) => seen.push(id)
    })
    expect(boards.list('p')).toEqual([])
    // Nothing can be written: the save fails instead of reporting a board that is not stored.
    expect(() => boards.save('p', board('a'), undefined, NOW)).toThrow('database closed')
    expect(seen).toEqual([])
    expect(boards.get('p', 'a')).toBeNull()
    // The store comes back: the profile was never remembered as empty, so the next call works and persists.
    broken = false
    expect(boards.save('p', board('a'), undefined, NOW)).toMatchObject({ ok: true })
    expect(calls.save).toHaveLength(1)
    expect(boards.list('p').map((b) => b.id)).toEqual(['a'])
    expect(seen).toEqual(['a'])
  })

  it('remembers and announces nothing when persisting throws (the store is written before memory and listeners)', () => {
    // A stand-in whose `save` throws pins the order inside the boards store only. The real `KvState.save` does not
    // throw: a failed write there is logged and stays pending, and the endpoint answers 200.
    let refuse = false
    const { store } = memoryStore()
    const announced: string[] = []
    const refusing: StateStore<BoardsState> = { ...store, save: (v) => (refuse ? (() => { throw new Error('disk full') })() : store.save(v)) }
    const boards = createBoards({ stateFor: () => refusing, changed: (p, id) => announced.push(`${p}:${id}`) })
    boards.save('p', board('a'), undefined, NOW)
    refuse = true
    expect(() => boards.save('p', board('b'), undefined, NOW + 1)).toThrow('disk full')
    expect(() => boards.remove('p', 'a')).toThrow('disk full')
    expect(boards.list('p').map((b) => b.id)).toEqual(['a'])
    expect(announced).toEqual(['p:a'])
  })

  it('persists through the database row of the profile and survives a new store', () => {
    const db = openTestDb()
    const make = () => createBoards({ stateFor: (p) => db.state<BoardsState>('boards:' + p, 5000), changed: () => {} })
    const first = make()
    first.save('demo', productBoard(NOW), undefined, NOW)
    db.flushAll()
    expect(storedState(db, 'boards:demo')).toMatchObject({ version: 1, boards: [{ board: { id: 'release-4-2' }, receivedAt: NOW }] })
    expect(make().list('demo').map((b) => b.id)).toEqual(['release-4-2'])
    expect(make().list('other')).toEqual([])
  })
})

describe('the boards IPC', () => {
  function setup(on: boolean) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const { store } = memoryStore()
    const boards = createBoards({ stateFor: () => store, changed: () => {} })
    boards.save('p', board('a'), undefined, NOW)
    registerBoardsIpc({ handle: (c, l) => void handlers.set(c, (...a) => l({} as never, ...a)), on: () => undefined }, { boards, enabled: async (p) => on && p === 'p' })
    return (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args) as Promise<unknown>
  }

  it('lists, reads and removes while the screen is on', async () => {
    const call = setup(true)
    expect(await call('boards:list', 'p')).toMatchObject([{ id: 'a', title: 'Board a' }])
    expect(await call('boards:get', 'p', 'a')).toMatchObject({ board: { id: 'a' } })
    expect(await call('boards:get', 'p', 'zzz')).toBeNull()
    expect(await call('boards:remove', 'p', 'zzz')).toBe(false)
    expect(await call('boards:remove', 'p', 'a')).toBe(true)
    expect(await call('boards:list', 'p')).toEqual([])
  })

  it('offers no way to jump to a screen of boards: they show in their chat', () => {
    const channels: string[] = []
    const { store } = memoryStore()
    registerBoardsIpc({ handle: (c) => void channels.push(c), on: () => undefined }, { boards: createBoards({ stateFor: () => store, changed: () => {} }), enabled: async () => true })
    expect(channels.sort()).toEqual(['boards:get', 'boards:list', 'boards:remove'])
  })

  it('hides the boards while the screen is off, without deleting them', async () => {
    const call = setup(false)
    expect(await call('boards:list', 'p')).toEqual([])
    expect(await call('boards:get', 'p', 'a')).toBeNull()
    expect(await call('boards:remove', 'p', 'a')).toBe(false)
  })

  it('refuses arguments that are not ids', async () => {
    const call = setup(true)
    for (const bad of [undefined, null, 5, '', {}, ['p'], 'x'.repeat(201)]) {
      expect(await call('boards:list', bad)).toEqual([])
      expect(await call('boards:get', bad, 'a')).toBeNull()
      expect(await call('boards:get', 'p', bad)).toBeNull()
      expect(await call('boards:remove', bad, 'a')).toBe(false)
      expect(await call('boards:remove', 'p', bad)).toBe(false)
    }
    expect(await call('boards:list', 'p')).toHaveLength(1)
  })
})

describe('POST /v1/boards', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const on: ModuleToggles = { ...NO_MODULES, boards: true }
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'wh-boards-'))
    dirs.push(dir)
    const socket = controlSocketPath(dir)
    const tokens = new ControlTokens()
    const sessions = [
      { id: 'sa', profileId: 'pa', readOnly: false },
      { id: 'sb', profileId: 'pb', readOnly: false },
      { id: 'sr', profileId: 'pa', readOnly: true },
      { id: 'sgone', profileId: 'deleted', readOnly: false },
      { id: 'snone', profileId: undefined as string | undefined, readOnly: false }
    ]
    const token = Object.fromEntries(sessions.map((s) => [s.id, tokens.mint(s.id)]))
    const modules: Record<string, ModuleToggles> = { pa: on, pb: { ...on, boards: false } }
    const stores = new Map<string, StateStore<BoardsState>>()
    const seen: string[] = []
    const fault = { stores: false }
    const boards = createBoards({
      stateFor: (p) => (fault.stores ? (() => { throw new Error('database closed') })() : stores.set(p, stores.get(p) ?? memoryStore().store), stores.get(p)!),
      changed: (p, id) => seen.push(`${p}:${id}`)
    })
    const saveBoard = createBoardSaver({
      sessionProfile: (id) => sessions.find((s) => s.id === id)?.profileId,
      sessionReadOnly: (id) => sessions.find((s) => s.id === id)?.readOnly === true,
      profiles: async () => ({ ids: Object.keys(modules), active: 'pa' }),
      boards,
      modules: async (p) => modules[p],
      // Session sa is chat "chat-a"; a session that does not run has no chat.
      chatOf: (id) => (id === 'sa' || id === 'sa2' ? 'chat-a' : id === 'sb' ? 'chat-b' : undefined),
      now: () => NOW
    })
    const flowMapRows: Record<string, string> = {}
    const deps: ControlDeps = {
      auth: tokens.auth(() => sessions),
      openReview: () => ({ ok: true }),
      saveFlowMap: (m) => saveFlowMap({ list: () => [], get: (id) => flowMapRows[id] ?? null, put: (id, j) => void (flowMapRows[id] = j), remove: () => false }, m),
      saveBoard
    }
    const server = await startControlServer(socket, deps)
    expect(server).not.toBeNull()
    const call = (path: string, body: unknown, tok?: string, method = 'POST') =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method, path, headers: { 'content-type': 'application/json', ...(tok ? { 'x-workhub-token': tok } : {}) } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }))
        })
        req.on('error', reject)
        req.end(typeof body === 'string' ? body : JSON.stringify(body))
      })
    return {
      call,
      token,
      boards,
      seen,
      deps,
      fault,
      socket,
      server: server!,
      close: () => new Promise((r) => server!.close(r))
    }
  }

  it('stores a board for the session profile (a real minted token) and announces it', async () => {
    const t = await setup()
    try {
      const ok = await t.call('/v1/boards', board('rel'), t.token['sa'])
      expect(ok).toEqual({ status: 200, json: { ok: true, id: 'rel', dropped: [] } })
      expect(t.boards.get('pa', 'chat-a/rel')).toMatchObject({ sessionId: 'sa', chat: 'chat-a', receivedAt: NOW })
      expect(t.seen).toEqual(['pa:chat-a/rel'])
      // The session in the body is never read: a board naming one is just an unknown key of the strict parser.
      const strict = await t.call('/v1/boards', { ...board('rel'), session: 'sb' }, t.token['sa'])
      expect(strict.status).toBe(400)
    } finally {
      await t.close()
    }
  })

  it('answers 500, not 200, when the profile store cannot be had, and works again once it can', async () => {
    const t = await setup()
    try {
      t.fault.stores = true
      const failed = await t.call('/v1/boards', board('rel'), t.token['sa'])
      expect(failed.status).toBe(500)
      expect(failed.json['ok']).toBe(false)
      expect(t.seen).toEqual([])
      t.fault.stores = false
      expect((await t.call('/v1/boards', board('rel'), t.token['sa'])).status).toBe(200)
      expect(t.boards.get('pa', 'chat-a/rel')).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it('keeps the same id of two chats apart and tells a tool only of its own chat\'s dropped boards', async () => {
    const { store } = memoryStore()
    const boards = createBoards({ stateFor: () => store, changed: () => {} })
    const chats: Record<string, string> = { s1: 'chat-1', s2: 'chat-2' }
    const save = createBoardSaver({ sessionProfile: () => 'p', sessionReadOnly: () => false, profiles: async () => ({ ids: ['p'], active: 'p' }), boards, modules: async () => on, chatOf: (s) => chats[s], now: () => NOW })
    await save(board('rel'), { session: 's1' } as never)
    await save(board('rel', { title: 'Other' }), { session: 's2' } as never)
    expect(boards.list('p').map((b) => b.key).sort()).toEqual(['chat-1/rel', 'chat-2/rel'])
    // Fill the cap with finished boards of chat 2, then a new board of chat 1 pushes one out.
    for (let i = 0; i < BOARD_LIMITS.boardsPerProfile - 2; i++) await save(board(`f${i}`, { status: 'finished' }), { session: 's2' } as never)
    const r = await save(board('new'), { session: 's1' } as never)
    expect(r).toEqual({ ok: true, id: 'new', dropped: [] })
    expect(boards.list('p').some((b) => b.key === 'chat-2/f0')).toBe(false)
  })

  it('answers 401 without a token and 403 to a reviewer', async () => {
    const t = await setup()
    try {
      expect((await t.call('/v1/boards', board())).status).toBe(401)
      expect((await t.call('/v1/boards', board(), 'not-a-token')).status).toBe(401)
      expect((await t.call('/v1/boards', board(), t.token['sr'])).status).toBe(403)
      expect(t.boards.list('pa')).toEqual([])
      expect((await t.call('/v1/boards', {}, t.token['sa'], 'GET')).status).toBe(405)
    } finally {
      await t.close()
    }
  })

  it('answers 409 with where to turn it on when the module is off, storing and announcing nothing', async () => {
    const t = await setup()
    try {
      const off = await t.call('/v1/boards', board(), t.token['sb'])
      expect(off).toEqual({ status: 409, json: { ok: false, error: BOARDS_OFF } })
      expect(off.json['error']).toBe('Live boards is off for this profile: the user turns it on in Settings → Profiles → Screens')
      expect(t.boards.list('pb')).toEqual([])
      expect(t.seen).toEqual([])
    } finally {
      await t.close()
    }
  })

  it('answers 409 with another text when the profile shows 12 live boards', async () => {
    const t = await setup()
    try {
      for (let i = 0; i < BOARD_LIMITS.boardsPerProfile; i++) expect((await t.call('/v1/boards', board(`b${i}`), t.token['sa'])).status).toBe(200)
      const full = await t.call('/v1/boards', board('one-more'), t.token['sa'])
      expect(full.status).toBe(409)
      expect(full.json['error']).toBe(BOARDS_FULL)
      expect(full.json['error']).not.toBe(BOARDS_OFF)
      expect(full.json['error']).toMatch(/12 live boards/)
      expect(t.boards.get('pa', 'chat-a/one-more')).toBeNull()
      // A board already there can still be updated.
      expect((await t.call('/v1/boards', board('b3', { title: 'Again' }), t.token['sa'])).status).toBe(200)
    } finally {
      await t.close()
    }
  })

  it('answers 400 naming the fields of a document that does not parse', async () => {
    const t = await setup()
    try {
      const bad = await t.call('/v1/boards', { ...board(), status: 'running', blocks: [{ type: 'graph', nodes: [] }] }, t.token['sa'])
      expect(bad.status).toBe(400)
      const errors = bad.json['errors'] as string[]
      expect(errors.some((e) => e.startsWith('status'))).toBe(true)
      expect(errors.some((e) => e.startsWith('blocks[0]'))).toBe(true)
      expect(bad.json['error']).toBe(errors.join('; '))
      expect((await t.call('/v1/boards', 'not json', t.token['sa'])).status).toBe(400)
      expect(t.boards.list('pa')).toEqual([])
    } finally {
      await t.close()
    }
  })

  it('answers 404 for a session whose profile was deleted, never 409 "no profile"', async () => {
    const t = await setup()
    try {
      const gone = await t.call('/v1/boards', board(), t.token['sgone'])
      expect(gone.status).toBe(404)
      // A session with no profile to act on is a 404 too.
      expect((await t.call('/v1/boards', board('x'), t.token['snone'])).status).toBe(404)
      expect(t.boards.list('deleted')).toEqual([])
    } finally {
      await t.close()
    }
  })

  /** A client that swallows nothing: any error on the request or its socket fails the call, and so does a missing answer. */
  const strictClient = (target: { socketPath: string } | { host: string; port: number; auth: string }, token: string, agent?: Agent) =>
    (path: string, body: Buffer | string) =>
      new Promise<{ status: number; json: Record<string, unknown>; socket: unknown; headers: IncomingHttpHeaders }>((resolve, reject) => {
        const headers = { 'content-type': 'application/json', 'x-workhub-token': token, ...('auth' in target ? { authorization: `Bearer ${target.auth}` } : {}) }
        const options = 'socketPath' in target ? { socketPath: target.socketPath } : { host: target.host, port: target.port }
        const req = request({ ...options, method: 'POST', path, headers, agent }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown>, socket: req.socket, headers: res.headers }))
        })
        req.on('socket', (s) => s.on('error', reject))
        req.on('error', reject)
        req.end(body)
      })
  const connections = (server: { getConnections: (cb: (e: Error | null, n: number) => void) => void }) => new Promise<number>((r) => server.getConnections((_e, n) => r(n)))
  const BOARD_413 = { ok: false, error: 'the board is over 256 KB: shorten the log or the tables' }

  it.each(['unix', 'loopback'] as const)('answers 413 with its text to a 1 MB upload over %s, and the same connection serves the next request', async (transport) => {
    const t = await setup()
    const loop = transport === 'loopback' ? await startLoopbackControlServer('launch', t.deps) : null
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const target = loop ? { host: '127.0.0.1', port: Number(new URL(loop.url).port), auth: 'launch' } : { socketPath: t.socket }
      const call = strictClient(target, t.token['sa']!, agent)
      const big = JSON.stringify({ ...board(), subtitle: 'x'.repeat(1024 * 1024) })
      const over = await call('/v1/boards', big)
      expect(over.status).toBe(413)
      expect(over.json).toEqual(BOARD_413)
      expect(over.headers['connection']).not.toBe('close')
      // Under the discard cap the request was read to its end: nothing closed, so keep-alive carries the next one.
      const next = await call('/v1/boards', JSON.stringify(board('rel')))
      expect(next.status).toBe(200)
      expect(next.socket).toBe(over.socket)
      expect(await connections(loop?.server ?? t.server)).toBe(1)
      expect(t.boards.list('pa').map((b) => b.id)).toEqual(['rel'])
    } finally {
      agent.destroy()
      await new Promise((r) => (loop ? loop.server.close(r) : r(undefined)))
      await t.close()
    }
  })

  it('answers 400 "body too large" to a 1 MB upload on /v1/flow-maps and keeps the connection usable', async () => {
    const t = await setup()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const call = strictClient({ socketPath: t.socket }, t.token['sa']!, agent)
      const flow = await call('/v1/flow-maps', JSON.stringify({ ...board(), subtitle: 'x'.repeat(1024 * 1024) }))
      expect({ status: flow.status, json: flow.json }).toEqual({ status: 400, json: { ok: false, error: 'body too large' } })
      const next = await call('/v1/boards', JSON.stringify(board('rel')))
      expect(next.status).toBe(200)
      expect(next.socket).toBe(flow.socket)
    } finally {
      agent.destroy()
      await t.close()
    }
  })

  it.each(['unix', 'loopback'] as const)('closes the connection of an upload past the discard cap over %s and holds none open afterwards', async (transport) => {
    const t = await setup()
    const loop = transport === 'loopback' ? await startLoopbackControlServer('launch', t.deps) : null
    const server = loop?.server ?? t.server
    try {
      const chunk = Buffer.alloc(256 * 1024, 120)
      const offered = 256 * chunk.length // 64 MB, never finished
      for (const path of ['/v1/boards', '/v1/flow-maps']) {
        const seen = await new Promise<{ status?: number; text: string; sent: number }>((resolve) => {
          let sent = 0
          let stop = false
          let status: number | undefined
          let text = ''
          const options = loop ? { host: '127.0.0.1', port: Number(new URL(loop.url).port) } : { socketPath: t.socket }
          const req = request({ ...options, method: 'POST', path, headers: { 'content-type': 'application/json', 'x-workhub-token': t.token['sa']!, ...(loop ? { authorization: 'Bearer launch' } : {}) } }, (res) => {
            status = res.statusCode
            res.on('data', (c) => (text += c))
          })
          // The client may get the answer or a reset: both are allowed here, only the app's own limits are checked.
          req.on('error', () => { stop = true })
          req.on('socket', (s) => s.on('error', () => { stop = true }))
          req.on('close', () => { stop = true; resolve({ status, text, sent }) })
          const pump = () => {
            while (!stop && sent < offered) {
              sent += chunk.length
              if (!req.write(chunk)) return void req.once('drain', pump)
            }
            if (!stop) req.end()
          }
          pump()
        })
        if (seen.status !== undefined) expect(seen.status).toBe(path === '/v1/boards' ? 413 : 400)
        // The app stopped reading near the cap: the client was not allowed to push the whole upload.
        expect(seen.sent).toBeLessThan(offered)
        await vi.waitFor(async () => expect(await connections(server)).toBe(0), { timeout: 4000, interval: 50 })
      }
    } finally {
      await new Promise((r) => (loop ? loop.server.close(r) : r(undefined)))
      await t.close()
    }
  })

  it('is not recorded as an agent change: the journal leaves the route as it is', () => {
    const recorded: unknown[] = []
    const saveBoard: NonNullable<ControlDeps['saveBoard']> = async () => ({ ok: true, id: 'x', dropped: [] })
    const wrapped = journalControl({ auth: { sessionOf: () => undefined, readOnly: () => false }, openReview: () => ({ ok: true }), saveBoard }, { journal: { record: (c: unknown) => void recorded.push(c) } as never, targets: {} as never })
    expect(wrapped.saveBoard).toBe(saveBoard)
    expect(recorded).toEqual([])
  })
})
